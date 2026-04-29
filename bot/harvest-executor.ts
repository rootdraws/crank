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
  Transaction,
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
import { buildMeteoraCPIAccounts, getDLMM, fixBitmapWritable, SPL_MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from './meteora-accounts';
import type { HarvestJob, LbPairInfo } from './geyser-subscriber';
import { logger } from './logger';
import { confirmAndCheck } from '../packages/core-sdk/transactions';
import { loadPoolRegistry, type PoolConfig } from '../packages/core-sdk/pool-config';
import { binToPrice } from '../packages/core-sdk/math';
import { fetchDexScreenerPrice } from '../packages/core-sdk/price-source';

// Dust-harvest threshold (USD). Harvests with estimated yield below this are
// skipped — bot's tx fees + gas reimbursement already cost ~$0.02 per harvest,
// so a sub-threshold yield is a net loss. The position stays active; the next
// gRPC event re-enqueues and accumulated yield eventually clears the bar.
const MIN_HARVEST_USD = parseFloat(process.env.MIN_HARVEST_USD || '0.25');

// Known quote mints. We only price yield in Y (quote); X yield is first
// converted to Y via the DLMM's active price.
const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';
const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Priority fee floor/cap (micro-lamports per compute unit)
const PRIORITY_FEE_FLOOR = 10_000;
const PRIORITY_FEE_CAP = 500_000; // 0.2 SOL max at 400K CU

/** Build compute budget instructions with dynamic priority fee */
async function buildPriorityFeeIxs(connection: Connection): Promise<any[]> {
  let microLamports = PRIORITY_FEE_FLOOR;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length > 0) {
      const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      microLamports = Math.min(Math.max(median, PRIORITY_FEE_FLOOR), PRIORITY_FEE_CAP);
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

  // Pool registry — address → config. Loaded once at construction; immutable.
  private poolByAddress: Map<string, PoolConfig> = new Map();

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

    try {
      for (const p of loadPoolRegistry()) {
        this.poolByAddress.set(p.address, p);
      }
    } catch (e: any) {
      logger.warn(`[executor] pool registry load failed: ${e.message} — dust-harvest filter disabled`);
    }
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
        // Always close on full conversion — close refunds position rent
        // regardless of yield value, so a dust check doesn't apply here.
        logger.info(`  [executor] ${key.slice(0, 8)} ${job.side} ALL ${binData.length} bins → CLOSE`);
        await this.closePosition(key, job, dlmm, meteoraPos, job.poolInfo);
      } else {
        // Dust filter — partial harvests only. Skip if estimated yield value
        // is below MIN_HARVEST_USD. Position stays active; next bin-change
        // event re-enqueues once accumulated yield clears the bar.
        const yieldUsd = await this.estimateYieldUsd(job, safeBins, binData, activeId);
        if (yieldUsd !== null && yieldUsd < MIN_HARVEST_USD) {
          logger.info(`  [executor] ${key.slice(0, 8)} ${job.side} skip dust — $${yieldUsd.toFixed(4)} < $${MIN_HARVEST_USD} across ${safeBins.length} bins`);
          return;
        }
        const valueTag = yieldUsd !== null ? ` ($${yieldUsd.toFixed(2)})` : '';
        logger.info(`  [executor] ${key.slice(0, 8)} ${job.side} ${safeBins.length}/${binData.length} bins → HARVEST${valueTag}`);
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

  /**
   * Estimate the USD value of a pending partial harvest. Returns null when the
   * pool isn't in the registry, the quote token isn't SOL/USDC, or the SOL/USD
   * oracle fails — callers treat null as "couldn't decide" and proceed.
   *
   * Yield computation is entirely on-chain: DLMM's `activeId` gives the
   * X-in-Y price, so Buy-side X yield is multiplied through to Y. Only the
   * quote→USD step is external (Pyth for SOL, 1.0 for USDC). No DexScreener.
   *
   * Sell side harvests the Y-token; Buy side harvests the X-token.
   */
  private async estimateYieldUsd(
    job: HarvestJob,
    safeBins: number[],
    binData: any[],
    activeId: number,
  ): Promise<number | null> {
    const pool = this.poolByAddress.get(job.lbPair.toBase58());
    if (!pool) return null;

    const isSell = job.side === 'Sell';

    // Sum the converted-side raw amount across safe bins.
    let totalRaw = 0n;
    const safeSet = new Set(safeBins);
    for (const bin of binData) {
      if (!safeSet.has(bin.binId)) continue;
      const amount = isSell ? bin.positionYAmount : bin.positionXAmount;
      if (amount) totalRaw += BigInt(amount);
    }
    if (totalRaw === 0n) return 0;

    // Express yield in human-readable Y (quote) units.
    let humanQuote: number;
    if (isSell) {
      humanQuote = Number(totalRaw) / 10 ** pool.decimalsY;
    } else {
      // Buy side: yield is in X. Convert using the DLMM's active-bin price
      // (Y per X, already decimal-adjusted by binToPrice).
      const pxPerX = binToPrice(activeId, pool.binStep, pool.decimalsX, pool.decimalsY);
      const humanX = Number(totalRaw) / 10 ** pool.decimalsX;
      humanQuote = humanX * pxPerX;
    }

    // Quote → USD. Only SOL + USDC supported; anything else returns null.
    const quoteUsd = await this.quoteMintUsd(pool.mintY);
    if (quoteUsd === null) return null;
    return humanQuote * quoteUsd;
  }

  /** USD price of a known quote mint. SOL via Pyth, USDC pegged at 1. */
  private async quoteMintUsd(mint: string): Promise<number | null> {
    if (mint === USDC_MINT_STR) return 1;
    if (mint === SOL_MINT_STR) {
      const p = await fetchDexScreenerPrice(SOL_MINT_STR); // SOL path uses Pyth internally
      return p?.priceUsd ?? null;
    }
    return null;
  }

  /**
   * USD value of an actual harvest/close delta. Frozen at event time — meant
   * to be persisted on the harvest row so /stats can show honest historical
   * volume without re-pricing old events. Returns null if uncomputable.
   */
  private async actualHarvestUsd(
    lbPair: string,
    side: 'Buy' | 'Sell',
    deltaX: bigint,
    deltaY: bigint,
    activeId: number,
  ): Promise<number | null> {
    const pool = this.poolByAddress.get(lbPair);
    if (!pool) return null;

    let humanQuote: number;
    if (side === 'Sell') {
      humanQuote = Number(deltaY) / 10 ** pool.decimalsY;
    } else {
      const pxPerX = binToPrice(activeId, pool.binStep, pool.decimalsX, pool.decimalsY);
      const humanX = Number(deltaX) / 10 ** pool.decimalsX;
      humanQuote = humanX * pxPerX;
    }
    if (humanQuote === 0) return 0;

    const quoteUsd = await this.quoteMintUsd(pool.mintY);
    if (quoteUsd === null) return null;
    return humanQuote * quoteUsd;
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

    const feeDest = this.botKeypair.publicKey;

    // Build Meteora CPI accounts first to resolve token programs,
    // then derive ATAs with the correct program ID (critical for Token-2022).
    const meteora = buildMeteoraCPIAccounts(dlmm, meteoraPos, binIds, poolInfo);

    // Token program ID (4th arg) for Token-2022 ATA derivation.
    const vaultTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
    const vaultTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
    const ownerTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, job.owner, true, meteora.tokenXProgram);
    const ownerTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, job.owner, true, meteora.tokenYProgram);
    // Fees → fee_dest ATAs (initial: bot keypair; retargeted to Hopper PDA later via set_fee_dest)
    const feeDestTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, feeDest, true, meteora.tokenXProgram);
    const feeDestTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, feeDest, true, meteora.tokenYProgram);

    // PDA vault architecture: bot is sole signer. Gas reimbursed on-chain from user vault.
    // job.owner = UserVault PDA (position.user_vault on-chain).
    const userId = this.walletService?.getUserIdForVault(job.owner.toBase58());
    const payer = this.botKeypair.publicKey;
    const signers = [this.botKeypair];

    // Ensure owner + rover ATAs exist (idempotent — no-op if already created)
    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
    const createOwnerAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenX, job.owner, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createOwnerAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenY, job.owner, meteora.tokenYMint, meteora.tokenYProgram,
    );
    const createFeeDestAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, feeDestTokenX, feeDest, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createFeeDestAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, feeDestTokenY, feeDest, meteora.tokenYMint, meteora.tokenYProgram,
    );

    // Priority fees to survive Solana congestion
    const priorityIxs = await buildPriorityFeeIxs(this.connection);

    const txSig = await withRetry(
      async () => {
        const ix = await this.coreProgram.methods
          .harvestBins(binIds)
          .accounts({
            bot:                this.botKeypair.publicKey,
            config:             configPDA,
            position:           new PublicKey(job.positionPDA),
            vault:              vaultPda,
            userVault:          job.owner,
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
            feeDest,
            feeDestTokenX,
            feeDestTokenY,
            tokenXProgram:      meteora.tokenXProgram,
            tokenYProgram:      meteora.tokenYProgram,
            memoProgram:        meteora.memoProgram,
          })
          .instruction();
        fixBitmapWritable(ix, meteora.binArrayBitmapExt);
        const tx = new Transaction().add(
          ...priorityIxs, createOwnerAtaX, createOwnerAtaY, createFeeDestAtaX, createFeeDestAtaY, ix
        );
        tx.feePayer = this.botKeypair.publicKey;
        const bh = await this.connection.getLatestBlockhash();
        tx.recentBlockhash = bh.blockhash;
        tx.sign(this.botKeypair);
        const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await confirmAndCheck(this.connection, sig, bh.blockhash, bh.lastValidBlockHeight);
        return sig;
      },
      `harvest ${key.slice(0, 8)}`
    );

    // Read token deltas from the confirmed transaction.
    // RPC may not have indexed the tx data immediately after confirmation — retry up to 3 times.
    let deltaX = 0n, deltaY = 0n;
    try {
      let txData = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        txData = await this.connection.getTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (txData?.meta) break;
        await new Promise(r => setTimeout(r, 2000));
      }
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
      } else {
        logger.warn(`  [executor] getTransaction returned null after 3 attempts for ${key.slice(0, 8)} (${txSig.slice(0, 12)})`);
      }
    } catch (e: any) {
      logger.warn(`  [executor] Token delta read failed for ${key.slice(0, 8)}: ${e.message?.slice(0, 80)}`);
    }

    // Auto-unwrap WSOL → native SOL in vault PDA (so /withdraw SOL works immediately)
    if (meteora.tokenYMint.equals(NATIVE_MINT) || meteora.tokenXMint.equals(NATIVE_MINT)) {
      try {
        const [cfgPDA] = coreConfigPDA(this.coreProgramId);
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, job.owner, true, TOKEN_PROGRAM_ID);
        await this.coreProgram.methods
          .unwrapWsolInVault()
          .accounts({
            caller: this.botKeypair.publicKey,
            config: cfgPDA,
            userVault: job.owner,
            vaultWsolAta: wsolAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([this.botKeypair])
          .rpc();
        logger.info(`  [executor] Auto-unwrapped WSOL for vault ${job.owner.toBase58().slice(0, 8)}`);
      } catch (e: any) {
        logger.warn(`  [executor] WSOL unwrap failed for vault ${job.owner.toBase58().slice(0, 8)}: ${e.message?.slice(0, 80)}`);
      }
    }
    // On-chain withdraw_sol handles native SOL. WSOL stays in vault ATAs.

    // Compute fee extracted by sweep_rover (0.3% of the converted output).
    // User received (gross - fee), so fee = gross * 0.003 = amount_out * 3/997.
    // Only one side is nonzero per harvest (the converted side).
    const deltaMax = deltaX > deltaY ? deltaX : deltaY;
    const feeTaken = (deltaMax * 3n) / 997n;

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
      feeTaken: feeTaken.toString(),
    }, `Harvest submitted: ${binIds.length} bins from ${key.slice(0, 8)}`);
    this.lastHarvestTime = Date.now();
    this.totalHarvests++;

    // USD value at harvest time — frozen and persisted so /stats can show
    // honest historical volume without re-pricing old rows. null on pools
    // that aren't in curator.json or with non-SOL/USDC quote.
    const usdValue = await this.actualHarvestUsd(
      job.lbPair.toBase58(), job.side, deltaX, deltaY, dlmm.lbPair.activeId,
    );

    this.emit('harvestExecuted', {
      positionPDA: job.positionPDA,
      lbPair: job.lbPair.toBase58(),
      owner: job.owner.toBase58(),
      side: job.side,
      binCount: binIds.length,
      txSig,
      tokenXAmount: deltaX.toString(),
      tokenYAmount: deltaY.toString(),
      feeAmount: feeTaken.toString(),
      usdValue,
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

    const feeDest = this.botKeypair.publicKey;

    const allBinIds = meteoraPos.positionData.positionBinData.map((b: any) => b.binId);
    const meteora = buildMeteoraCPIAccounts(dlmm, meteoraPos, allBinIds, poolInfo);

    const vaultTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
    const vaultTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
    const ownerTokenX    = getAssociatedTokenAddressSync(meteora.tokenXMint, job.owner, true, meteora.tokenXProgram);
    const ownerTokenY    = getAssociatedTokenAddressSync(meteora.tokenYMint, job.owner, true, meteora.tokenYProgram);
    // Fees → fee_dest ATAs (initial: bot keypair; retargeted to Hopper PDA later via set_fee_dest)
    const feeDestTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, feeDest, true, meteora.tokenXProgram);
    const feeDestTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, feeDest, true, meteora.tokenYProgram);

    // PDA vault architecture: bot is sole signer.
    const userId = this.walletService?.getUserIdForVault(job.owner.toBase58());
    const payer = this.botKeypair.publicKey;
    const signers = [this.botKeypair];

    const { createAssociatedTokenAccountIdempotentInstruction } = await import('@solana/spl-token');
    const createOwnerAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenX, job.owner, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createOwnerAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, ownerTokenY, job.owner, meteora.tokenYMint, meteora.tokenYProgram,
    );
    const createFeeDestAtaX = createAssociatedTokenAccountIdempotentInstruction(
      payer, feeDestTokenX, feeDest, meteora.tokenXMint, meteora.tokenXProgram,
    );
    const createFeeDestAtaY = createAssociatedTokenAccountIdempotentInstruction(
      payer, feeDestTokenY, feeDest, meteora.tokenYMint, meteora.tokenYProgram,
    );

    const priorityIxs = await buildPriorityFeeIxs(this.connection);

    const closeSig = await withRetry(
      async () => {
        const ix = await this.coreProgram.methods
          .closePosition()
          .accounts({
            bot:                this.botKeypair.publicKey,
            config:             configPDA,
            userVault:          job.owner,
            position:           new PublicKey(job.positionPDA),
            vault:              vaultPda,
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
            feeDest,
            feeDestTokenX,
            feeDestTokenY,
            tokenXProgram:      meteora.tokenXProgram,
            tokenYProgram:      meteora.tokenYProgram,
            memoProgram:        meteora.memoProgram,
            systemProgram:      new PublicKey('11111111111111111111111111111111'),
          })
          .instruction();
        fixBitmapWritable(ix, meteora.binArrayBitmapExt);
        const tx = new Transaction().add(
          ...priorityIxs, createOwnerAtaX, createOwnerAtaY, createFeeDestAtaX, createFeeDestAtaY, ix
        );
        tx.feePayer = this.botKeypair.publicKey;
        const bh = await this.connection.getLatestBlockhash();
        tx.recentBlockhash = bh.blockhash;
        tx.sign(this.botKeypair);
        const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        await confirmAndCheck(this.connection, sig, bh.blockhash, bh.lastValidBlockHeight);
        return sig;
      },
      `close ${key.slice(0, 8)}`
    );

    // Read token deltas from the confirmed transaction (retry for RPC indexing lag)
    let deltaX = 0n, deltaY = 0n;
    try {
      let txData = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        txData = await this.connection.getTransaction(closeSig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (txData?.meta) break;
        await new Promise(r => setTimeout(r, 2000));
      }
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
      } else {
        logger.warn(`  [executor] getTransaction returned null after 3 attempts for ${key.slice(0, 8)} (${closeSig.slice(0, 12)})`);
      }
    } catch (e: any) {
      logger.warn(`  [executor] Token delta read failed for ${key.slice(0, 8)}: ${e.message?.slice(0, 80)}`);
    }

    // Auto-unwrap WSOL → native SOL in vault PDA (so /withdraw SOL works immediately)
    if (meteora.tokenYMint.equals(NATIVE_MINT) || meteora.tokenXMint.equals(NATIVE_MINT)) {
      try {
        const [cfgPDA] = coreConfigPDA(this.coreProgramId);
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, job.owner, true, TOKEN_PROGRAM_ID);
        await this.coreProgram.methods
          .unwrapWsolInVault()
          .accounts({
            caller: this.botKeypair.publicKey,
            config: cfgPDA,
            userVault: job.owner,
            vaultWsolAta: wsolAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([this.botKeypair])
          .rpc();
        logger.info(`  [executor] Auto-unwrapped WSOL for vault ${job.owner.toBase58().slice(0, 8)}`);
      } catch (e: any) {
        logger.warn(`  [executor] WSOL unwrap failed for vault ${job.owner.toBase58().slice(0, 8)}: ${e.message?.slice(0, 80)}`);
      }
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

    const usdValue = await this.actualHarvestUsd(
      job.lbPair.toBase58(), job.side, deltaX, deltaY, dlmm.lbPair.activeId,
    );

    this.emit('positionClosed', {
      positionPDA: job.positionPDA,
      lbPair: job.lbPair.toBase58(),
      owner: job.owner.toBase58(),
      side: job.side,
      txSig: closeSig,
      tokenXAmount: deltaX.toString(),
      tokenYAmount: deltaY.toString(),
      usdValue,
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
