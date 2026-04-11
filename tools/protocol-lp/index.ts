/**
 * tools/protocol-lp/index.ts
 *
 * Protocol LP Automation — harvest sell-side rips, redeploy as BidAsk buy support.
 *
 * Usage:
 *   npm run protocol-lp
 *   DRY_RUN=false npm run protocol-lp
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { Connection, LAMPORTS_PER_SOL } = _require('@solana/web3.js');

import { CONFIG } from './config';
import { loadState } from './state';
import { startHealthServer, updateHealthData } from './health';
import {
  createPool,
  refreshPool,
  discoverPositions,
  getPositionBalances,
  getSafeWithdrawBins,
  harvestBins,
  ensureATAs,
  isInflight,
} from './harvester';
import { deployBuyPosition } from './deployer';
import type { PoolState, DiscoveredPosition } from './harvester';

class ProtocolLP {
  private connection: any;
  private pool: PoolState | null = null;
  private positions: DiscoveredPosition[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private currentInterval: number = CONFIG.pollIntervalMs;
  private lastHarvestTime = 0;
  private shuttingDown = false;

  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
  }

  async start() {
    console.log('');
    console.log('Protocol LP Automation');
    console.log(`Pool: ${CONFIG.poolAddressStr}`);
    console.log(`Wallet: ${CONFIG.wallet.publicKey.toBase58()}`);
    console.log(`Strategy: ${CONFIG.reentryStrategyName}, ${CONFIG.reentryBinCount} bins`);
    console.log(`Min re-entry: ${(CONFIG.minReentryLamports / 1e9).toFixed(2)} SOL`);
    console.log(`Reserve: ${(CONFIG.solReserveLamports / 1e9).toFixed(2)} SOL`);
    console.log(`Dry run: ${CONFIG.dryRun}`);
    console.log('');

    // Load persisted state
    loadState();

    // Connect to pool
    console.log('Connecting to DLMM pool...');
    this.pool = await createPool(this.connection);
    console.log(`Active bin: ${this.pool.activeId}, bin step: ${this.pool.binStep}`);

    // Ensure ATAs
    const tokenXMint = this.pool.dlmm.tokenX.publicKey.toBase58();
    const tokenYMint = this.pool.dlmm.tokenY.publicKey.toBase58();
    await ensureATAs(this.connection, [tokenXMint, tokenYMint]);

    // Discover positions
    this.positions = await discoverPositions(this.pool);
    const sellCount = this.positions.filter(p => p.side === 'sell').length;
    const buyCount = this.positions.filter(p => p.side === 'buy').length;
    console.log(`Found ${this.positions.length} positions (${sellCount} sell, ${buyCount} buy)`);

    for (const pos of this.positions) {
      console.log(`  ${pos.side.toUpperCase()} ${pos.pubkey.slice(0, 12)}... bins ${pos.minBinId}-${pos.maxBinId}`);
    }
    console.log('');

    // Start health server
    startHealthServer();

    // Wire shutdown handlers
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    // Initial poll
    await this.poll();

    // Start poll loop
    this.pollTimer = setInterval(() => this.safePoll(), this.currentInterval);
    console.log(`Polling every ${this.currentInterval / 1000}s`);
  }

  private async safePoll() {
    try {
      await this.poll();
    } catch (err: any) {
      console.error(`[poll] Error: ${err.message}`);
    }
    this.adjustPollRate();
  }

  private async poll() {
    if (this.shuttingDown || !this.pool) return;

    // Refresh pool state
    await refreshPool(this.pool);
    const activeId = this.pool.activeId;

    // Re-discover positions (may have new buy positions from deployments)
    this.positions = await discoverPositions(this.pool);

    const balance = await this.connection.getBalance(CONFIG.wallet.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;

    updateHealthData({
      activeId,
      walletSol: balanceSol.toFixed(4),
      pollInterval: this.currentInterval,
      fastMode: this.currentInterval === CONFIG.pollFastMs,
    });

    // ─── Harvest sell positions ────────────────────────────────────

    const balanceBefore = balance;

    for (const pos of this.positions.filter(p => p.side === 'sell')) {
      const { yBalance, binsWithY } = await getPositionBalances(this.pool, pos.pubkey);
      const safeBins = getSafeWithdrawBins('sell', activeId, binsWithY);

      if (safeBins.length === 0) continue;

      // Estimate SOL in safe bins (yBalance is total, safeBins is subset)
      // For accuracy, we'd need per-bin amounts. For now, harvest if any safe bins exist.
      const yLamports = Number(yBalance);

      if (yLamports < CONFIG.minHarvestLamports) {
        console.log(`[poll] ${pos.pubkey.slice(0, 8)} has ${(yLamports / 1e9).toFixed(4)} SOL in ${safeBins.length} safe bins — below threshold`);
        continue;
      }

      console.log(`[poll] ${pos.pubkey.slice(0, 8)} has ~${(yLamports / 1e9).toFixed(4)} SOL in ${safeBins.length} safe bins — harvesting`);

      const result = await harvestBins(this.connection, this.pool, pos.pubkey, safeBins, 'sell');
      if (result) {
        this.lastHarvestTime = Date.now();
      }
    }

    // ─── Log buy positions (Phase 2: harvest CRANK from exhausted buys) ─

    for (const pos of this.positions.filter(p => p.side === 'buy')) {
      const { xBalance, binsWithX } = await getPositionBalances(this.pool, pos.pubkey);
      const safeBins = getSafeWithdrawBins('buy', activeId, binsWithX);
      if (safeBins.length > 0) {
        console.log(`[poll] Buy position ${pos.pubkey.slice(0, 8)} has ${safeBins.length} converted bins (Phase 2)`);
      }
    }

    // ─── Deploy buy position if enough SOL accumulated ─────────────

    const balanceNow = await this.connection.getBalance(CONFIG.wallet.publicKey);
    const deployable = balanceNow - CONFIG.solReserveLamports;

    if (deployable >= CONFIG.minReentryLamports) {
      console.log(`[poll] Wallet has ${(balanceNow / 1e9).toFixed(4)} SOL, deploying ${(deployable / 1e9).toFixed(4)} SOL as buy position`);
      try {
        await deployBuyPosition(this.connection, this.pool, deployable);
      } catch (err: any) {
        console.error(`[deploy] Failed: ${err.message}`);
      }
    } else if (deployable > 0) {
      console.log(`[poll] Wallet has ${(balanceNow / 1e9).toFixed(4)} SOL — accumulating (need ${(CONFIG.minReentryLamports / 1e9).toFixed(2)} SOL to deploy)`);
    }
  }

  private adjustPollRate() {
    const timeSinceHarvest = Date.now() - this.lastHarvestTime;
    const shouldBeFast = this.lastHarvestTime > 0 && timeSinceHarvest < CONFIG.fastModeDurationMs;
    const targetInterval = shouldBeFast ? CONFIG.pollFastMs : CONFIG.pollIntervalMs;

    if (targetInterval !== this.currentInterval) {
      this.currentInterval = targetInterval;
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.safePoll(), this.currentInterval);
      console.log(`[poll] Switched to ${this.currentInterval / 1000}s interval`);
    }
  }

  private async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log('\nShutting down...');

    if (this.pollTimer) clearInterval(this.pollTimer);

    // Wait for in-flight operations (max 30s)
    const deadline = Date.now() + 30_000;
    while (isInflight() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log('Shutdown complete.');
    process.exit(0);
  }
}

const bot = new ProtocolLP();
bot.start().catch(err => {
  console.error('Fatal:', err.message ?? err);
  process.exit(1);
});
