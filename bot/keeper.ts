/**
 * keeper.ts
 *
 * Daily orchestration for crank.money. Post-2026-04-29 bin-farm cleanup:
 * BANK distribution, gauge-weighted Merkle epochs, rover burn-and-mint, and
 * the curve-driven sweep_rover / open_fee_rovers / close_rover_* machinery
 * are all retired. Fee accumulation now flows directly to Config.fee_dest.
 *
 * Daily sequence (runs once per UTC day):
 *   1. prune_inactive_members   — drop crank role from idle Discord members
 *   2. refresh_supplies         — refresh in-memory CRANK supply for /buy math
 *   3. daily_stats_post         — post protocol-wide volume summary to #crank-stats
 *
 * The bot checks hourly (Idle) or every 30s (during daily processing).
 * Returns 'Idle' or 'Processing' to the orchestrator for adaptive interval.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { logger } from './logger';
import { withRetry as sharedWithRetry } from './retry';

const KEEPER_RETRY_BASE_MS = 2000;
function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return sharedWithRetry(fn, label, KEEPER_RETRY_BASE_MS);
}

// Priority fee floor/cap (micro-lamports per compute unit)
const KEEPER_PRIORITY_FEE_FLOOR = 10_000;
const KEEPER_PRIORITY_FEE_CAP = 500_000; // 0.2 SOL max at 400K CU

/** Build compute budget instructions with dynamic priority fee */
async function buildKeeperPriorityIxs(connection: Connection): Promise<any[]> {
  let microLamports = KEEPER_PRIORITY_FEE_FLOOR;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length > 0) {
      const sorted = fees.map((f: any) => f.prioritizationFee).sort((a: number, b: number) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      microLamports = Math.min(Math.max(median, KEEPER_PRIORITY_FEE_FLOOR), KEEPER_PRIORITY_FEE_CAP);
    }
  } catch (e) {
    logger.warn('Failed to fetch priority fees, using floor');
  }
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

// ═══ TYPES ═══

interface KeeperConfig {
  connection: Connection;
  coreProgram: Program;
  botKeypair: Keypair;
  coreProgramId: PublicKey;
  hopperProgram?: Program | null;
  hopperProgramId?: PublicKey | null;
  walletService: any;
  getWatchedPools?: () => string[];
}

// ═══ KEEPER ═══

export class MonkeKeeper {
  private connection: Connection;
  private coreProgram: Program;
  private hopperProgram: Program | null;
  private hopperProgramId: PublicKey | null;
  private botKeypair: Keypair;
  private walletService: any;
  private coreProgramId: PublicKey;
  // Track last successful run (UTC day number + timestamp) for daily gating
  private lastRunDay: number = 0;
  private lastRunTimestamp: number = 0;
  // Cached priority fee instructions (refreshed per daily sequence)
  private priorityIxs: any[] = [];
  // Optional pool registry from subscriber
  private getWatchedPools?: () => string[];
  // Discord client for member pruning (injected after bot start)
  private discordClient: any = null;
  // Relay callback: called with rover TVL data after daily cycle
  public onRoverTvlComputed?: (entries: Array<{ pool: string; tvl: number; positionCount: number; status: string }>) => void;

  constructor(config: KeeperConfig) {
    this.connection = config.connection;
    this.coreProgram = config.coreProgram;
    this.hopperProgram = config.hopperProgram ?? null;
    this.hopperProgramId = config.hopperProgramId ?? null;
    this.botKeypair = config.botKeypair;
    this.walletService = config.walletService;
    this.coreProgramId = config.coreProgramId;
    this.getWatchedPools = config.getWatchedPools;
  }

  setWalletService(ws: any): void {
    this.walletService = ws;
  }

  setDiscordClient(client: any): void {
    this.discordClient = client;
  }

  /**
   * Main entry point. Called by the orchestrator on each keeper tick.
   * Returns 'Idle' or 'Processing' for adaptive interval.
   * The orchestrator uses this to set 1hr vs 30s cadence.
   */
  async runDailySequence(): Promise<string> {
    const ts = new Date().toISOString().slice(0, 19);
    const now = Date.now();
    const today = Math.floor(now / 86_400_000); // UTC day number

    // Gate: same UTC day OR less than 20 hours since last run (prevents double-fire near midnight)
    const MIN_RUN_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20 hours
    if (today <= this.lastRunDay || (now - this.lastRunTimestamp) < MIN_RUN_INTERVAL_MS) {
      logger.info(`[keeper] ${ts} Idle — already ran today`);
      return 'Idle';
    }

    logger.info(`[keeper] ${ts} Running daily sequence`);

    // Refresh priority fees for this sequence
    this.priorityIxs = await buildKeeperPriorityIxs(this.connection);

    // Step 1: Sweep HopperVault SOL to W-Buy / Treasury / Personal per RoutingConfig.
    //         Threshold-gated; no-op below sol_threshold_lamports.
    await this.crankHopperSweep();

    // Step 2: Prune the crank role from idle Discord members (best-effort).
    await this.crankPruneInactiveMembers();

    // Step 3: Refresh in-memory pool supplies from on-chain mint state.
    await this.crankRefreshSupplies();

    // Step 4: Post a daily volume summary to #crank-stats.
    await this.crankDailyStatsPost();

    this.lastRunDay = today;
    this.lastRunTimestamp = Date.now();
    logger.info(`[keeper] ${ts} Daily sequence complete`);
    return 'Processing';
  }

  /**
   * Drain accumulated HopperVault SOL via the on-chain 40/40/20 routing.
   * Threshold-gated by RoutingConfig.sol_threshold_lamports — no-op below.
   * No-op entirely if Hopper IDL isn't loaded (sweep step disabled).
   *
   * Permissionless: bot acts as cranker. cranker_tip_bps in RoutingConfig
   * (currently 0) controls whether the bot earns a tip slice.
   */
  private async crankHopperSweep(): Promise<void> {
    if (!this.hopperProgram || !this.hopperProgramId) {
      return; // Hopper not wired — skip silently.
    }

    const [routingConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('routing_config')],
      this.hopperProgramId,
    );
    const [hopperVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('hopper_vault')],
      this.hopperProgramId,
    );

    let cfg: any;
    try {
      cfg = await this.hopperProgram.account.routingConfig.fetch(routingConfigPda);
    } catch {
      logger.info('  [keeper] hopper sweep skipped — RoutingConfig not initialized');
      return;
    }

    if (cfg.paused) {
      logger.info('  [keeper] hopper sweep skipped — paused');
      return;
    }

    const balance = await this.connection.getBalance(hopperVaultPda);
    // HopperVault account size = 9 bytes (8 disc + 1 bump)
    const rentMin = await this.connection.getMinimumBalanceForRentExemption(9);
    const sweepable = Math.max(0, balance - rentMin);
    const threshold = Number(cfg.solThresholdLamports.toString());

    if (sweepable < threshold || sweepable === 0) {
      logger.info(
        `  [keeper] hopper sweep skipped — sweepable ${(sweepable / 1e9).toFixed(6)} SOL ` +
          `< threshold ${(threshold / 1e9).toFixed(6)} SOL`,
      );
      return;
    }

    try {
      const sig = await withRetry(
        () =>
          this.hopperProgram!.methods
            .sweepSol()
            .accounts({
              cranker: this.botKeypair.publicKey,
              routingConfig: routingConfigPda,
              hopperVault: hopperVaultPda,
              wBuy: cfg.wBuy,
              treasury: cfg.treasury,
              personal: cfg.personal,
              systemProgram: new PublicKey('11111111111111111111111111111111'),
            })
            .signers([this.botKeypair])
            .rpc(),
        'hopper.sweep_sol',
      );
      logger.info(
        `  [keeper] ✓ sweep_sol — ${(sweepable / 1e9).toFixed(4)} SOL routed (sig ${sig.slice(0, 8)})`,
      );
    } catch (e: any) {
      logger.warn(`[keeper] sweep_sol error: ${e.message?.slice(0, 200)}`);
    }
  }

  /**
   * Post a protocol-wide stats summary to `#crank-stats` (or the feed channel
   * if `DISCORD_STATS_CHANNEL_ID` isn't set). Best-effort — skips silently if
   * Discord isn't wired or there's no data yet.
   */
  private async crankDailyStatsPost(): Promise<void> {
    try {
      const channelId = process.env.DISCORD_STATS_CHANNEL_ID || process.env.DISCORD_FEED_CHANNEL_ID;
      if (!channelId || !this.discordClient || !this.walletService) {
        logger.info(`  [keeper] stats post skipped — channel=${!!channelId} client=${!!this.discordClient} ws=${!!this.walletService}`);
        return;
      }

      const now = Date.now();
      const ws = this.walletService;
      const d1 = ws.getTotalVolumeUsd(now - 24 * 60 * 60 * 1000);
      const d7 = ws.getTotalVolumeUsd(now - 7 * 24 * 60 * 60 * 1000);
      const all = ws.getTotalVolumeUsd(0);
      const activeUsers = ws.getActiveUserCount();
      const fills = ws.getTotalHarvestCount();
      const open = ws.getTotalOpenPositions();

      // Skip the post on truly empty days — no reason to spam an idle channel.
      if (d1 === 0 && fills === 0) {
        logger.info(`  [keeper] stats post skipped — zero activity`);
        return;
      }

      const fmtUsd = (n: number) => n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toFixed(4);
      const lines = [
        '**crank.money — daily stats**',
        `\`24h \` · $${fmtUsd(d1)}`,
        `\`7d  \` · $${fmtUsd(d7)}`,
        `\`all \` · $${fmtUsd(all)}`,
        '',
        `\`users\` · ${activeUsers} active`,
        `\`fills\` · ${fills}`,
        `\`open \` · ${open}`,
      ];

      const channel = await this.discordClient.channels.fetch(channelId);
      if (channel?.isTextBased()) {
        await channel.send({ content: lines.join('\n'), allowedMentions: { parse: [] } });
        logger.info(`  [keeper] ✓ stats posted to #${channel.name ?? channelId.slice(0, 8)}`);
      }
    } catch (e: any) {
      logger.warn(`  [keeper] stats post failed: ${e.message?.slice(0, 120)}`);
    }
  }

  /**
   * Iterate mc-mode pools and refresh their in-memory `supply` from the
   * on-chain mint. curator.json is the seed, not the source of truth —
   * supply drifts as rover_burn_and_mint fires daily.
   */
  private async crankRefreshSupplies(): Promise<void> {
    try {
      const { loadPoolRegistry, setPoolSupply } = await import('../packages/core-sdk/pool-config');
      const { getMint } = await import('@solana/spl-token');

      const pools = loadPoolRegistry();
      const seen = new Set<string>();
      let updated = 0;
      for (const p of pools) {
        if (p.displayMode !== 'mc') continue;
        // base mint carries the supply — on CRANK/SOL that's mintX.
        const mintAddr = p.mintX;
        if (seen.has(mintAddr)) continue;
        seen.add(mintAddr);

        try {
          const mint = await getMint(this.connection, new PublicKey(mintAddr));
          const humanSupply = Number(mint.supply) / 10 ** mint.decimals;
          const touched = setPoolSupply(mintAddr, humanSupply);
          logger.info(`  [keeper] refresh supply ${p.tokenX} = ${humanSupply.toFixed(0)} (${touched} pool(s))`);
          updated += touched;
        } catch (e: any) {
          logger.warn(`  [keeper] refresh supply failed for ${p.tokenX}: ${e.message?.slice(0, 80)}`);
        }
      }
      logger.info(`  [keeper] ✓ refresh_supplies — ${updated} pool row(s) updated`);
    } catch (e: any) {
      logger.warn(`  [keeper] refresh_supplies error: ${e.message?.slice(0, 80)}`);
    }
  }

  // ─── CRANK: PRUNE INACTIVE MEMBERS ───
  //
  // Removes the "crank" Discord role from users with no open position AND no
  // harvest in the rolling window. Keeps the trading floor signal-only — idle
  // wallets drop back to #the-lobby.
  //
  // No-op unless all of DISCORD_CRANK_ROLE_ID, DISCORD_GUILD_ID, and
  // discordClient are set. Never throws.
  private async crankPruneInactiveMembers(): Promise<void> {
    const roleId = process.env.DISCORD_CRANK_ROLE_ID;
    const guildId = process.env.DISCORD_GUILD_ID;
    const dryRun = process.env.CRANK_ROLE_PRUNE_DRY_RUN === 'true';

    if (!roleId || !guildId || !this.discordClient || !this.walletService) {
      logger.info(`[keeper] prune skipped — roleId=${!!roleId} guildId=${!!guildId} client=${!!this.discordClient} ws=${!!this.walletService}`);
      return;
    }

    try {
      const windowDays = parseInt(process.env.CRANK_ROLE_PRUNE_WINDOW_DAYS || '7', 10);
      const sinceMs = Date.now() - windowDays * 86_400_000;

      const guild = await this.discordClient.guilds.fetch(guildId);
      const role = await guild.roles.fetch(roleId);
      if (!role) {
        logger.warn(`[keeper] prune abort — crank role ${roleId} not found in guild ${guildId}`);
        return;
      }

      // Fetch full member list to hydrate role members (role.members is a cache).
      await guild.members.fetch();

      const members = [...role.members.values()];
      let pruned = 0;
      let candidates = 0;
      for (const member of members) {
        const userId = `discord:${member.id}`;
        if (!this.walletService.isRegistered(userId)) continue;
        if (this.walletService.isActiveWithin(userId, sinceMs)) continue;
        candidates += 1;
        if (dryRun) {
          logger.info(`[keeper] prune DRY — would remove from ${member.user?.tag || member.id}`);
          continue;
        }
        try {
          await member.roles.remove(role, `inactive ${windowDays}d — no position, no fills`);
          pruned += 1;
        } catch (e: any) {
          logger.warn(`[keeper] failed to remove crank role from ${member.id}: ${e.message}`);
        }
      }

      logger.info(`[keeper] prune done — members=${members.length} candidates=${candidates} pruned=${pruned} window=${windowDays}d dryRun=${dryRun}`);
    } catch (e: any) {
      logger.warn(`[keeper] crankPruneInactiveMembers error: ${e.message}`);
    }
  }

}
