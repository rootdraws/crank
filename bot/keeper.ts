/**
 * keeper.ts
 *
 * Saturday sequencer for crank.money.
 * 6-step weekly sequence — no phases, no state machine. 50/50 split (holders / bot operations).
 *
 * Saturday sequence:
 *   1. close_rover_wsol    — WSOL ATA → native SOL on rover_authority
 *   2. sweep_rover         — native SOL → bridge_vault (via revenue_dest)
 *   3. stake_and_forward   — bridge: SOL → stake pool → $PEGGED → dist_pool ATA
 *   4. open_fee_rovers     — token ATAs → DLMM positions
 *   5. deposit_pegged      — dist_pool $PEGGED → program_vault $PEGGED → accumulator
 *   6. close_exhausted_rovers — empty rovers → rent reclaimed
 *
 * Plus:
 *   - checkAndDepositPegged — auto-trigger deposit_pegged when dist_pool $PEGGED > threshold
 *     (called after every keeper tick, not just Saturdays)
 *
 * The bot checks hourly (Active) or every 30s (during Saturday processing).
 * Returns 'Active' or 'Processing' to the orchestrator for adaptive interval.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { logger } from './logger';
import { buildMeteoraCPIAccounts, getDLMM, SPL_MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './meteora-accounts';

// Priority fee floor (micro-lamports per compute unit)
const KEEPER_PRIORITY_FEE_FLOOR = 10_000;

/** Build compute budget instructions with dynamic priority fee */
async function buildKeeperPriorityIxs(connection: Connection): Promise<any[]> {
  let microLamports = KEEPER_PRIORITY_FEE_FLOOR;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length > 0) {
      const sorted = fees.map((f: any) => f.prioritizationFee).sort((a: number, b: number) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      microLamports = Math.max(median, KEEPER_PRIORITY_FEE_FLOOR);
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
  monkeProgram: Program;
  bridgeProgram?: Program;
  botKeypair: Keypair;
  coreProgramId: PublicKey;
  monkeProgramId: PublicKey;
  bridgeProgramId?: PublicKey;
  peggedMint?: PublicKey;
  // Optional pool registry from subscriber to avoid position.all() in fee rovers
  getWatchedPools?: () => string[];
}

// ═══ HELPERS ═══

const MAX_RETRIES = 3;
const BASE_DELAY = 2000;
const DEPOSIT_SOL_THRESHOLD_LAMPORTS = parseInt(process.env.DEPOSIT_SOL_THRESHOLD_LAMPORTS || '500000000'); // 0.5 SOL

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

function monkeStatePDA(monkeProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('monke_state')], monkeProgramId);
}

function monkeDistPoolPDA(monkeProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('dist_pool')], monkeProgramId);
}

function monkeProgramVaultPDA(monkeProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('program_vault')], monkeProgramId);
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
  private monkeProgram: Program;
  private bridgeProgram?: Program;
  private botKeypair: Keypair;
  private coreProgramId: PublicKey;
  private monkeProgramId: PublicKey;
  private bridgeProgramId?: PublicKey;
  private peggedMint?: PublicKey;
  // Track last successful Saturday for catch-up logic
  private lastSuccessfulSaturday: number = 0;
  // Cached priority fee instructions (refreshed per Saturday sequence)
  private priorityIxs: any[] = [];
  // Optional pool registry from subscriber
  private getWatchedPools?: () => string[];
  // Relay callback: called with rover TVL data after Saturday cycle
  public onRoverTvlComputed?: (entries: Array<{ pool: string; tvl: number; positionCount: number; status: string }>) => void;

  constructor(config: KeeperConfig) {
    this.connection = config.connection;
    this.coreProgram = config.coreProgram;
    this.monkeProgram = config.monkeProgram;
    this.bridgeProgram = config.bridgeProgram;
    this.botKeypair = config.botKeypair;
    this.coreProgramId = config.coreProgramId;
    this.monkeProgramId = config.monkeProgramId;
    this.bridgeProgramId = config.bridgeProgramId;
    this.peggedMint = config.peggedMint;
    this.getWatchedPools = config.getWatchedPools;
  }

  /**
   * Main entry point. Called by the orchestrator on each keeper tick.
   * 50/50 split — 50% to holders, 50% to bot (Config.bot).
   *
   * On Saturday (or whenever fees have accumulated):
   *   1. close_rover_wsol    — WSOL ATA → native SOL on rover_authority
   *   2. sweep_rover         — native SOL → bridge_vault (via revenue_dest)
   *   3. stake_and_forward   — bridge: SOL → stake pool → $PEGGED → dist_pool ATA
   *   4. open_fee_rovers     — token ATAs → DLMM positions
   *   5. deposit_pegged      — dist_pool $PEGGED → program_vault $PEGGED → accumulator
   *   6. close_exhausted_rovers — empty rovers → rent reclaimed
   *
   * Returns 'Active' or 'Processing' for adaptive interval.
   * The orchestrator uses this to set 1hr vs 30s cadence.
   */
  async runSaturdaySequence(): Promise<string> {
    const ts = new Date().toISOString().slice(0, 19);
    const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 6=Sat

    // Saturday processing + catch-up for missed Saturdays.
    // If bot was down last Saturday, run the sequence on the next available tick.
    const isSaturday = dayOfWeek === 6;
    const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const missedSaturday = this.lastSuccessfulSaturday > 0
      && (Date.now() - this.lastSuccessfulSaturday) > ONE_WEEK_MS;

    if (isSaturday || missedSaturday) {
      const reason = isSaturday ? 'Saturday' : 'catch-up (missed last Saturday)';
      logger.info(`[keeper] ${ts} ${reason} — running fee processing sequence`);

      // Refresh priority fees for this sequence
      this.priorityIxs = await buildKeeperPriorityIxs(this.connection);

      // Step 1: Close WSOL ATA on rover_authority → unwrap to native SOL
      await this.crankCloseRoverWsol();

      // Step 2: Sweep SOL from rover_authority → bridge_vault (via revenue_dest)
      await this.crankSweepRover();

      // Step 3: Stake bridge_vault SOL → $PEGGED → dist_pool ATA
      await this.crankStakeAndForward();

      // Step 4: Open fee rover positions from accumulated token fees
      await this.crankOpenFeeRovers();

      // Step 5: Deposit $PEGGED from dist_pool ATA into monke program vault ATA
      await this.crankDepositPegged();

      // Step 6: Close exhausted rover positions (reclaim rent)
      await this.crankCloseExhaustedRovers();

      this.lastSuccessfulSaturday = Date.now();
      logger.info(`[keeper] ${ts} ${reason} sequence complete`);
      return 'Processing';
    }

    logger.info(`[keeper] ${ts} Active — nothing to crank (not Saturday)`);
    return 'Active';
  }

  // ─── CRANK: SWEEP ROVER (SOL) ───

  /**
   * Sweep SOL from rover_authority — 50% to bridge_vault (holders), 50% to bot (operations).
   */
  private async crankSweepRover(): Promise<void> {
    try {
      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const roverAccount = await this.coreProgram.account.roverAuthority.fetch(roverAuthority);
      const revenueDest = roverAccount.revenueDest as PublicKey;

      await withRetry(
        () => this.coreProgram.methods
          .sweepRover()
          .accounts({
            caller: this.botKeypair.publicKey,
            config: coreConfigPDA(this.coreProgramId)[0],
            roverAuthority,
            revenueDest,
            botDest: this.botKeypair.publicKey,
          })
          .preInstructions(this.priorityIxs)
          .signers([this.botKeypair])
          .rpc(),
        'sweep_rover'
      );

      logger.info('  [keeper] ✓ sweep_rover — 50% to dist_pool, 50% to bot');
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

  // ─── CRANK: STAKE AND FORWARD ($PEGGED bridge) ───

  /**
   * Crank the bridge: stake SOL in bridge_vault → SPL stake pool → $PEGGED → dist_pool ATA.
   * Permissionless — anyone can call. Requires bridge program to be configured.
   */
  private async crankStakeAndForward(): Promise<void> {
    if (!this.bridgeProgram || !this.bridgeProgramId) {
      logger.info('  [keeper] stake_and_forward skipped — bridge program not configured');
      return;
    }

    try {
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');

      const [bridgeConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('bridge_config')], this.bridgeProgramId
      );
      const [bridgeVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('bridge_vault')], this.bridgeProgramId
      );

      // Check if bridge vault has enough SOL to stake
      const vaultBalance = await this.connection.getBalance(bridgeVault);
      const rent = 890880;
      const available = vaultBalance - rent;
      if (available < 10_000_000) { // MIN_STAKE_LAMPORTS
        logger.info(`  [keeper] stake_and_forward skipped — bridge vault has ${available / 1e9} SOL (< 0.01)`);
        return;
      }

      // Fetch bridge config to get stake pool details
      const config = await (this.bridgeProgram.account as any).bridgeConfig.fetch(bridgeConfig);
      const stakePool = config.stakePool as PublicKey;
      const peggedMint = config.peggedMint as PublicKey;
      const distPoolPeggedAta = config.distPoolPeggedAta as PublicKey;

      // Derive stake pool withdraw authority PDA
      const SPL_STAKE_POOL_PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY');
      const [withdrawAuthority] = PublicKey.findProgramAddressSync(
        [stakePool.toBuffer(), Buffer.from('withdraw')],
        SPL_STAKE_POOL_PROGRAM
      );

      // Bridge vault's $PEGGED ATA
      const bridgePeggedAta = getAssociatedTokenAddressSync(peggedMint, bridgeVault, true);

      // Read stake pool state for reserve_stake and manager_fee_account
      const stakePoolInfo = await this.connection.getAccountInfo(stakePool);
      if (!stakePoolInfo || stakePoolInfo.data.length < 300) {
        logger.warn('  [keeper] stake_and_forward error: could not read stake pool state');
        return;
      }
      // SPL stake pool layout offsets (Borsh, v5+):
      //   account_type(1) + manager(32) + staker(32) + stake_deposit_authority(32)
      //   + stake_withdraw_bump(1) + validator_list(32) + reserve_stake(32) = end 162
      //   pool_mint(32) = end 194, manager_fee_account(32) = end 226
      const data = stakePoolInfo.data;
      const reserveStake = new PublicKey(data.subarray(130, 162));
      const managerFeeAccount = new PublicKey(data.subarray(194, 226));

      await withRetry(
        () => this.bridgeProgram!.methods
          .stakeAndForward()
          .accounts({
            crank:                       this.botKeypair.publicKey,
            config:                      bridgeConfig,
            bridgeVault:                 bridgeVault,
            bridgePeggedAta:             bridgePeggedAta,
            distPoolPeggedAta:           distPoolPeggedAta,
            peggedMint:                  peggedMint,
            stakePool:                   stakePool,
            stakePoolWithdrawAuthority:  withdrawAuthority,
            reserveStake:                reserveStake,
            managerFeeAccount:           managerFeeAccount,
            stakePoolProgram:            SPL_STAKE_POOL_PROGRAM,
            tokenProgram:                new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
            systemProgram:               SystemProgram.programId,
          })
          .preInstructions(this.priorityIxs)
          .signers([this.botKeypair])
          .rpc(),
        'stake_and_forward'
      );

      logger.info(`  [keeper] ✓ stake_and_forward — ${available / 1e9} SOL staked → $PEGGED → dist_pool`);
    } catch (e: any) {
      const isNothingToStake = e.error?.errorCode?.code === 'NothingToStake';
      if (isNothingToStake) {
        logger.info('  [keeper] stake_and_forward skipped — nothing to stake');
      } else {
        logger.warn(`[keeper] stake_and_forward error: ${e.message}`);
      }
    }
  }

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
      const MIN_FEE_ROVER_VALUE = parseInt(process.env.MIN_FEE_ROVER_VALUE || '50000000'); // 0.05 SOL default

      // Fetch all token accounts owned by rover_authority (SPL + Token-2022)
      const [spl, t22] = await Promise.all([
        this.connection.getParsedTokenAccountsByOwner(roverAuthority, { programId: SPL_TOKEN_ID }),
        this.connection.getParsedTokenAccountsByOwner(roverAuthority, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);
      const allAccounts = [...spl.value, ...t22.value];

      // We need to know which pool each token trades on. Build mint → pool mapping.
      // Use subscriber's pool registry if available (O(pools) instead of O(positions)).
      // Falls back to position.all() if getWatchedPools not provided (backward compatible).
      const mintToPool = new Map<string, PublicKey>();
      let poolKeys: string[];
      if (this.getWatchedPools) {
        poolKeys = this.getWatchedPools();
      } else {
        // Fallback: dedupe pools from all positions (original behavior)
        const positions = await this.coreProgram.account.position.all();
        const poolSet = new Set<string>();
        for (const pos of positions) {
          poolSet.add((pos.account as any).lbPair.toBase58());
        }
        poolKeys = [...poolSet];
      }
      for (const poolKey of poolKeys) {
        try {
          const dlmm = await getDLMM(this.connection, new PublicKey(poolKey));
          const tokenXMint = dlmm.lbPair.tokenXMint.toBase58();
          mintToPool.set(tokenXMint, new PublicKey(poolKey));
        } catch { /* skip */ }
      }

      for (const account of allAccounts) {
        const parsed = account.account.data.parsed;
        const balance = parsed.info.tokenAmount.uiAmount;
        if (!balance || balance <= 0) continue;

        const mintStr = parsed.info.mint;
        const mint = new PublicKey(mintStr);
        const tokenProgramId = account.account.owner;

        if (DIRECT_SWAP_MINTS.includes(mintStr)) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] Skipping fee rover — DIRECT_SWAP_MINTS');
          continue;
        }

        const rawAmount = BigInt(parsed.info.tokenAmount.amount);
        if (rawAmount < BigInt(MIN_FEE_ROVER_VALUE)) continue;

        // Find the pool for this mint
        const lbPair = mintToPool.get(mintStr);
        if (!lbPair) {
          logger.info({ mint: mintStr.slice(0, 8) }, '[keeper] No known pool for fee token — skipping');
          continue;
        }

        logger.info({ mint: mintStr.slice(0, 8), balance, pool: lbPair.toBase58().slice(0, 8) },
          '[keeper] Opening fee rover position');

        try {
          const dlmm = await getDLMM(this.connection, lbPair);
          await dlmm.refetchStates();
          const activeId = dlmm.lbPair.activeId;
          const binStep = dlmm.lbPair.binStep;

          // Generate new Meteora position keypair
          const meteoraPosition = SolKeypair.generate();

          // Compute bin range (same as on-chain: active_id+1 to +70 max)
          const width = Math.min(70, Math.max(1, Math.floor(6931 / binStep)));
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

  // ─── CRANK: DEPOSIT $PEGGED TO MONKE PROGRAM ───

  /**
   * Single-transaction deposit. Moves all $PEGGED from dist_pool ATA
   * into the program vault ATA and updates the global accumulator.
   * Holders claim their share whenever they want (pull model).
   * O(1) — one tx, one instruction, regardless of holder count.
   *
   * Falls back to legacy deposit_sol if $PEGGED is not configured.
   */
  private async crankDepositPegged(): Promise<void> {
    if (!this.peggedMint) {
      // Legacy fallback: deposit_sol (pre-migration)
      return this.crankDepositSolLegacy();
    }

    try {
      const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
      const [statePDA] = monkeStatePDA(this.monkeProgramId);
      const [distPool] = monkeDistPoolPDA(this.monkeProgramId);
      const [programVault] = monkeProgramVaultPDA(this.monkeProgramId);

      const distPoolPeggedAta = getAssociatedTokenAddressSync(this.peggedMint, distPool, true);
      const programVaultPeggedAta = getAssociatedTokenAddressSync(this.peggedMint, programVault, true);

      await withRetry(
        () => this.monkeProgram.methods
          .depositPegged()
          .accounts({
            caller:                 this.botKeypair.publicKey,
            state:                  statePDA,
            distPool:               distPool,
            distPoolPeggedAta:      distPoolPeggedAta,
            programVaultPeggedAta:  programVaultPeggedAta,
            programVault:           programVault,
            tokenProgram:           new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          })
          .preInstructions(this.priorityIxs)
          .signers([this.botKeypair])
          .rpc(),
        'deposit_pegged'
      );

      logger.info('  [keeper] ✓ deposit_pegged cranked — accumulator updated');
    } catch (e: any) {
      const isExpected = e.error?.errorCode?.code === 'NoMonkes'
        || e.error?.errorCode?.code === 'NothingToDeposit'
        || e.error?.errorCode?.code === 'PeggedNotConfigured';
      if (isExpected) {
        logger.info('  [keeper] deposit_pegged skipped — no monkes, nothing to deposit, or not configured');
      } else {
        logger.error(`  [keeper] deposit_pegged error: ${e.message}`);
      }
    }
  }

  /** Legacy deposit_sol for pre-migration backward compatibility */
  private async crankDepositSolLegacy(): Promise<void> {
    try {
      const [statePDA] = monkeStatePDA(this.monkeProgramId);
      const [distPool] = monkeDistPoolPDA(this.monkeProgramId);
      const [programVault] = monkeProgramVaultPDA(this.monkeProgramId);

      await withRetry(
        () => this.monkeProgram.methods
          .depositSol()
          .accounts({
            caller:       this.botKeypair.publicKey,
            state:        statePDA,
            distPool:     distPool,
            programVault: programVault,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions(this.priorityIxs)
          .signers([this.botKeypair])
          .rpc(),
        'deposit_sol'
      );

      logger.info('  [keeper] ✓ deposit_sol cranked — accumulator updated');
    } catch (e: any) {
      const isExpected = e.error?.errorCode?.code === 'NoMonkes'
        || e.error?.errorCode?.code === 'NothingToDeposit';
      if (isExpected) {
        logger.info('  [keeper] deposit_sol skipped — no monkes or nothing to deposit');
      } else {
        logger.error(`  [keeper] deposit_sol error: ${e.message}`);
      }
    }
  }

  // ─── CRANK: CLOSE EXHAUSTED ROVERS ───

  /**
   * Close rover positions where all bins are empty (fully converted + harvested).
   * Rent refund goes to rover_authority → swept via sweep_rover (50/50 split).
   */
  private async crankCloseExhaustedRovers(): Promise<void> {
    try {
      const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID: SPL_TOKEN_ID, createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');

      const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);
      const [configPDA] = coreConfigPDA(this.coreProgramId);
      const roverAuthorityKey = roverAuthority.toBase58();

      const positions = await this.coreProgram.account.position.all();
      const roverPositions = positions.filter(
        (p: any) => (p.account.owner as PublicKey).toBase58() === roverAuthorityKey
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

  /**
   * Check dist_pool $PEGGED balance and auto-trigger deposit if above threshold.
   * Falls back to SOL balance check if $PEGGED is not configured (pre-migration).
   */
  async checkAndDepositPegged(): Promise<void> {
    try {
      if (this.peggedMint) {
        // $PEGGED flow: check dist_pool's $PEGGED ATA balance
        const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
        const [distPool] = monkeDistPoolPDA(this.monkeProgramId);
        const distPoolAta = getAssociatedTokenAddressSync(this.peggedMint, distPool, true);

        const info = await this.connection.getAccountInfo(distPoolAta);
        if (!info || info.data.length < 72) return;
        const available = Number(info.data.readBigUInt64LE(64));

        if (available >= DEPOSIT_SOL_THRESHOLD_LAMPORTS) {
          logger.info(`[keeper] dist_pool has ${available / 1e9} $PEGGED (threshold: ${DEPOSIT_SOL_THRESHOLD_LAMPORTS / 1e9}) — auto-triggering deposit_pegged`);
          await this.crankDepositPegged();
        }
      } else {
        // Legacy SOL flow (pre-migration)
        const [distPool] = monkeDistPoolPDA(this.monkeProgramId);
        const balance = await this.connection.getBalance(distPool);
        const rent = 890880;
        const available = balance - rent;

        if (available >= DEPOSIT_SOL_THRESHOLD_LAMPORTS) {
          logger.info(`[keeper] dist_pool has ${available / 1e9} SOL (threshold: ${DEPOSIT_SOL_THRESHOLD_LAMPORTS / 1e9}) — auto-triggering deposit_sol`);
          await this.crankDepositSolLegacy();
        }
      }
    } catch (e: any) {
      logger.warn(`[keeper] checkAndDepositPegged error: ${e.message}`);
    }
  }
}
