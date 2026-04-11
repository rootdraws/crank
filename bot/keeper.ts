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
import { buildMeteoraCPIAccounts, getDLMM, SPL_MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, hasTransferHook } from './meteora-accounts';
import { fetchDexScreenerPrice } from '../packages/core-sdk/price-source';

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

const MAX_RETRIES = 3;
const BASE_DELAY = 2000;
const DEPOSIT_SOL_THRESHOLD_LAMPORTS = parseInt(process.env.DEPOSIT_SOL_THRESHOLD_LAMPORTS || '500000000'); // 0.5 SOL
const DEFAULT_EPOCH_AMOUNT = parseInt(process.env.DEFAULT_EPOCH_AMOUNT || '0');

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      if (i < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, i);
        logger.warn(`  [keeper retry] ${label} #${i + 1}, ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
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

    // Check for epoch miss (>26 hours since last successful epoch)
    try {
      const { loadEpochState } = await import('./epoch-computer');
      const epochState = loadEpochState();
      if (epochState.lastEpochTimestamp > 0) {
        const hoursSince = (now - epochState.lastEpochTimestamp) / (3600 * 1000);
        if (hoursSince > 26) {
          await alertEpochMiss(hoursSince);
        }
      }
    } catch { /* epoch state file may not exist yet */ }

    {
      logger.info(`[keeper] ${ts} Running daily fee processing sequence`);

      // Refresh priority fees for this sequence
      this.priorityIxs = await buildKeeperPriorityIxs(this.connection);

      // Step 1: Close WSOL ATA on rover_authority → unwrap to native SOL
      await this.crankCloseRoverWsol();

      // Step 2: Sweep SOL from rover_authority → 40/40/20 split
      await this.crankSweepRover();

      // Step 3: Epoch distribution — drain vault → WSOL → Merkle → auto-claim
      await this.crankEpochDistribution();

      // Step 4: Open fee rover positions from accumulated token fees
      await this.crankOpenFeeRovers();

      // Step 5: Close exhausted rover positions (reclaim rent)
      await this.crankCloseExhaustedRovers();

      this.lastRunDay = today;
      this.lastRunTimestamp = Date.now();
      logger.info(`[keeper] ${ts} Daily sequence complete`);
      return 'Processing';
    }
  }

  // ─── CRANK: SWEEP ROVER (SOL) ───

  /**
   * Sweep SOL from rover_authority — 40% bridge_vault (holders), 40% trader_dest (traders), 20% Config.bot (operations).
   */
  private async crankSweepRover(): Promise<void> {
    try {
      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const roverAccount = await this.coreProgram.account.roverAuthority.fetch(roverAuthority);
      const revenueDest = roverAccount.revenueDest as PublicKey;
      const traderDest = roverAccount.traderDest as PublicKey;

      await withRetry(
        () => this.coreProgram.methods
          .sweepRover()
          .accounts({
            caller: this.botKeypair.publicKey,
            config: coreConfigPDA(this.coreProgramId)[0],
            roverAuthority,
            revenueDest,
            traderDest,
            botDest: this.botKeypair.publicKey,
          })
          .preInstructions(this.priorityIxs)
          .signers([this.botKeypair])
          .rpc(),
        'sweep_rover'
      );

      logger.info('  [keeper] ✓ sweep_rover — 40% bridge_vault, 40% trader_dest, 20% bot');
    } catch (e: any) {
      const isNothingToSweep = e.error?.errorCode?.code === 'NothingToSweep';
      if (isNothingToSweep) {
        logger.info('  [keeper] sweep_rover skipped — nothing to sweep');
      } else {
        logger.warn(`[keeper] sweep_rover error: ${e.message}`);
      }
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
      // Adaptive bin width — one bin per $FEE_ROVER_BIN_USD of token value, clamped
      // [5, on-chain max]. Smaller rovers get fewer bins → lower gas footprint.
      const FEE_ROVER_BIN_USD = parseFloat(process.env.FEE_ROVER_BIN_USD || '0.50');

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

      for (const account of allAccounts) {
        const parsed = account.account.data.parsed;
        const balance = parsed.info.tokenAmount.uiAmount;
        if (!balance || balance <= 0) continue;

        const mintStr = parsed.info.mint;
        const mint = new PublicKey(mintStr);
        const tokenProgramId = account.account.owner;

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

        // Value-based threshold: convert raw balance to USD via DexScreener.
        // Skip conservatively if price is unavailable — better to let dust accumulate
        // than burn gas recycling an unpriced amount.
        const priceData = await fetchDexScreenerPrice(mintStr);
        if (!priceData) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] Fee rover skipped — no price data');
          continue;
        }
        const valueUsd = (Number(rawAmount) / 10 ** decimals) * priceData.priceUsd;
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

          // Adaptive bin width — 1 bin per $FEE_ROVER_BIN_USD of token value, clamped
          // [5, on-chain max]. Bigger amounts get full depth; dust gets a tight range.
          const maxWidth = Math.min(70, Math.max(1, Math.floor(6931 / binStep)));
          const width = Math.max(5, Math.min(maxWidth, Math.floor(valueUsd / FEE_ROVER_BIN_USD)));
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
            () => this.coreProgram.methods
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
              .preInstructions([
                ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
                this.priorityIxs[1], // setComputeUnitPrice from cached priority IXs
                createVaultAtaX,
                createVaultAtaY,
              ])
              .signers([this.botKeypair, meteoraPosition])
              .rpc(),
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
      logger.warn(`[keeper] epoch distribution error: ${e.message?.slice(0, 150)}`);
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

            if (!allEmpty) continue;

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
                () => this.coreProgram.methods
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
                  .preInstructions(this.priorityIxs)
                  .signers([this.botKeypair])
                  .rpc(),
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

}
