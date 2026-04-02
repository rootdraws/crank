/**
 * harvest-executor.ts
 *
 * Dedicated harvest job executor for crank.money.
 * Receives harvest jobs from GeyserSubscriber, confirms bin balances
 * via a single RPC call, and submits harvest_bins or close_position
 * transactions.
 *
 * Extracted from anchor-harvest-bot.ts for clean separation:
 *   - Subscriber detects price changes (event-driven)
 *   - Executor confirms and executes harvests (RPC + tx)
 *   - Neither blocks the other
 */

import {
  Connection,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token';
import DLMM from '@meteora-ag/dlmm';
import { EventEmitter } from 'events';
import { buildMeteoraCPIAccounts, getDLMM, SPL_MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './meteora-accounts';
import type { HarvestJob, LbPairInfo } from './geyser-subscriber';
import { logger } from './logger';

// Priority fee floor (micro-lamports per compute unit)
const PRIORITY_FEE_FLOOR = 10_000;

/** Build compute budget instructions with dynamic priority fee */
async function buildPriorityFeeIxs(connection: Connection): Promise<any[]> {
  let microLamports = PRIORITY_FEE_FLOOR;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length > 0) {
      const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      microLamports = Math.max(median, PRIORITY_FEE_FLOOR);
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

interface ExecutorConfig {
  connection: Connection;
  coreProgram: Program;
  botKeypair: Keypair;
  coreProgramId: PublicKey;
  maxConcurrent?: number;
  walletService?: any;
}

// ═══ HELPERS ═══

import { withRetry } from './retry';

function coreConfigPDA(coreProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], coreProgramId);
}

function vaultPDA(meteoraPosition: PublicKey, coreProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), meteoraPosition.toBuffer()],
    coreProgramId
  );
}

function roverAuthorityPDA(coreProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], coreProgramId);
}

// ═══ EXECUTOR ═══

export class HarvestExecutor extends EventEmitter {
  private connection: Connection;
  private coreProgram: Program;
  private botKeypair: Keypair;
  private coreProgramId: PublicKey;
  private maxConcurrent: number;
  private walletService: any;

  private inflight: Set<string> = new Set();
  private jobQueue: HarvestJob[] = [];
  private processing = false;
  private shuttingDown = false;
  // DLMM cache moved to shared meteora-accounts.ts module

  // Stats
  public lastHarvestTime = 0;
  public totalHarvests = 0;
  public totalCloses = 0;

  constructor(config: ExecutorConfig) {
    super();
    this.connection = config.connection;
    this.coreProgram = config.coreProgram;
    this.botKeypair = config.botKeypair;
    this.coreProgramId = config.coreProgramId;
    this.maxConcurrent = config.maxConcurrent ?? 5;
    this.walletService = config.walletService ?? null;
  }

  setWalletService(ws: any): void {
    this.walletService = ws;
  }

  // ─── JOB QUEUE ───

  enqueue(job: HarvestJob): void {
    // Deduplicate: don't queue if already inflight or already queued
    if (this.inflight.has(job.positionPDA)) return;
    if (this.jobQueue.some(j => j.positionPDA === job.positionPDA)) return;

    this.jobQueue.push(job);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.shuttingDown) return;
    this.processing = true;

    try {
      while (this.jobQueue.length > 0 && !this.shuttingDown) {
        // Respect concurrency limit
        if (this.inflight.size >= this.maxConcurrent) {
          await new Promise(r => setTimeout(r, 100));
          continue;
        }

        const job = this.jobQueue.shift();
        if (!job) break;

        // Fire and forget — don't block the queue
        this.executeJob(job).catch(e =>
          logger.error(`  [executor] Job failed ${job.positionPDA.slice(0, 8)}: ${e.message}`)
        );
      }
    } finally {
      this.processing = false;
    }
  }

  // ─── JOB EXECUTION ───

  private async executeJob(job: HarvestJob): Promise<void> {
    const key = job.positionPDA;
    if (this.inflight.has(key)) return;
    this.inflight.add(key);

    try {
      const dlmm = await getDLMM(this.connection, job.lbPair);
      await withRetry(
        () => dlmm.refetchStates(),
        `refetch ${job.lbPair.toBase58().slice(0, 8)}`
      );

      const activeId = dlmm.lbPair.activeId;

      // Get per-bin balances to confirm which bins are truly safe
      const [vaultPda] = vaultPDA(job.meteoraPosition, this.coreProgramId);
      const { userPositions } = await dlmm.getPositionsByUserAndLbPair(vaultPda);

      const meteoraPos = userPositions.find(
        (p: any) => p.publicKey.equals(job.meteoraPosition)
      );

      if (!meteoraPos) {
        logger.info(`  [executor] ${key.slice(0, 8)} meteora position gone — stale`);
        return;
      }

      const binData = meteoraPos.positionData.positionBinData;
      if (!binData || binData.length === 0) {
        logger.info(`  [executor] ${key.slice(0, 8)} ${job.side} — no bin data from Meteora SDK, skipping`);
        return;
      }

      // Re-confirm safe bins with actual balance data
      const safeBins = this.getSafeWithdrawBins(job.side, activeId, binData);
      if (safeBins.length === 0) {
        // Count how many bins pass the range check but fail the balance check
        let rangeSafe = 0;
        for (const bin of binData) {
          if (job.side === 'Sell' && bin.binId < activeId) rangeSafe++;
          if (job.side === 'Buy' && bin.binId > activeId) rangeSafe++;
        }
        if (rangeSafe > 0) {
          logger.info(`  [executor] ${key.slice(0, 8)} ${job.side} — ${rangeSafe} bins in range but 0 with balance (activeId=${activeId}, bins=${binData[0]?.binId}..${binData[binData.length - 1]?.binId})`);
        }
        return;
      }

      // Validate contiguity before submitting harvest.
      // On-chain requires (to_bin - from_bin + 1) == bin_ids.len().
      // If bins are non-contiguous (rare edge case from partial prior harvests),
      // the on-chain tx would revert. Expand to full contiguous range instead —
      // 0-balance bins produce 0 delta (safe per on-chain 0-delta warning).
      if (safeBins.length > 0) {
        const minBin = safeBins[0];
        const maxBin = safeBins[safeBins.length - 1];
        const expectedLen = maxBin - minBin + 1;
        if (expectedLen !== safeBins.length) {
          logger.info(`  [executor] ${key.slice(0, 8)} non-contiguous bins [${minBin}..${maxBin}] (${safeBins.length}/${expectedLen}) — expanding to full range`);
          safeBins.length = 0; // clear
          for (let b = minBin; b <= maxBin; b++) {
            safeBins.push(b);
          }
        }
      }

      const allExhausted = safeBins.length === binData.length;

      if (allExhausted) {
        logger.info(`  [executor] ${key.slice(0, 8)} ${job.side} ALL ${binData.length} bins → CLOSE`);
        await this.closePosition(key, job, dlmm, meteoraPos, job.poolInfo);
      } else {
        logger.info(`  [executor] ${key.slice(0, 8)} ${job.side} ${safeBins.length}/${binData.length} bins → HARVEST`);
        await this.harvestBins(key, job, dlmm, meteoraPos, safeBins, job.poolInfo);
      }
    } catch (e: any) {
      logger.error(`  [executor] ${key.slice(0, 8)} error: ${e.message?.slice(0, 60)}`);
    } finally {
      this.inflight.delete(key);
    }
  }

  // ─── BIN DETECTION ───

  getSafeWithdrawBins(
    side: 'Buy' | 'Sell',
    activeId: number,
    positionBinData: any[]
  ): number[] {
    const safeBins: number[] = [];

    for (const bin of positionBinData) {
      const binId = bin.binId;

      if (side === 'Sell') {
        if (binId < activeId && BigInt(bin.positionYAmount) > 0n) {
          safeBins.push(binId);
        }
      } else {
        if (binId > activeId && BigInt(bin.positionXAmount) > 0n) {
          safeBins.push(binId);
        }
      }
    }

    return safeBins.sort((a, b) => a - b);
  }

  // ─── HARVEST ───

  private async harvestBins(
    key: string,
    job: HarvestJob,
    dlmm: any,
    meteoraPos: any,
    binIds: number[],
    poolInfo?: LbPairInfo,
  ): Promise<void> {
    const [configPDA] = coreConfigPDA(this.coreProgramId);
    const [vaultPda] = vaultPDA(job.meteoraPosition, this.coreProgramId);

    const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);

    // Build Meteora CPI accounts first to resolve token programs,
    // then derive ATAs with the correct program ID (critical for Token-2022).
    const meteora = buildMeteoraCPIAccounts(dlmm, meteoraPos, binIds, poolInfo);

    // Token program ID (4th arg) for Token-2022 ATA derivation.
    const vaultTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
    const vaultTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
    const ownerTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, job.owner, true, meteora.tokenXProgram);
    const ownerTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, job.owner, true, meteora.tokenYProgram);
    // All fees → rover_authority ATAs (sweep_rover splits 40/40/20: holders + traders + bot)
    const roverFeeTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, roverAuthority, true, meteora.tokenXProgram);
    const roverFeeTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, roverAuthority, true, meteora.tokenYProgram);

    // Gas offloading: user pays gas, bot signs as authorized bot.
    // bot account = botKeypair (authorized path, no keeper tip).
    // fee payer = userKeypair if available (user pays gas), else botKeypair.
    const userId = this.walletService?.getUserIdForOwner(job.owner.toBase58());
    const userKeypair = userId ? this.walletService.getOrCreate(userId) : null;
    const payer = userKeypair?.publicKey ?? this.botKeypair.publicKey;
    const signers = userKeypair ? [this.botKeypair, userKeypair] : [this.botKeypair];

    // Ensure owner + rover ATAs exist (idempotent — no-op if already created)
    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
    const createOwnerAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenX, job.owner, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createOwnerAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenY, job.owner, meteora.tokenYMint, meteora.tokenYProgram,
    );
    const createRoverAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, roverFeeTokenX, roverAuthority, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createRoverAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, roverFeeTokenY, roverAuthority, meteora.tokenYMint, meteora.tokenYProgram,
    );

    // Priority fees to survive Solana congestion
    const priorityIxs = await buildPriorityFeeIxs(this.connection);

    const txSig = await withRetry(
      () => this.coreProgram.methods
        .harvestBins(binIds)
        .accounts({
          bot:                this.botKeypair.publicKey,
          config:             configPDA,
          position:           new PublicKey(job.positionPDA),
          vault:              vaultPda,
          owner:              job.owner,
          meteoraPosition:    meteora.meteoraPosition,
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
          roverAuthority,
          roverFeeTokenX,
          roverFeeTokenY,
          tokenXProgram:      meteora.tokenXProgram,
          tokenYProgram:      meteora.tokenYProgram,
          memoProgram:        meteora.memoProgram,
        })
        .preInstructions([...priorityIxs, createOwnerAtaX, createOwnerAtaY, createRoverAtaX, createRoverAtaY])
        .signers(signers)
        .rpc(),
      `harvest ${key.slice(0, 8)}`
    );

    // Read token deltas from the confirmed transaction (no timing issues)
    let deltaX = 0n, deltaY = 0n;
    try {
      const txData = await this.connection.getTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (txData?.meta) {
        const ownerKey = job.owner.toBase58();
        const pre = txData.meta.preTokenBalances ?? [];
        const post = txData.meta.postTokenBalances ?? [];
        for (const p of post) {
          if (p.owner !== ownerKey) continue;
          const preEntry = pre.find(e => e.accountIndex === p.accountIndex);
          const preBal = BigInt(preEntry?.uiTokenAmount?.amount ?? '0');
          const postBal = BigInt(p.uiTokenAmount.amount);
          const delta = postBal - preBal;
          if (delta <= 0n) continue;
          if (p.mint === meteora.tokenXMint.toBase58()) deltaX = delta;
          else if (p.mint === meteora.tokenYMint.toBase58()) deltaY = delta;
        }
      }
    } catch { /* best-effort */ }

    // Auto-unwrap WSOL after harvest so user sees native SOL
    if (userKeypair && (meteora.tokenYMint.equals(NATIVE_MINT) || meteora.tokenXMint.equals(NATIVE_MINT))) {
      try {
          const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, job.owner, true, TOKEN_PROGRAM_ID);
          const { Transaction } = await import('@solana/web3.js');
          const tx = new Transaction().add(
            createCloseAccountInstruction(wsolAta, job.owner, job.owner, [], TOKEN_PROGRAM_ID)
          );
          const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.lastValidBlockHeight = lastValidBlockHeight;
          tx.feePayer = job.owner;
          tx.sign(userKeypair);
          await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
          logger.info(`  [executor] Auto-unwrapped WSOL for ${job.owner.toBase58().slice(0, 8)}`);
      } catch { /* WSOL ATA may not exist */ }
    }

    // Structured logging for forensic reconstruction
    logger.info({
      positionPDA: key,
      binIds,
      binCount: binIds.length,
      owner: job.owner.toBase58(),
      side: job.side,
      pool: job.lbPair.toBase58().slice(0, 8),
      txSig,
      tokenXReceived: deltaX.toString(),
      tokenYReceived: deltaY.toString(),
    }, `Harvest submitted: ${binIds.length} bins from ${key.slice(0, 8)}`);
    this.lastHarvestTime = Date.now();
    this.totalHarvests++;
    this.emit('harvestExecuted', {
      positionPDA: job.positionPDA,
      lbPair: job.lbPair.toBase58(),
      owner: job.owner.toBase58(),
      side: job.side,
      binCount: binIds.length,
      txSig,
      tokenXAmount: deltaX.toString(),
      tokenYAmount: deltaY.toString(),
    });
  }

  // ─── CLOSE ───

  private async closePosition(
    key: string,
    job: HarvestJob,
    dlmm: any,
    meteoraPos: any,
    poolInfo?: LbPairInfo,
  ): Promise<void> {
    const [configPDA] = coreConfigPDA(this.coreProgramId);
    const [vaultPda] = vaultPDA(job.meteoraPosition, this.coreProgramId);

    const [roverAuthority] = roverAuthorityPDA(this.coreProgramId);

    const allBinIds = meteoraPos.positionData.positionBinData.map((b: any) => b.binId);
    const meteora = buildMeteoraCPIAccounts(dlmm, meteoraPos, allBinIds, poolInfo);

    const vaultTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
    const vaultTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
    const ownerTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, job.owner, true, meteora.tokenXProgram);
    const ownerTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, job.owner, true, meteora.tokenYProgram);
    // All fees → rover_authority ATAs (sweep_rover splits 40/40/20: holders + traders + bot)
    const roverFeeTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, roverAuthority, true, meteora.tokenXProgram);
    const roverFeeTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, roverAuthority, true, meteora.tokenYProgram);

    // Gas offloading: user pays gas, bot signs as authorized bot.
    const userId = this.walletService?.getUserIdForOwner(job.owner.toBase58());
    const userKeypair = userId ? this.walletService.getOrCreate(userId) : null;
    const payer = userKeypair?.publicKey ?? this.botKeypair.publicKey;
    const signers = userKeypair ? [this.botKeypair, userKeypair] : [this.botKeypair];

    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
    const createOwnerAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenX, job.owner, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createOwnerAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenY, job.owner, meteora.tokenYMint, meteora.tokenYProgram,
    );
    const createRoverAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, roverFeeTokenX, roverAuthority, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createRoverAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, roverFeeTokenY, roverAuthority, meteora.tokenYMint, meteora.tokenYProgram,
    );

    const priorityIxs = await buildPriorityFeeIxs(this.connection);

    const closeSig = await withRetry(
      () => this.coreProgram.methods
        .closePosition()
        .accounts({
          bot:                this.botKeypair.publicKey,
          config:             configPDA,
          position:           new PublicKey(job.positionPDA),
          vault:              vaultPda,
          owner:              job.owner,
          meteoraPosition:    meteora.meteoraPosition,
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
          roverAuthority,
          roverFeeTokenX,
          roverFeeTokenY,
          tokenXProgram:      meteora.tokenXProgram,
          tokenYProgram:      meteora.tokenYProgram,
          memoProgram:        meteora.memoProgram,
          systemProgram:      new PublicKey('11111111111111111111111111111111'),
        })
        .preInstructions([...priorityIxs, createOwnerAtaX, createOwnerAtaY, createRoverAtaX, createRoverAtaY])
        .signers(signers)
        .rpc(),
      `close ${key.slice(0, 8)}`
    );

    // Read token deltas from the confirmed transaction
    let deltaX = 0n, deltaY = 0n;
    try {
      const txData = await this.connection.getTransaction(closeSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if (txData?.meta) {
        const ownerKey = job.owner.toBase58();
        const pre = txData.meta.preTokenBalances ?? [];
        const post = txData.meta.postTokenBalances ?? [];
        for (const p of post) {
          if (p.owner !== ownerKey) continue;
          const preEntry = pre.find(e => e.accountIndex === p.accountIndex);
          const preBal = BigInt(preEntry?.uiTokenAmount?.amount ?? '0');
          const postBal = BigInt(p.uiTokenAmount.amount);
          const delta = postBal - preBal;
          if (delta <= 0n) continue;
          if (p.mint === meteora.tokenXMint.toBase58()) deltaX = delta;
          else if (p.mint === meteora.tokenYMint.toBase58()) deltaY = delta;
        }
      }
    } catch { /* best-effort */ }

    // Auto-unwrap WSOL after close
    if (userKeypair && (meteora.tokenYMint.equals(NATIVE_MINT) || meteora.tokenXMint.equals(NATIVE_MINT))) {
      try {
          const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, job.owner, true, TOKEN_PROGRAM_ID);
          const { Transaction } = await import('@solana/web3.js');
          const tx = new Transaction().add(
            createCloseAccountInstruction(wsolAta, job.owner, job.owner, [], TOKEN_PROGRAM_ID)
          );
          const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.lastValidBlockHeight = lastValidBlockHeight;
          tx.feePayer = job.owner;
          tx.sign(userKeypair);
          await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
          logger.info(`  [executor] Auto-unwrapped WSOL for ${job.owner.toBase58().slice(0, 8)}`);
      } catch { /* WSOL ATA may not exist */ }
    }

    logger.info({
      positionPDA: key,
      owner: job.owner.toBase58().slice(0, 8),
      tokenXReceived: deltaX.toString(),
      tokenYReceived: deltaY.toString(),
      txSig: closeSig,
    }, `Closed ${key.slice(0, 8)}`);
    this.lastHarvestTime = Date.now();
    this.totalCloses++;
    this.emit('positionClosed', {
      positionPDA: job.positionPDA,
      lbPair: job.lbPair.toBase58(),
      owner: job.owner.toBase58(),
      side: job.side,
      txSig: closeSig,
      tokenXAmount: deltaX.toString(),
      tokenYAmount: deltaY.toString(),
    });
  }

  // Meteora CPI accounts + DLMM cache moved to shared meteora-accounts.ts module
  // Used via: buildMeteoraCPIAccounts() and getDLMM()

  // ─── LIFECYCLE ───

  getInflightCount(): number {
    return this.inflight.size;
  }

  getQueueLength(): number {
    return this.jobQueue.length;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.inflight.size > 0) {
      logger.info(`[executor] Waiting for ${this.inflight.size} in-flight tx...`);
      const deadline = Date.now() + 30_000;
      while (this.inflight.size > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    logger.info('[executor] Shut down');
  }
}
