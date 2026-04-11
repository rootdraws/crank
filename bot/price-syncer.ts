/**
 * price-syncer.ts
 *
 * Arb bot that syncs external prices into Meteora DLMM pools.
 * Detects divergence between Jupiter (real market) and Meteora (stale pool),
 * swaps through Jupiter routing to push activeId in line with reality.
 *
 * Without this, sells on low-liquidity pools (e.g. CRANK/SOL) never trigger
 * because nobody arbs the PumpSwap↔Meteora price difference.
 *
 * Self-funding via arb profit (spread - gas).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
  TransactionInstruction,
} from '@solana/web3.js';
import { EventEmitter } from 'events';
import { logger } from './logger';
import { withRetry } from './retry';
import { binToPrice } from '../packages/core-sdk/math';
import type { GeyserSubscriber, LbPairInfo } from './geyser-subscriber';
import { alertSyncFailure, alertLargeDivergence } from './alerter';

// ═══ TYPES ═══

export interface SyncPoolConfig {
  address: string;
  label: string;
  mintX: string;
  mintY: string;
  decimalsX: number;
  decimalsY: number;
  binStep: number;
}

interface ActiveIdChange {
  timestamp: number;
  from: number;
  to: number;
  delta: number;
  source: 'external' | 'self';  // 'self' if we just synced, 'external' otherwise
}

interface PoolSyncState {
  lastCheckAt: number;
  lastSyncAt: number;
  lastDivergencePct: number;
  lastDirection: 'buy' | 'sell' | null;
  failureBackoffMs: number;
  consecutiveFailures: number;
  previousActiveId: number | null;
  activeIdChanges: ActiveIdChange[];  // ring buffer, last 100
  externalChangeCount: number;
  lastExternalChangeAt: number | null;
}

export interface SyncerConfig {
  connection: Connection;
  botKeypair: Keypair;
  subscriber: GeyserSubscriber;
  syncPools: SyncPoolConfig[];
  intervalMs: number;
  divergenceThresholdPct: number;
  minProfitLamports: number;
  maxSwapLamports: number;
  dryRun: boolean;
}

interface SyncerStats {
  totalChecks: number;
  totalSyncs: number;
  totalSyncFailures: number;
  cumulativeProfitLamports: number;
  cumulativeGasLamports: number;
  lastCheckAt: number | null;
  lastSyncAt: number | null;
  lastSyncTxSig: string | null;
}

// ═══ CONSTANTS ═══

const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap-instructions';
const MIN_SWAP_LAMPORTS = 10_000_000; // 0.01 SOL
const MAX_FAILURE_BACKOFF_MS = 5 * 60 * 1000; // 5 min
const ESTIMATED_GAS_LAMPORTS = 5_000_000; // ~0.005 SOL conservative estimate

// LbPair byte offsets (same as geyser-subscriber.ts)
const OFFSET_ACTIVE_ID = 76; // i32
const OFFSET_BIN_STEP = 80;  // u16

// ═══ HELPERS ═══

function deserializeInstruction(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

// ═══ PRICE SYNCER ═══

export class PriceSyncer extends EventEmitter {
  private config: SyncerConfig;
  private stats: SyncerStats;
  private poolState: Map<string, PoolSyncState> = new Map();
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private running = false;

  constructor(config: SyncerConfig) {
    super();
    this.config = config;
    this.stats = {
      totalChecks: 0,
      totalSyncs: 0,
      totalSyncFailures: 0,
      cumulativeProfitLamports: 0,
      cumulativeGasLamports: 0,
      lastCheckAt: null,
      lastSyncAt: null,
      lastSyncTxSig: null,
    };

    for (const pool of config.syncPools) {
      this.poolState.set(pool.address, {
        lastCheckAt: 0,
        lastSyncAt: 0,
        lastDivergencePct: 0,
        lastDirection: null,
        failureBackoffMs: 0,
        consecutiveFailures: 0,
        previousActiveId: null,
        activeIdChanges: [],
        externalChangeCount: 0,
        lastExternalChangeAt: null,
      });
    }
  }

  async start(): Promise<void> {
    logger.info({
      pools: this.config.syncPools.map(p => p.label),
      intervalMs: this.config.intervalMs,
      threshold: this.config.divergenceThresholdPct,
      maxSwapSol: this.config.maxSwapLamports / 1e9,
      dryRun: this.config.dryRun,
    }, '[syncer] Starting price syncer');

    this.running = true;
    this.runLoop();
  }

  private async runLoop(): Promise<void> {
    if (this.shuttingDown) return;

    for (const pool of this.config.syncPools) {
      if (this.shuttingDown) break;

      const state = this.poolState.get(pool.address)!;
      const elapsed = Date.now() - state.lastCheckAt;
      const requiredInterval = this.config.intervalMs + state.failureBackoffMs;

      if (elapsed < requiredInterval) continue;

      try {
        await this.checkAndSync(pool);
      } catch (e: any) {
        logger.error({ err: e.message, pool: pool.label }, '[syncer] Unexpected error in check loop');
      }
    }

    if (!this.shuttingDown) {
      this.loopTimer = setTimeout(() => this.runLoop(), this.config.intervalMs);
    }
  }

  private async checkAndSync(pool: SyncPoolConfig): Promise<void> {
    const state = this.poolState.get(pool.address)!;

    // 1. Get Meteora activeId — prefer gRPC cache, fall back to RPC
    let activeId: number;
    const poolInfo = this.config.subscriber.getPoolInfo(pool.address);
    if (poolInfo) {
      activeId = poolInfo.activeId;
    } else {
      // Pool not in gRPC subscriber (no open positions) — read directly from RPC
      try {
        const accountInfo = await this.config.connection.getAccountInfo(new PublicKey(pool.address));
        if (!accountInfo?.data || accountInfo.data.length < OFFSET_BIN_STEP + 2) {
          logger.warn({ pool: pool.label }, '[syncer] LbPair account not found or too small');
          state.lastCheckAt = Date.now();
          return;
        }
        activeId = accountInfo.data.readInt32LE(OFFSET_ACTIVE_ID);
      } catch (e: any) {
        logger.warn({ err: e.message, pool: pool.label }, '[syncer] Failed to read LbPair via RPC');
        state.lastCheckAt = Date.now();
        return;
      }
    }

    // Track activeId changes — detect external arb activity
    if (state.previousActiveId !== null && activeId !== state.previousActiveId) {
      const delta = activeId - state.previousActiveId;
      // If we just synced within the last interval, it's likely our own swap
      const recentlySynced = state.lastSyncAt > 0 && (Date.now() - state.lastSyncAt) < this.config.intervalMs * 1.5;
      const source = recentlySynced ? 'self' as const : 'external' as const;

      const change: ActiveIdChange = {
        timestamp: Date.now(),
        from: state.previousActiveId,
        to: activeId,
        delta,
        source,
      };

      state.activeIdChanges.push(change);
      if (state.activeIdChanges.length > 100) state.activeIdChanges.shift();

      if (source === 'external') {
        state.externalChangeCount++;
        state.lastExternalChangeAt = Date.now();
      }

      logger.info({
        pool: pool.label,
        from: state.previousActiveId,
        to: activeId,
        delta,
        source,
        externalTotal: state.externalChangeCount,
      }, `[syncer] activeId moved (${source})`);
    }
    state.previousActiveId = activeId;

    const meteoraPrice = binToPrice(activeId, pool.binStep, pool.decimalsX, pool.decimalsY);

    // 2. Get Jupiter price via probe quote (1 whole token X → token Y)
    const probeAmount = Math.pow(10, pool.decimalsX); // 1 whole token
    let jupiterPrice: number;
    try {
      const quoteUrl = `${JUPITER_QUOTE_URL}?inputMint=${pool.mintX}&outputMint=${pool.mintY}&amount=${probeAmount}&slippageBps=100`;
      const resp = await fetch(quoteUrl, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`Jupiter quote HTTP ${resp.status}`);
      const quote = await resp.json();
      if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);
      jupiterPrice = parseInt(quote.outAmount) / Math.pow(10, pool.decimalsY);
    } catch (e: any) {
      logger.warn({ err: e.message, pool: pool.label }, '[syncer] Jupiter probe quote failed');
      state.lastCheckAt = Date.now();
      return;
    }

    if (jupiterPrice <= 0 || meteoraPrice <= 0) {
      logger.warn({ jupiterPrice, meteoraPrice, pool: pool.label }, '[syncer] Invalid price — skipping');
      state.lastCheckAt = Date.now();
      return;
    }

    // 3. Compute divergence
    const divergencePct = Math.abs(jupiterPrice - meteoraPrice) / jupiterPrice * 100;

    state.lastCheckAt = Date.now();
    state.lastDivergencePct = divergencePct;
    this.stats.totalChecks++;
    this.stats.lastCheckAt = Date.now();

    // 4. Determine direction
    // Jupiter price > Meteora → token worth more externally → buy on Meteora (SOL→TOKEN, pushes activeId UP)
    // Jupiter price < Meteora → token worth less externally → sell on Meteora (TOKEN→SOL, pushes activeId DOWN)
    const direction: 'buy' | 'sell' = jupiterPrice > meteoraPrice ? 'buy' : 'sell';
    state.lastDirection = direction;

    // 5. Below threshold — done (quietly; stats still updated above for /api/syncer)
    if (divergencePct < this.config.divergenceThresholdPct) return;

    // Only log when divergence is actionable (at or above threshold)
    logger.info({
      pool: pool.label,
      divergencePct: +divergencePct.toFixed(2),
      meteoraPrice: +meteoraPrice.toFixed(10),
      jupiterPrice: +jupiterPrice.toFixed(10),
      activeId,
      direction,
    }, `[syncer] Price check — above threshold`);

    // 6. Compute swap amount — linear scale with divergence
    const divergenceRatio = Math.min(1, (divergencePct - this.config.divergenceThresholdPct) / this.config.divergenceThresholdPct);
    const swapLamports = Math.floor(MIN_SWAP_LAMPORTS + divergenceRatio * (this.config.maxSwapLamports - MIN_SWAP_LAMPORTS));

    // For buy: input is SOL (mintY), amount in lamports
    // For sell: input is TOKEN (mintX), convert SOL-equivalent to token amount
    let inputMint: string;
    let outputMint: string;
    let inputAmount: number;

    if (direction === 'buy') {
      inputMint = pool.mintY;   // SOL
      outputMint = pool.mintX;  // TOKEN
      inputAmount = swapLamports;
    } else {
      inputMint = pool.mintX;   // TOKEN
      outputMint = pool.mintY;  // SOL
      // Convert SOL-equivalent amount to token amount using Jupiter price
      inputAmount = Math.floor((swapLamports / Math.pow(10, pool.decimalsY)) / jupiterPrice * Math.pow(10, pool.decimalsX));
    }

    if (inputAmount <= 0) {
      logger.warn({ pool: pool.label, inputAmount }, '[syncer] Computed input amount <= 0 — skipping');
      return;
    }

    // 7. Get real quote for actual swap amount
    let realQuote: any;
    try {
      const realUrl = `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${inputAmount}&slippageBps=50`;
      const resp = await fetch(realUrl, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) throw new Error(`Jupiter real quote HTTP ${resp.status}`);
      realQuote = await resp.json();
      if (realQuote.error) throw new Error(`Jupiter real quote error: ${realQuote.error}`);
    } catch (e: any) {
      logger.warn({ err: e.message, pool: pool.label }, '[syncer] Jupiter real quote failed');
      return;
    }

    // 8. Profitability check
    let expectedProfitLamports: number;
    if (direction === 'sell') {
      // Selling TOKEN for SOL. outAmount is SOL lamports.
      // At Meteora price, this TOKEN would be worth fewer SOL lamports.
      const meteoraValueLamports = Math.floor(
        (inputAmount / Math.pow(10, pool.decimalsX)) * meteoraPrice * Math.pow(10, pool.decimalsY)
      );
      expectedProfitLamports = parseInt(realQuote.outAmount) - meteoraValueLamports;
    } else {
      // Buying TOKEN with SOL. outAmount is token atoms.
      // At Jupiter price, that TOKEN is worth more SOL than we paid.
      const jupiterValueLamports = Math.floor(
        (parseInt(realQuote.outAmount) / Math.pow(10, pool.decimalsX)) * jupiterPrice * Math.pow(10, pool.decimalsY)
      );
      expectedProfitLamports = jupiterValueLamports - inputAmount;
    }

    const netProfit = expectedProfitLamports - ESTIMATED_GAS_LAMPORTS;

    // 9. Emit divergence event
    this.emit('divergenceDetected', {
      pool: pool.address,
      label: pool.label,
      divergencePct,
      direction,
      meteoraPrice,
      jupiterPrice,
      inputAmount,
      expectedProfitLamports,
    });

    if (netProfit < this.config.minProfitLamports) {
      logger.info({
        pool: pool.label,
        expectedProfit: expectedProfitLamports,
        gas: ESTIMATED_GAS_LAMPORTS,
        net: netProfit,
        minRequired: this.config.minProfitLamports,
      }, '[syncer] Below min profit — skipping swap');
      return;
    }

    // Alert ONLY when there's an actual arb opportunity the bot would take.
    // Pure Meteora-vs-Jupiter price drift (e.g. when an LP pulls liquidity)
    // produces divergence with no profitable swap path — silent by design.
    // Ops channel + 5min per-pool cooldown bounds noise.
    alertLargeDivergence(pool.label, divergencePct, this.config.divergenceThresholdPct);

    // 10. Dry run check
    if (this.config.dryRun) {
      logger.info({
        pool: pool.label,
        direction,
        divergencePct: +divergencePct.toFixed(2),
        inputAmount,
        expectedProfit: expectedProfitLamports,
        netProfit,
      }, '[syncer] DRY RUN — would execute swap');
      return;
    }

    // 11. Check bot balance before swapping
    try {
      const balance = await this.config.connection.getBalance(this.config.botKeypair.publicKey);
      if (balance < swapLamports + ESTIMATED_GAS_LAMPORTS) {
        logger.warn({
          pool: pool.label,
          balance: balance / 1e9,
          required: (swapLamports + ESTIMATED_GAS_LAMPORTS) / 1e9,
        }, '[syncer] Insufficient bot balance for swap — skipping');
        return;
      }
    } catch (e: any) {
      logger.warn({ err: e.message }, '[syncer] Failed to check bot balance');
      return;
    }

    // 12. Execute swap
    try {
      await this.executeSwap(pool, realQuote, direction, state);
    } catch (e: any) {
      state.consecutiveFailures++;
      state.failureBackoffMs = Math.min(
        state.failureBackoffMs ? state.failureBackoffMs * 2 : this.config.intervalMs,
        MAX_FAILURE_BACKOFF_MS,
      );
      this.stats.totalSyncFailures++;
      logger.error({
        err: e.message,
        pool: pool.label,
        failures: state.consecutiveFailures,
        backoffMs: state.failureBackoffMs,
      }, '[syncer] Swap execution failed');
      alertSyncFailure(pool.label, e.message);
    }
  }

  private async executeSwap(
    pool: SyncPoolConfig,
    quoteResponse: any,
    direction: 'buy' | 'sell',
    state: PoolSyncState,
  ): Promise<void> {
    // 1. Get swap instructions from Jupiter
    const swapResp = await fetch(JUPITER_SWAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: this.config.botKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: 'auto',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const swapData = await swapResp.json();
    if (swapData.error) throw new Error(`Jupiter swap-instructions: ${swapData.error}`);

    // 2. Fetch address lookup tables
    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
    const altAddresses: string[] = swapData.addressLookupTableAddresses ?? [];
    if (altAddresses.length > 0) {
      const altInfos = await this.config.connection.getMultipleAccountsInfo(
        altAddresses.map(a => new PublicKey(a))
      );
      for (let i = 0; i < altInfos.length; i++) {
        const info = altInfos[i];
        if (info) {
          addressLookupTableAccounts.push(
            new AddressLookupTableAccount({
              key: new PublicKey(altAddresses[i]),
              state: AddressLookupTableAccount.deserialize(info.data),
            })
          );
        }
      }
    }

    // 3. Build instructions
    const instructions: TransactionInstruction[] = [];

    if (swapData.setupInstructions?.length > 0) {
      for (const ix of swapData.setupInstructions) {
        instructions.push(deserializeInstruction(ix));
      }
    }

    instructions.push(deserializeInstruction(swapData.swapInstruction));

    if (swapData.cleanupInstruction) {
      instructions.push(deserializeInstruction(swapData.cleanupInstruction));
    }

    // 4. Build VersionedTransaction
    const { blockhash, lastValidBlockHeight } = await this.config.connection.getLatestBlockhash();

    const messageV0 = new TransactionMessage({
      payerKey: this.config.botKeypair.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(addressLookupTableAccounts);

    const vTx = new VersionedTransaction(messageV0);
    vTx.sign([this.config.botKeypair]);

    // 5. Send and confirm
    const txSig = await this.config.connection.sendRawTransaction(vTx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });

    logger.info({ pool: pool.label, direction, txSig }, '[syncer] Swap tx sent');

    const confirmation = await this.config.connection.confirmTransaction(
      { signature: txSig, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    if (confirmation.value.err) {
      throw new Error(`Swap failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }

    // 6. Read actual P&L from transaction
    let actualProfitLamports = 0;
    try {
      const txData = await this.config.connection.getTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (txData?.meta) {
        // Compare pre/post SOL balance of bot wallet
        const staticKeys = txData.transaction.message.staticAccountKeys;
        const botIndex = staticKeys.findIndex(
          (k: PublicKey) => k.equals(this.config.botKeypair.publicKey)
        );
        if (botIndex >= 0) {
          const preBal = txData.meta.preBalances[botIndex];
          const postBal = txData.meta.postBalances[botIndex];
          // For sell: SOL gained - SOL spent on gas
          // For buy: SOL spent (negative) — profit is in tokens held
          actualProfitLamports = postBal - preBal;
        }
      }
    } catch (e: any) {
      logger.warn({ err: e.message, txSig }, '[syncer] Failed to read tx for P&L — continuing');
    }

    // 7. Update stats
    this.stats.totalSyncs++;
    this.stats.lastSyncAt = Date.now();
    this.stats.lastSyncTxSig = txSig;
    this.stats.cumulativeProfitLamports += actualProfitLamports;
    if (actualProfitLamports < 0) {
      this.stats.cumulativeGasLamports += Math.abs(actualProfitLamports);
    }

    state.lastSyncAt = Date.now();
    state.failureBackoffMs = 0;
    state.consecutiveFailures = 0;

    logger.info({
      pool: pool.label,
      direction,
      txSig,
      divergencePct: +state.lastDivergencePct.toFixed(2),
      profitLamports: actualProfitLamports,
      profitSol: +(actualProfitLamports / 1e9).toFixed(6),
    }, '[syncer] Swap executed successfully');

    this.emit('syncExecuted', {
      pool: pool.address,
      label: pool.label,
      direction,
      txSig,
      divergencePct: state.lastDivergencePct,
      profitLamports: actualProfitLamports,
    });
  }

  async shutdown(): Promise<void> {
    logger.info('[syncer] Shutting down price syncer');
    this.shuttingDown = true;
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getStats(): Record<string, any> {
    const perPool: Record<string, any> = {};
    for (const [addr, state] of this.poolState) {
      const pool = this.config.syncPools.find(p => p.address === addr);
      perPool[pool?.label ?? addr] = {
        lastCheckAt: state.lastCheckAt || null,
        lastSyncAt: state.lastSyncAt || null,
        lastDivergencePct: +state.lastDivergencePct.toFixed(2),
        lastDirection: state.lastDirection,
        consecutiveFailures: state.consecutiveFailures,
        backoffMs: state.failureBackoffMs,
        activeId: state.previousActiveId,
        externalChangeCount: state.externalChangeCount,
        lastExternalChangeAt: state.lastExternalChangeAt,
        recentChanges: state.activeIdChanges.slice(-20),
      };
    }

    return {
      running: this.running,
      dryRun: this.config.dryRun,
      intervalMs: this.config.intervalMs,
      thresholdPct: this.config.divergenceThresholdPct,
      maxSwapSol: this.config.maxSwapLamports / 1e9,
      totalChecks: this.stats.totalChecks,
      totalSyncs: this.stats.totalSyncs,
      totalSyncFailures: this.stats.totalSyncFailures,
      cumulativeProfitSol: +(this.stats.cumulativeProfitLamports / 1e9).toFixed(6),
      cumulativeGasSol: +(this.stats.cumulativeGasLamports / 1e9).toFixed(6),
      lastCheckAt: this.stats.lastCheckAt,
      lastSyncAt: this.stats.lastSyncAt,
      lastSyncTxSig: this.stats.lastSyncTxSig,
      perPool,
    };
  }
}
