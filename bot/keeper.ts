/**
 * keeper.ts
 *
 * Daily fee sequencer for crank.money.
 * 6-step daily sequence. 40/40/20 split (BANK holders / traders / bot operations).
 *
 * Daily sequence (runs once per UTC day):
 *   1. close_rover_wsol    — WSOL ATA → native SOL on rover_authority
 *   2. sweep_rover         — native SOL → 40% holders + 40% traders + 20% Config.bot
 *   3. open_fee_rovers     — token ATAs → DLMM positions
 *   4. close_exhausted_rovers — empty rovers → rent reclaimed
 *
 * The bot checks hourly (Idle) or every 30s (during daily processing).
 * Returns 'Idle' or 'Processing' to the orchestrator for adaptive interval.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { logger } from './logger';
import { alertEpochMiss, alertEpochSuccess } from './alerter';
import { buildMeteoraCPIAccounts, getDLMM, fixBitmapWritable, SPL_MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, hasTransferHook } from './meteora-accounts';
import { fetchDexScreenerPrice } from '../packages/core-sdk/price-source';
import { confirmAndCheck } from '../packages/core-sdk/transactions';

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
  distributorProgram: Program;
  epochVaultProgram: Program;
  botKeypair: Keypair;
  coreProgramId: PublicKey;
  distributorProgramId: PublicKey;
  walletService: any;
  // Optional pool registry from subscriber to avoid position.all() in fee rovers
  getWatchedPools?: () => string[];
}

// ═══ HELPERS ═══

import { withRetry as sharedWithRetry } from './retry';

const KEEPER_RETRY_BASE_MS = 2000;
const DEPOSIT_SOL_THRESHOLD_LAMPORTS = parseInt(process.env.DEPOSIT_SOL_THRESHOLD_LAMPORTS || '500000000'); // 0.5 SOL
const DEFAULT_EPOCH_AMOUNT = parseInt(process.env.DEFAULT_EPOCH_AMOUNT || '0');

function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return sharedWithRetry(fn, label, KEEPER_RETRY_BASE_MS);
}

function distributorPDA(distributorProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('distributor')], distributorProgramId);
}

function coreConfigPDA(coreProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], coreProgramId);
}

function roverAuthorityPDA(coreProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], coreProgramId);
}

// ═══ KEEPER ═══

export class MonkeKeeper {
  private connection: Connection;
  private coreProgram: Program;
  private distributorProgram: Program;
  private epochVaultProgram: Program;
  private botKeypair: Keypair;
  private walletService: any;
  private coreProgramId: PublicKey;
  private distributorProgramId: PublicKey;
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
    this.distributorProgram = config.distributorProgram;
    this.epochVaultProgram = config.epochVaultProgram;
    this.botKeypair = config.botKeypair;
    this.walletService = config.walletService;
    this.coreProgramId = config.coreProgramId;
    this.distributorProgramId = config.distributorProgramId;
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
   * 40/40/20 split — 40% to BANK holders, 40% to traders, 20% to bot (Config.bot).
   *
   * Runs once per UTC day:
   *   1. close_rover_wsol    — WSOL ATA → native SOL on rover_authority
   *   2. sweep_rover         — native SOL → 40% bridge_vault + 40% trader_dest + 20% Config.bot
   *   (bridge/PEGGED pipeline retired — SOL distributed directly)
   *   4. open_fee_rovers     — token ATAs → DLMM positions
   *   5. new_epoch           — upload Merkle root + fund distributor vault
   *   6. close_exhausted_rovers — empty rovers → rent reclaimed
   *
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

    // Epoch-miss check — gated on vault having eligible balance. During the
    // magnesium phase of the burn curve, bridge_vault is expected to sit empty,
    // so a pure time-based check fires forever. We only alert when there's
    // actual SOL/BANK sitting undistributed past the staleness threshold.
    try {
      const { detectEpochMiss } = await import('./epoch-computer');
      // Build a transient bank-distributor Program so we can read its state.
      let bankProgram: Program | null = null;
      try {
        const bankIdl = await import('./idl/bank_distributor.json').catch(() => null);
        if (bankIdl) {
          const provider = (this.coreProgram as any).provider;
          bankProgram = new Program(
            (bankIdl as any).default || bankIdl,
            provider,
          );
        }
      } catch { /* bank program optional for miss check */ }
      const report = await detectEpochMiss(this.connection, bankProgram);
      if (report.solStaleHours !== null) {
        const sol = (Number(report.solAvailableLamports) / 1e9).toFixed(4);
        await alertEpochMiss('SOL', report.solStaleHours, `${sol} SOL`);
      }
      if (report.bankStaleHours !== null) {
        const bank = (Number(report.bankDeltaUnits) / 1e6).toFixed(4);
        await alertEpochMiss('BANK', report.bankStaleHours, `${bank} BANK`);
      }
    } catch (e: any) { logger.warn(`[keeper] epoch-miss probe failed: ${e.message?.slice(0, 150)}`); }

    {
      logger.info(`[keeper] ${ts} Running daily fee processing sequence`);

      // Refresh priority fees for this sequence
      this.priorityIxs = await buildKeeperPriorityIxs(this.connection);

      // Step 1: Close WSOL ATA on rover_authority → unwrap to native SOL
      await this.crankCloseRoverWsol();

      // Step 2: Sweep SOL from rover_authority via the burn curve
      //         → burn_sol_vault / trader_dest / Config.bot
      await this.crankSweepRover();

      // Step 2a: Open buy-side DLMM bids on CRANK/SOL from burn_sol_vault
      await this.crankOpenRoverBids();

      // Step 2b: Burn CRANK accumulated on rover (from filled bids + direct CRANK fees),
      //          forward minted BANK to bank-distributor vault
      await this.crankRoverBurnAndMint();

      // Step 3: Epoch distribution — SOL tree (bridge_vault) + BANK tree (bank-distributor)
      await this.crankEpochDistribution();

      // Step 4: Open fee rover positions from accumulated token fees (CRANK bypassed)
      await this.crankOpenFeeRovers();

      // Step 5: Close exhausted rover positions (reclaim rent)
      await this.crankCloseExhaustedRovers();

      // Step 6: Prune the crank role from idle Discord members (best-effort, no-op if unconfigured)
      await this.crankPruneInactiveMembers();

      // Step 7: Refresh in-memory pool supplies from on-chain mint state.
      //         Keeps /buy's mcap→price math honest as CRANK gets burned.
      await this.crankRefreshSupplies();

      // Step 8: Post a daily volume summary to #crank-stats.
      await this.crankDailyStatsPost();

      this.lastRunDay = today;
      this.lastRunTimestamp = Date.now();
      logger.info(`[keeper] ${ts} Daily sequence complete`);
      return 'Processing';
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

  // ─── CRANK: SWEEP ROVER (curve-driven) ───

  /**
   * Sweep SOL from rover_authority via the supply-driven burn curve.
   * Routes to three destinations: burn_sol_vault / trader_dest (bridge_vault) / Config.bot.
   * Shares are computed on-chain from crank_mint.supply + RoverAuthority curve state.
   */
  private async crankSweepRover(): Promise<void> {
    try {
      const { CRANK_MINT } = await import('../packages/core-sdk/constants');
      const { getBurnSolVaultPDA } = await import('../packages/core-sdk/pda');

      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const roverAccount = await this.coreProgram.account.roverAuthority.fetch(roverAuthority);
      const traderDest = roverAccount.traderDest as PublicKey;
      const [burnSolVault] = getBurnSolVaultPDA();

      await withRetry(
        () => this.coreProgram.methods
          .sweepRover()
          .accounts({
            caller: this.botKeypair.publicKey,
            config: coreConfigPDA(this.coreProgramId)[0],
            roverAuthority,
            crankMint: CRANK_MINT,
            burnSolVault,
            traderDest,
            botDest: this.botKeypair.publicKey,
          })
          .preInstructions(this.priorityIxs)
          .signers([this.botKeypair])
          .rpc(),
        'sweep_rover'
      );

      logger.info('  [keeper] ✓ sweep_rover — curve-driven split (burn / trader / protocol)');
    } catch (e: any) {
      const code = e.error?.errorCode?.code;
      if (code === 'NothingToSweep') {
        logger.info('  [keeper] sweep_rover skipped — nothing to sweep');
      } else if (code === 'BurnCurveNotInitialized') {
        logger.warn('  [keeper] sweep_rover skipped — burn curve not initialized (run init-burn-curve.ts)');
      } else {
        logger.warn(`[keeper] sweep_rover error: ${e.message}`);
      }
    }
  }

  // ─── CRANK: OPEN ROVER BIDS ───

  /**
   * Wrap SOL from burn_sol_vault to rover WSOL ATA, sync_native, open buy-side
   * BidAsk DLMM position on CRANK/SOL below active. One transaction composed of:
   *   ix 1: wrap_burn_sol
   *   ix 2: spl_token::sync_native
   *   ix 3: open_rover_bid_position (in a follow-up tx — CU budget)
   *
   * Skipped if burn_sol_vault balance < ROVER_BID_MIN_LAMPORTS.
   */
  private async crankOpenRoverBids(): Promise<void> {
    try {
      const {
        ROVER_BID_BIN_COUNT,
        ROVER_BID_MIN_LAMPORTS,
        ROVER_BID_RESERVE_LAMPORTS,
        CRANK_MINT,
        NATIVE_MINT,
      } = await import('../packages/core-sdk/constants');
      const { getBurnSolVaultPDA } = await import('../packages/core-sdk/pda');
      const {
        getAssociatedTokenAddressSync,
        createAssociatedTokenAccountIdempotentInstruction,
        createSyncNativeInstruction,
        TOKEN_PROGRAM_ID: SPL_TOKEN_ID,
      } = await import('@solana/spl-token');
      const { Keypair: SolKeypair } = await import('@solana/web3.js');
      const { BN } = await import('@coral-xyz/anchor');
      const { loadPoolRegistry } = await import('../packages/core-sdk/pool-config');

      const [burnSolVault] = getBurnSolVaultPDA();
      const burnSolVaultInfo = await this.connection.getAccountInfo(burnSolVault);
      if (!burnSolVaultInfo) {
        logger.info('  [keeper] open_rover_bids skipped — burn_sol_vault not initialized');
        return;
      }
      const available = BigInt(burnSolVaultInfo.lamports) - ROVER_BID_RESERVE_LAMPORTS;
      const minLamports = BigInt(process.env.ROVER_BID_MIN_LAMPORTS || ROVER_BID_MIN_LAMPORTS.toString());
      if (available < minLamports) {
        logger.info({ available: available.toString(), min: minLamports.toString() }, '[keeper] open_rover_bids — below threshold, waiting');
        return;
      }

      // Resolve the CRANK/SOL pool from curator.json — prefer binStep 80.
      const registry = loadPoolRegistry();
      const pool = registry.find((p: any) =>
        ((p.mintX === CRANK_MINT.toBase58() && p.mintY === NATIVE_MINT.toBase58()) ||
         (p.mintY === CRANK_MINT.toBase58() && p.mintX === NATIVE_MINT.toBase58()))
        && p.binStep === 80
      );
      if (!pool) {
        logger.warn('  [keeper] open_rover_bids skipped — CRANK/SOL binStep-80 pool not in curator.json');
        return;
      }

      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const roverWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, roverAuthority, true, SPL_TOKEN_ID);

      // Step A: wrap_burn_sol + sync_native in one tx
      const wrapAmount = available;
      const wrapTx = new Transaction();
      wrapTx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: KEEPER_PRIORITY_FEE_FLOOR }),
      );
      // Create WSOL ATA if missing (idempotent)
      wrapTx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          this.botKeypair.publicKey, roverWsolAta, roverAuthority, NATIVE_MINT, SPL_TOKEN_ID,
        ),
      );
      const wrapIx = await this.coreProgram.methods
        .wrapBurnSol(new BN(wrapAmount.toString()))
        .accounts({
          caller: this.botKeypair.publicKey,
          config: coreConfigPDA(this.coreProgramId)[0],
          roverAuthority,
          burnSolVault,
          roverWsolAccount: roverWsolAta,
        })
        .instruction();
      wrapTx.add(wrapIx);
      wrapTx.add(createSyncNativeInstruction(roverWsolAta, SPL_TOKEN_ID));

      await withRetry(
        () => sendAndConfirmTransaction(this.connection, wrapTx, [this.botKeypair]),
        'wrap_burn_sol+sync_native',
      );
      logger.info(`  [keeper] ✓ wrap_burn_sol — ${wrapAmount} lamports wrapped on rover WSOL ATA`);

      // Step B: open_rover_bid_position (separate tx — CU budget)
      const lbPair = new PublicKey(pool.address);
      const dlmm = await getDLMM(this.connection, lbPair);
      await dlmm.refetchStates();
      const activeId = dlmm.lbPair.activeId;
      const binStep = dlmm.lbPair.binStep;

      const meteoraPosition = SolKeypair.generate();
      const width = Math.min(ROVER_BID_BIN_COUNT, Math.max(1, Math.floor(6931 / binStep)));
      const maxBinId = activeId - 1;
      const minBinId = maxBinId - width + 1;
      const binIds = Array.from({ length: width }, (_, i) => minBinId + i);
      const fakePos = { publicKey: meteoraPosition.publicKey };
      const meteora = buildMeteoraCPIAccounts(dlmm, fakePos, binIds);

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), meteoraPosition.publicKey.toBuffer()],
        this.coreProgramId,
      );
      const vaultTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
      const vaultTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
      const createVaultAtaX = createAssociatedTokenAccountIdempotentInstruction(
        this.botKeypair.publicKey, vaultTokenX, vaultPda, meteora.tokenXMint, meteora.tokenXProgram,
      );
      const createVaultAtaY = createAssociatedTokenAccountIdempotentInstruction(
        this.botKeypair.publicKey, vaultTokenY, vaultPda, meteora.tokenYMint, meteora.tokenYProgram,
      );

      const openTx = await this.coreProgram.methods
        .openRoverBidPosition(new BN(wrapAmount.toString()), binStep)
        .accounts({
          bot: this.botKeypair.publicKey,
          config: coreConfigPDA(this.coreProgramId)[0],
          roverAuthority,
          roverWsolAccount: roverWsolAta,
          lbPair,
          meteoraPosition: meteoraPosition.publicKey,
          binArrayBitmapExt: meteora.binArrayBitmapExt,
          reserveX: meteora.reserveX,
          reserveY: meteora.reserveY,
          binArrayLower: meteora.binArrayLower,
          binArrayUpper: meteora.binArrayUpper,
          position: PublicKey.findProgramAddressSync(
            [Buffer.from('position'), meteoraPosition.publicKey.toBuffer()],
            this.coreProgramId,
          )[0],
          vault: vaultPda,
          vaultTokenX,
          vaultTokenY,
          tokenXMint: meteora.tokenXMint,
          tokenYMint: meteora.tokenYMint,
          tokenXProgram: meteora.tokenXProgram,
          tokenYProgram: meteora.tokenYProgram,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: meteora.eventAuthority, isSigner: false, isWritable: false },
          { pubkey: meteora.dlmmProgram, isSigner: false, isWritable: false },
        ])
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: KEEPER_PRIORITY_FEE_FLOOR }),
          fixBitmapWritable(meteora.binArrayBitmapExt),
          createVaultAtaX,
          createVaultAtaY,
        ])
        .signers([this.botKeypair, meteoraPosition])
        .transaction();

      await withRetry(
        () => sendAndConfirmTransaction(this.connection, openTx, [this.botKeypair, meteoraPosition]),
        'open_rover_bid_position',
      );
      logger.info(
        `  [keeper] ✓ open_rover_bid_position — ${width} bins [${minBinId},${maxBinId}] SOL=${wrapAmount}`,
      );
    } catch (e: any) {
      logger.warn(`[keeper] open_rover_bids error: ${e.message?.slice(0, 180)}`);
    }
  }

  // ─── CRANK: ROVER BURN AND MINT (CRANK → BANK) ───

  /**
   * Burn CRANK accumulated on rover_authority (from filled bids + direct CRANK
   * fees) and forward the minted BANK to the bank-distributor vault.
   * No-op if rover's CRANK ATA balance is zero.
   */
  private async crankRoverBurnAndMint(): Promise<void> {
    try {
      const { CRANK_MINT, BANK_MINT, BANK_MINT_PROGRAM_ID } = await import('../packages/core-sdk/constants');
      const { getBankConfigPDA, getBankDistributorPDA } = await import('../packages/core-sdk/pda');
      const {
        getAssociatedTokenAddressSync,
        createAssociatedTokenAccountIdempotentInstruction,
        TOKEN_PROGRAM_ID: SPL_TOKEN_ID,
      } = await import('@solana/spl-token');
      const { BN } = await import('@coral-xyz/anchor');

      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const [bankConfig] = getBankConfigPDA();
      const [bankDistributor] = getBankDistributorPDA();

      const roverCrankAta = getAssociatedTokenAddressSync(CRANK_MINT, roverAuthority, true, SPL_TOKEN_ID);
      const roverBankAta = getAssociatedTokenAddressSync(BANK_MINT, roverAuthority, true, SPL_TOKEN_ID);
      // Non-custodial path: forward minted BANK directly to the bank-distributor
      // vault (PDA-owned). new_epoch then reads the vault balance delta and
      // publishes the root without any further transfer. Nothing touches the
      // bot wallet's BANK ATA.
      const bankDistributorVaultAta = getAssociatedTokenAddressSync(
        BANK_MINT, bankDistributor, true, SPL_TOKEN_ID,
      );

      // Check rover CRANK balance
      const crankAcc = await this.connection.getAccountInfo(roverCrankAta);
      if (!crankAcc || crankAcc.data.length < 72) {
        logger.info('  [keeper] rover_burn_and_mint skipped — no rover CRANK ATA');
        return;
      }
      const amount = crankAcc.data.readBigUInt64LE(64);
      if (amount === 0n) {
        logger.info('  [keeper] rover_burn_and_mint skipped — rover CRANK balance is 0');
        return;
      }

      // Idempotent ATA setup: rover's BANK ATA (where bank-mint's mint_to
      // lands, per its `authority = user` constraint — rover signs as user).
      // The distributor vault ATA was created during init-burn-curve.
      const preIxs = [
        ...this.priorityIxs,
        createAssociatedTokenAccountIdempotentInstruction(
          this.botKeypair.publicKey, roverBankAta, roverAuthority, BANK_MINT, SPL_TOKEN_ID,
        ),
      ];

      await withRetry(
        () => this.coreProgram.methods
          .roverBurnAndMint(new BN(amount.toString()))
          .accounts({
            caller: this.botKeypair.publicKey,
            config: coreConfigPDA(this.coreProgramId)[0],
            roverAuthority,
            bankConfig,
            crankMint: CRANK_MINT,
            bankMint: BANK_MINT,
            roverCrankAta,
            roverBankAta,
            bankDistributorVault: bankDistributorVaultAta,
            crankTokenProgram: SPL_TOKEN_ID,
            bankTokenProgram: SPL_TOKEN_ID,
            bankMintProgram: BANK_MINT_PROGRAM_ID,
          })
          .preInstructions(preIxs)
          .signers([this.botKeypair])
          .rpc(),
        'rover_burn_and_mint',
      );

      logger.info(`  [keeper] ✓ rover_burn_and_mint — burned ${amount} CRANK, BANK forwarded directly to bank-distributor vault`);
    } catch (e: any) {
      logger.warn(`[keeper] rover_burn_and_mint error: ${e.message?.slice(0, 180)}`);
    }
  }

  // ─── CRANK: CLOSE ROVER WSOL ───

  /**
   * Close the WSOL ATA on rover_authority, unwrapping to native SOL.
   * Must run before sweep_rover so the unwrapped SOL gets swept to dist_pool.
   */
  private async crankCloseRoverWsol(): Promise<void> {
    try {
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
      const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, roverAuthority, true);

      // Check if the WSOL ATA exists and has balance
      const accountInfo = await this.connection.getAccountInfo(wsolAta);
      if (!accountInfo) {
        logger.info('  [keeper] close_rover_wsol skipped — no WSOL ATA');
        return;
      }

      // Parse SPL token account data: amount is at byte offset 64, 8 bytes LE
      const data = accountInfo.data;
      if (data.length < 72) {
        logger.info('  [keeper] close_rover_wsol skipped — invalid token account data');
        return;
      }
      const amount = data.readBigUInt64LE(64);
      if (amount === 0n) {
        logger.info('  [keeper] close_rover_wsol skipped — WSOL balance is 0');
        return;
      }

      logger.info(`  [keeper] Closing WSOL ATA on rover_authority (${amount} lamports wrapped)`);

      await withRetry(
        () => this.coreProgram.methods
          .closeRoverTokenAccount()
          .accounts({
            caller: this.botKeypair.publicKey,
            roverAuthority,
            tokenAccount: wsolAta,
            tokenProgram: TOKEN_PROGRAM,
          })
          .preInstructions(this.priorityIxs)
          .signers([this.botKeypair])
          .rpc(),
        'close_rover_wsol'
      );

      logger.info('  [keeper] ✓ close_rover_wsol — WSOL unwrapped to native SOL');
    } catch (e: any) {
      // Non-fatal — SOL just stays wrapped until next crank
      logger.warn(`[keeper] close_rover_wsol error: ${e.message?.slice(0, 120)}`);
    }
  }

  // ─── SANCTUM POOL EPOCH UPDATE ───


  // ─── CRANK: OPEN FEE ROVERS ───

  /**
   * Open BidAskImBalanced DLMM positions from accumulated token fees in rover_authority ATAs.
   * Skips mints in DIRECT_SWAP_MINTS (excluded from rover recycling).
   * Skips balances below MIN_FEE_ROVER_VALUE.
   */
  private async crankOpenFeeRovers(): Promise<void> {
    try {
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID: SPL_TOKEN_ID, createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
      const { Keypair: SolKeypair } = await import('@solana/web3.js');
      const { BN } = await import('@coral-xyz/anchor');

      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const [configPDA] = coreConfigPDA(this.coreProgramId);

      const DIRECT_SWAP_MINTS = (process.env.DIRECT_SWAP_MINTS || '').split(',').filter(Boolean);
      // Value-based threshold (USD). Dust below this accumulates in rover_authority
      // ATAs instead of burning gas on sub-economic rover deployments.
      const MIN_FEE_ROVER_USD = parseFloat(process.env.MIN_FEE_ROVER_USD || '10');
      // Minimum USD per bin — concentrate liquidity so each bin is meaningful.
      // $10 → 1 bin, $50 → 5 bins, $100 → 10 bins.
      const FEE_ROVER_BIN_USD = parseFloat(process.env.FEE_ROVER_BIN_USD || '10');

      // Fetch all token accounts owned by rover_authority (SPL + Token-2022)
      const [spl, t22] = await Promise.all([
        this.connection.getParsedTokenAccountsByOwner(roverAuthority, { programId: SPL_TOKEN_ID }),
        this.connection.getParsedTokenAccountsByOwner(roverAuthority, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);
      const allAccounts = [...spl.value, ...t22.value];

      // Whitelist: only open rovers for mints that appear in curator.json pools.
      // Prevents airdrop spam from burning rent on random DLMM pools.
      const { loadPoolRegistry } = await import('../packages/core-sdk/pool-config');
      const curatorPools = loadPoolRegistry();
      const allowedMints = new Set<string>();
      for (const pool of curatorPools) {
        if (pool.mintX) allowedMints.add(pool.mintX);
        if (pool.mintY) allowedMints.add(pool.mintY);
      }

      // CRANK is handled separately by crankRoverBurnAndMint — never sell CRANK fees for SOL.
      const { CRANK_MINT: CRANK_MINT_CONST } = await import('../packages/core-sdk/constants');
      const CRANK_MINT_STR = CRANK_MINT_CONST.toBase58();

      for (const account of allAccounts) {
        const parsed = account.account.data.parsed;
        const balance = parsed.info.tokenAmount.uiAmount;
        if (!balance || balance <= 0) continue;

        const mintStr = parsed.info.mint;
        const mint = new PublicKey(mintStr);
        const tokenProgramId = account.account.owner;

        if (mintStr === CRANK_MINT_STR) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] Skipping fee rover — CRANK burns via rover_burn_and_mint');
          continue;
        }

        if (!allowedMints.has(mintStr)) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] Skipping fee rover — mint not in curator.json');
          continue;
        }

        if (DIRECT_SWAP_MINTS.includes(mintStr)) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] Skipping fee rover — DIRECT_SWAP_MINTS');
          continue;
        }

        // Defense-in-depth: skip Token-2022 tokens with transfer hooks.
        // Meteora CPI uses empty_hooks() — hook-bearing tokens lock rent permanently.
        if (await hasTransferHook(this.connection, mint)) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] Skipping fee rover — Token-2022 transfer hook detected');
          continue;
        }

        // Find the curator pool config for this mint (source of truth for decimals + lbPair)
        const poolConfig = curatorPools.find((p: any) => p.mintX === mintStr || p.mintY === mintStr);
        if (!poolConfig) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] No known pool for fee token — skipping');
          continue;
        }
        const decimals = poolConfig.mintX === mintStr ? poolConfig.decimalsX : poolConfig.decimalsY;
        const lbPair = new PublicKey(poolConfig.address);
        const rawAmount = BigInt(parsed.info.tokenAmount.amount);

        // Value-based threshold: price from on-chain reserves (PumpSwap AMM).
        // Each pool in curator.json must have a pumpswapPool address.
        // Price = quoteReserve / baseReserve × SOL/USD (Pyth).
        if (!poolConfig.pumpswapPool) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] Fee rover skipped — no pumpswapPool configured');
          continue;
        }
        let priceUsd: number | null = null;
        try {
          const pumpAcc = await this.connection.getAccountInfo(new PublicKey(poolConfig.pumpswapPool));
          if (!pumpAcc || pumpAcc.data.length < 203) throw new Error('PumpSwap account missing or too small');
          const baseVault = new PublicKey(pumpAcc.data.slice(139, 171));
          const quoteVault = new PublicKey(pumpAcc.data.slice(171, 203));
          const [baseBal, quoteBal] = await Promise.all([
            this.connection.getTokenAccountBalance(baseVault),
            this.connection.getTokenAccountBalance(quoteVault),
          ]);
          const baseReserve = parseFloat(baseBal.value.uiAmountString || '0');
          const quoteReserve = parseFloat(quoteBal.value.uiAmountString || '0');
          if (baseReserve <= 0 || quoteReserve <= 0) throw new Error('Empty reserves');
          const priceInSol = quoteReserve / baseReserve;
          const solPrice = await fetchDexScreenerPrice('So11111111111111111111111111111111111111112');
          if (!solPrice) throw new Error('No SOL/USD price');
          priceUsd = priceInSol * solPrice.priceUsd;
        } catch (e: any) {
          logger.warn({ err: e.message, mint: mintStr.slice(0, 8) }, '[keeper] Fee rover skipped — reserve price failed');
          continue;
        }
        const valueUsd = (Number(rawAmount) / 10 ** decimals) * priceUsd;
        if (valueUsd < MIN_FEE_ROVER_USD) {
          logger.info(
            { mint: mintStr.slice(0, 8), valueUsd: valueUsd.toFixed(2), threshold: MIN_FEE_ROVER_USD },
            '[keeper] Fee rover below USD floor — accumulating'
          );
          continue;
        }

        logger.info(
          { mint: mintStr.slice(0, 8), balance, valueUsd: valueUsd.toFixed(2), pool: lbPair.toBase58().slice(0, 8) },
          '[keeper] Opening fee rover position'
        );

        try {
          const dlmm = await getDLMM(this.connection, lbPair);
          await dlmm.refetchStates();
          const activeId = dlmm.lbPair.activeId;
          const binStep = dlmm.lbPair.binStep;

          // Generate new Meteora position keypair
          const meteoraPosition = SolKeypair.generate();

          // Adaptive bin width — 1 bin per $FEE_ROVER_BIN_USD of token value.
          // Concentrate liquidity: $10 → 3 bins, not 20.
          const maxWidth = Math.min(70, Math.max(1, Math.floor(6931 / binStep)));
          const width = Math.max(1, Math.min(maxWidth, Math.floor(valueUsd / FEE_ROVER_BIN_USD)));
          const minBinId = activeId + 1;
          const maxBinId = minBinId + width - 1;

          // Build Meteora CPI accounts using a fake meteoraPos object
          // (we just need the publicKey for the position)
          const fakePos = { publicKey: meteoraPosition.publicKey };
          const binIds = Array.from({ length: width }, (_, i) => minBinId + i);
          const meteora = buildMeteoraCPIAccounts(dlmm, fakePos, binIds);

          // Derive vault PDA
          const [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vault'), meteoraPosition.publicKey.toBuffer()],
            this.coreProgramId
          );

          // Vault ATAs for both token X and token Y
          const vaultTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
          const vaultTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
          const createVaultAtaX = createAssociatedTokenAccountIdempotentInstruction(
            this.botKeypair.publicKey, vaultTokenX, vaultPda, meteora.tokenXMint, meteora.tokenXProgram,
          );
          const createVaultAtaY = createAssociatedTokenAccountIdempotentInstruction(
            this.botKeypair.publicKey, vaultTokenY, vaultPda, meteora.tokenYMint, meteora.tokenYProgram,
          );

          const amountBN = new BN(rawAmount.toString());

          await withRetry(
            async () => {
              const ix = await this.coreProgram.methods
                .openFeeRover(amountBN, binStep)
                .accounts({
                  bot:                  this.botKeypair.publicKey,
                  config:               configPDA,
                  roverAuthority,
                  lbPair,
                  meteoraPosition:      meteoraPosition.publicKey,
                  binArrayBitmapExt:    meteora.binArrayBitmapExt,
                  reserveX:             meteora.reserveX,
                  reserveY:             meteora.reserveY,
                  binArrayLower:        meteora.binArrayLower,
                  binArrayUpper:        meteora.binArrayUpper,
                  position:             PublicKey.findProgramAddressSync(
                    [Buffer.from('position'), meteoraPosition.publicKey.toBuffer()],
                    this.coreProgramId
                  )[0],
                  vault:                vaultPda,
                  roverTokenAccount:    account.pubkey,
                  vaultTokenX,
                  vaultTokenY,
                  tokenXMint:           meteora.tokenXMint,
                  tokenYMint:           meteora.tokenYMint,
                  tokenXProgram:        meteora.tokenXProgram,
                  tokenYProgram:        meteora.tokenYProgram,
                  systemProgram:        new PublicKey('11111111111111111111111111111111'),
                })
                .remainingAccounts([
                  { pubkey: meteora.eventAuthority, isWritable: false, isSigner: false },
                  { pubkey: meteora.dlmmProgram, isWritable: false, isSigner: false },
                ])
                .instruction();
              fixBitmapWritable(ix, meteora.binArrayBitmapExt);
              const tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
                this.priorityIxs[1],
                createVaultAtaX,
                createVaultAtaY,
                ix,
              );
              tx.feePayer = this.botKeypair.publicKey;
              const bh = await this.connection.getLatestBlockhash();
              tx.recentBlockhash = bh.blockhash;
              tx.sign(this.botKeypair, meteoraPosition);
              const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
              await confirmAndCheck(this.connection, sig, bh.blockhash, bh.lastValidBlockHeight);
              return sig;
            },
            `open_fee_rover ${mintStr.slice(0, 8)}`
          );

          logger.info(`  ✓ Fee rover opened for ${mintStr.slice(0, 8)} — ${width} bins [${minBinId},${maxBinId}]`);
        } catch (e: any) {
          logger.warn({ mint: mintStr.slice(0, 8), error: e.message }, '[keeper] Failed to open fee rover');
        }

        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e: any) {
      logger.warn(`[keeper] crankOpenFeeRovers error: ${e.message}`);
    }
  }

  // ─── CRANK: NEW EPOCH (Merkle distributor) ───

  /**
   * Epoch distribution: drain vault → WSOL → Merkle tree → auto-claim.
   * Replaces the old stake_and_forward + new_epoch + $PEGGED pipeline.
   */
  private async crankEpochDistribution(): Promise<void> {
    // SOL tree — existing flow (bridge_vault → WSOL → merkle_distributor)
    try {
      const { runEpoch } = await import('./epoch-computer');
      const result = await runEpoch({
        connection: this.connection,
        botKeypair: this.botKeypair,
        walletService: this.walletService,
        epochVaultProgram: this.epochVaultProgram,
        distributorProgram: this.distributorProgram,
      });
      if (result.ran && result.epoch != null && result.amountSol != null && result.userCount != null) {
        await alertEpochSuccess(result.epoch, result.amountSol, result.userCount);
      }
    } catch (e: any) {
      logger.warn(`[keeper] SOL epoch error: ${e.message?.slice(0, 150)}`);
    }

    // BANK tree — new flow (bot BANK ATA → bank_distributor)
    try {
      const { runBankEpoch } = await import('./epoch-computer');
      // Build bank-distributor Program lazily — avoids construction cost when skipped
      const { Program: AnchorProgram } = await import('@coral-xyz/anchor');
      const bankIdl = await import('./idl/bank_distributor.json').catch(() => null);
      if (!bankIdl) {
        logger.info('  [keeper] BANK epoch skipped — bank_distributor IDL not found');
        return;
      }
      const provider = (this.coreProgram as any).provider;
      const bankProgram = new AnchorProgram(
        (bankIdl as any).default || bankIdl,
        provider,
      );
      const bankResult = await runBankEpoch({
        connection: this.connection,
        botKeypair: this.botKeypair,
        walletService: this.walletService,
        bankDistributorProgram: bankProgram,
      });
      if (bankResult.ran) {
        logger.info(`  [keeper] ✓ BANK epoch ${bankResult.epoch} — ${bankResult.amountSol} BANK to ${bankResult.userCount} users`);
      }
    } catch (e: any) {
      logger.warn(`[keeper] BANK epoch error: ${e.message?.slice(0, 180)}`);
    }
  }

  // ─── CRANK: CLOSE EXHAUSTED ROVERS ───

  /**
   * Close rover positions where all bins are empty (fully converted + harvested).
   * Rent refund goes to rover_authority → swept via sweep_rover (40/40/20 split).
   */
  private async crankCloseExhaustedRovers(): Promise<void> {
    try {
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID: SPL_TOKEN_ID, createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');

      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const [configPDA] = coreConfigPDA(this.coreProgramId);
      const roverAuthorityKey = roverAuthority.toBase58();

      const positions = await this.coreProgram.account.position.all();
      // New PDA-vault Position struct uses userVault (rover positions set it to
      // rover_authority). Optional chaining in case any legacy struct slips through.
      const roverPositions = positions.filter(
        (p: any) => (p.account.userVault as PublicKey | undefined)?.toBase58() === roverAuthorityKey
      );

      if (roverPositions.length === 0) {
        logger.info('  [keeper] No rover positions to check');
        return;
      }

      logger.info(`  [keeper] Checking ${roverPositions.length} rover positions for exhaustion`);

      let closed = 0;

      // Group by pool
      const byPool = new Map<string, Array<{ publicKey: PublicKey; account: any }>>();
      for (const pos of roverPositions) {
        const poolKey = (pos.account.lbPair as PublicKey).toBase58();
        if (!byPool.has(poolKey)) byPool.set(poolKey, []);
        byPool.get(poolKey)!.push(pos as any);
      }

      for (const [poolKey, poolPositions] of byPool) {
        try {
          const dlmm = await getDLMM(this.connection, new PublicKey(poolKey));
          const { userPositions } = await dlmm.getPositionsByUserAndLbPair(roverAuthority);

          for (const pos of poolPositions) {
            const data = pos.account as any;
            const meteoraPosKey = data.meteoraPosition as PublicKey;
            const match = userPositions.find((p: any) => p.publicKey.equals(meteoraPosKey));

            if (!match) continue; // Meteora position already gone

            const binData = match.positionData.positionBinData;
            const allEmpty = binData.every((b: any) =>
              BigInt(b.positionXAmount) === 0n && BigInt(b.positionYAmount) === 0n
            );

            // Close dust rovers — mostly converted, tail dust remaining.
            let isDust = false;
            if (!allEmpty) {
              const totalX = binData.reduce((sum: bigint, b: any) => sum + BigInt(b.positionXAmount), 0n);
              const initialAmount = BigInt((data.initialAmount as any)?.toString() || '0');
              if (initialAmount > 0n && totalX * 100n / initialAmount < 5n) {
                isDust = true;
                logger.info(
                  { position: pos.publicKey.toBase58().slice(0, 8), remaining: totalX.toString(), initial: initialAmount.toString() },
                  '[keeper] Rover is dust (<5% remaining) — closing'
                );
              }
            }

            if (!allEmpty && !isDust) continue;

            logger.info(`  [keeper] Closing exhausted rover: ${pos.publicKey.toBase58().slice(0, 8)}`);

            try {
              const allBinIds = binData.map((b: any) => b.binId);
              const meteora = buildMeteoraCPIAccounts(dlmm, match, allBinIds);

              // Derive vault PDA
              const [vaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('vault'), meteoraPosKey.toBuffer()],
                this.coreProgramId
              );

              // Derive ATAs
              const vaultTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
              const vaultTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
              const ownerTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, roverAuthority, true, meteora.tokenXProgram);
              const ownerTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, roverAuthority, true, meteora.tokenYProgram);
              const roverFeeTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, roverAuthority, true, meteora.tokenXProgram);
              const roverFeeTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, roverAuthority, true, meteora.tokenYProgram);

              await withRetry(
                async () => {
                  const ix = await this.coreProgram.methods
                    .closePosition()
                    .accounts({
                      bot:                this.botKeypair.publicKey,
                      config:             configPDA,
                      position:           pos.publicKey,
                      vault:              vaultPda,
                      owner:              roverAuthority,
                      meteoraPosition:    meteoraPosKey,
                      lbPair:             meteora.lbPair,
                      binArrayBitmapExt:  meteora.binArrayBitmapExt,
                      binArrayLower:      meteora.binArrayLower,
                      binArrayUpper:      meteora.binArrayUpper,
                      reserveX:           meteora.reserveX,
                      reserveY:           meteora.reserveY,
                      tokenXMint:         meteora.tokenXMint,
                      tokenYMint:         meteora.tokenYMint,
                      eventAuthority:     meteora.eventAuthority,
                      dlmmProgram:        meteora.dlmmProgram,
                      vaultTokenX,
                      vaultTokenY,
                      ownerTokenX,
                      ownerTokenY,
                      roverFeeTokenY,
                      roverAuthority,
                      roverFeeTokenX,
                      tokenXProgram:      meteora.tokenXProgram,
                      tokenYProgram:      meteora.tokenYProgram,
                      memoProgram:        SPL_MEMO_PROGRAM_ID,
                      systemProgram:      new PublicKey('11111111111111111111111111111111'),
                    })
                    .instruction();
                  fixBitmapWritable(ix, meteora.binArrayBitmapExt);
                  const tx = new Transaction().add(...this.priorityIxs, ix);
                  tx.feePayer = this.botKeypair.publicKey;
                  const bh = await this.connection.getLatestBlockhash();
                  tx.recentBlockhash = bh.blockhash;
                  tx.sign(this.botKeypair);
                  const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                  await confirmAndCheck(this.connection, sig, bh.blockhash, bh.lastValidBlockHeight);
                  return sig;
                },
                `close rover ${pos.publicKey.toBase58().slice(0, 8)}`
              );

              logger.info(`  ✓ Closed exhausted rover: ${pos.publicKey.toBase58().slice(0, 8)}`);
              closed++;
            } catch (e: any) {
              logger.warn(`  [keeper] Failed to close rover ${pos.publicKey.toBase58().slice(0, 8)}: ${e.message}`);
            }
          }
        } catch (e: any) {
          logger.warn(`  [keeper] Pool ${poolKey.slice(0, 8)} check error: ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 2000));
      }

      logger.info(`  [keeper] Rover cleanup: ${closed} positions closed`);

      // Compute rover TVL per pool for relay/Recon page
      if (this.onRoverTvlComputed) {
        const tvlEntries: Array<{ pool: string; tvl: number; positionCount: number; status: string }> = [];
        for (const [poolKey, poolPositions] of byPool) {
          tvlEntries.push({
            pool: poolKey,
            tvl: 0, // TODO: compute from bin values via DLMM query
            positionCount: poolPositions.length,
            status: poolPositions.length > 0 ? 'active' : 'exhausted',
          });
        }
        try {
          this.onRoverTvlComputed(tvlEntries);
        } catch (e: any) {
          logger.warn(`[keeper] onRoverTvlComputed callback error: ${e.message}`);
        }
      }
    } catch (e: any) {
      logger.warn(`[keeper] crankCloseExhaustedRovers error: ${e.message}`);
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
