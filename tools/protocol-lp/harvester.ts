/**
 * tools/protocol-lp/harvester.ts
 *
 * Position discovery, safe bin detection, and removeLiquidity.
 * Ported from dlmm-harvester with adaptations for protocol-lp.
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { PublicKey, sendAndConfirmTransaction } = _require('@solana/web3.js');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } = _require('@solana/spl-token');
const DLMM = _require('@meteora-ag/dlmm');
const BN = _require('bn.js');

import { CONFIG } from './config';
import { setPosition, addHarvest, getState } from './state';
import type { TrackedPosition, Side } from './types';

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 1000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      if (attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
        console.warn(`[${label}] Attempt ${attempt + 1} failed: ${e.message}. Retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export interface PoolState {
  dlmm: any;
  activeId: number;
  binStep: number;
}

export interface PositionBalances {
  xBalance: bigint;
  yBalance: bigint;
  binsWithX: number[];
  binsWithY: number[];
}

export interface DiscoveredPosition {
  pubkey: string;
  side: Side;
  minBinId: number;
  maxBinId: number;
}

// In-flight tracking to prevent duplicate operations
const inflight = new Set<string>();

export async function createPool(connection: any): Promise<PoolState> {
  const dlmm = await withRetry(
    () => DLMM.create(connection, CONFIG.poolAddress),
    'DLMM.create'
  );
  const activeId = dlmm.lbPair.activeId;
  const binStep = dlmm.lbPair.binStep;
  return { dlmm, activeId, binStep };
}

export async function refreshPool(pool: PoolState): Promise<void> {
  await withRetry(() => pool.dlmm.refetchStates(), 'refetchStates');
  pool.activeId = pool.dlmm.lbPair.activeId;
}

export async function discoverPositions(pool: PoolState): Promise<DiscoveredPosition[]> {
  const { userPositions } = await withRetry(
    () => pool.dlmm.getPositionsByUserAndLbPair(CONFIG.wallet.publicKey),
    'getPositionsByUserAndLbPair'
  );

  const state = getState();
  const discovered: DiscoveredPosition[] = [];

  for (const pos of userPositions) {
    const pubkey = pos.publicKey.toBase58();
    const bins = pos.positionData.positionBinData;
    if (!bins || bins.length === 0) continue;

    const sorted = [...bins].sort((a: any, b: any) => a.binId - b.binId);
    const minBinId = sorted[0].binId;
    const maxBinId = sorted[sorted.length - 1].binId;

    // Determine side: check persisted state first, then infer
    let side: Side;
    if (state.positions[pubkey]) {
      side = state.positions[pubkey].side;
    } else {
      side = inferSide(pool.activeId, minBinId, maxBinId);
    }

    // Persist if new
    if (!state.positions[pubkey]) {
      await setPosition(pubkey, {
        pubkey,
        side,
        minBinId,
        maxBinId,
        status: 'active',
        createdAt: Date.now(),
      });
    }

    discovered.push({ pubkey, side, minBinId, maxBinId });
  }

  return discovered;
}

function inferSide(activeId: number, minBin: number, maxBin: number): Side {
  if (minBin > activeId) return 'sell';
  if (maxBin < activeId) return 'buy';
  // Straddles active — use midpoint
  const mid = Math.floor((minBin + maxBin) / 2);
  return mid > activeId ? 'sell' : 'buy';
}

export async function getPositionBalances(pool: PoolState, positionPubkey: string): Promise<PositionBalances> {
  const { userPositions } = await withRetry(
    () => pool.dlmm.getPositionsByUserAndLbPair(CONFIG.wallet.publicKey),
    'getBalances'
  );

  const pos = userPositions.find((p: any) => p.publicKey.toBase58() === positionPubkey);
  if (!pos) return { xBalance: 0n, yBalance: 0n, binsWithX: [], binsWithY: [] };

  let xBalance = 0n;
  let yBalance = 0n;
  const binsWithX: number[] = [];
  const binsWithY: number[] = [];

  for (const bin of pos.positionData.positionBinData) {
    const xAmt = BigInt(bin.positionXAmount);
    const yAmt = BigInt(bin.positionYAmount);
    xBalance += xAmt;
    yBalance += yAmt;
    if (xAmt > 0n) binsWithX.push(bin.binId);
    if (yAmt > 0n) binsWithY.push(bin.binId);
  }

  return { xBalance, yBalance, binsWithX, binsWithY };
}

export function getSafeWithdrawBins(side: Side, activeId: number, binsWithTarget: number[]): number[] {
  if (side === 'sell') {
    // Y (SOL) accumulates in bins BELOW activeId (price moved above them)
    return binsWithTarget.filter(binId => binId < activeId);
  } else {
    // X (CRANK) accumulates in bins ABOVE activeId (price moved below them)
    return binsWithTarget.filter(binId => binId > activeId);
  }
}

export async function harvestBins(
  connection: any,
  pool: PoolState,
  positionPubkey: string,
  safeBins: number[],
  side: Side,
): Promise<{ txSig: string; lamports: number } | null> {
  if (safeBins.length === 0) return null;
  if (inflight.has(positionPubkey)) {
    console.log(`[harvest] Skipping ${positionPubkey.slice(0, 8)} — already in-flight`);
    return null;
  }

  const fromBinId = Math.min(...safeBins);
  const toBinId = Math.max(...safeBins);

  console.log(`[harvest] ${side} position ${positionPubkey.slice(0, 8)}... bins ${fromBinId}-${toBinId} (${safeBins.length} bins)`);

  if (CONFIG.dryRun) {
    console.log(`[DRY_RUN] Would harvest bins ${fromBinId}-${toBinId}`);
    return null;
  }

  inflight.add(positionPubkey);
  try {
    const transactions = await withRetry(
      () => pool.dlmm.removeLiquidity({
        user: CONFIG.wallet.publicKey,
        position: new PublicKey(positionPubkey),
        fromBinId,
        toBinId,
        bps: new BN(10000),
        shouldClaimAndClose: false,
      }),
      'removeLiquidity'
    );

    let lastSig = '';
    for (const tx of transactions) {
      lastSig = await withRetry(
        () => sendAndConfirmTransaction(connection, tx, [CONFIG.wallet], { commitment: 'confirmed' }),
        'sendHarvestTx'
      );
    }

    // Read balance after to compute harvested amount
    const balanceAfter = await connection.getBalance(CONFIG.wallet.publicKey);

    await addHarvest({
      timestamp: Date.now(),
      positionPubkey,
      side,
      amountLamports: 0, // Will be computed by caller from balance delta
      txSig: lastSig,
      binsHarvested: safeBins.length,
    });

    console.log(`[harvest] Success: ${lastSig}`);
    return { txSig: lastSig, lamports: 0 };
  } finally {
    inflight.delete(positionPubkey);
  }
}

export async function ensureATAs(connection: any, mints: string[]): Promise<void> {
  const mintPubkeys = mints.map((m: string) => new PublicKey(m));
  const mintAccounts = await connection.getMultipleAccountsInfo(mintPubkeys);

  for (let i = 0; i < mints.length; i++) {
    const mintAccount = mintAccounts[i];
    if (!mintAccount) continue;

    const tokenProgramId = mintAccount.owner;
    const ata = await getAssociatedTokenAddress(
      mintPubkeys[i],
      CONFIG.wallet.publicKey,
      false,
      tokenProgramId,
    );

    const ataAccount = await connection.getAccountInfo(ata);
    if (!ataAccount) {
      console.log(`Creating ATA for mint ${mints[i].slice(0, 8)}...`);
      if (!CONFIG.dryRun) {
        const { Transaction } = _require('@solana/web3.js');
        const ix = createAssociatedTokenAccountInstruction(
          CONFIG.wallet.publicKey,
          ata,
          CONFIG.wallet.publicKey,
          mintPubkeys[i],
          tokenProgramId,
        );
        const tx = new Transaction().add(ix);
        await sendAndConfirmTransaction(connection, tx, [CONFIG.wallet], { commitment: 'confirmed' });
        console.log(`ATA created: ${ata.toBase58()}`);
      }
    }
  }
}

export function isInflight(): boolean {
  return inflight.size > 0;
}
