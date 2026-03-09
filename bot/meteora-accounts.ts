/**
 * meteora-accounts.ts
 *
 * Shared Meteora DLMM account resolution for crank.money bot.
 * Used by both harvest-executor (harvests/closes) and keeper (fee rovers/cleanup).
 *
 * Extracted from harvest-executor.ts to allow both modules to build
 * full Meteora CPI account sets without duplicating logic.
 */

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import DLMM from '@meteora-ag/dlmm';
import type { LbPairInfo } from './geyser-subscriber';
import { logger } from './logger';

// SPL Memo program ID (required for Token-2022 V2 CPI)
export const SPL_MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
// Token-2022 program ID
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// ═══ METEORA CPI ACCOUNT RESOLUTION ═══

export interface MeteoraCPIAccounts {
  meteoraPosition: PublicKey;
  lbPair: PublicKey;
  binArrayBitmapExt: PublicKey;
  binArrayLower: PublicKey;
  binArrayUpper: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  eventAuthority: PublicKey;
  dlmmProgram: PublicKey;
  tokenXProgram: PublicKey;
  tokenYProgram: PublicKey;
  memoProgram: PublicKey;
}

/**
 * Resolve all Meteora CPI accounts from a DLMM instance and position.
 * Returns structured named accounts for Anchor .accounts().
 */
export function buildMeteoraCPIAccounts(
  dlmm: any,
  meteoraPos: any,
  binIds: number[],
  poolInfo?: LbPairInfo,
): MeteoraCPIAccounts {
  const lbPair = dlmm.pubkey || dlmm.lbPair?.publicKey;
  const dlmmProgramId = dlmm.program.programId;

  // Use 8-byte i64 LE for bin array PDA seed (not 4-byte i32)
  const BINS_PER_ARRAY = 70;
  const arrayIndices = new Set<number>();
  for (const binId of binIds) {
    arrayIndices.add(Math.floor(binId / BINS_PER_ARRAY));
  }
  const sortedIndices = [...arrayIndices].sort((a, b) => a - b);

  const deriveBinArrayPDA = (idx: number): PublicKey => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(idx), 0);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bin_array'), lbPair.toBuffer(), buf],
      dlmmProgramId
    );
    return pda;
  };

  const binArrayLower = deriveBinArrayPDA(sortedIndices[0] ?? 0);
  const binArrayUpper = deriveBinArrayPDA(sortedIndices[sortedIndices.length - 1] ?? 0);

  const [eventAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    dlmmProgramId
  );

  // Token mints — prefer gRPC-parsed data, fall back to DLMM SDK
  const tokenXMint: PublicKey = poolInfo?.tokenXMint ?? dlmm.lbPair.tokenXMint;
  const tokenYMint: PublicKey = poolInfo?.tokenYMint ?? dlmm.lbPair.tokenYMint;

  // Token programs — use gRPC-parsed program flags (0=SPL, 1=Token-2022)
  let tokenXProgram: PublicKey;
  let tokenYProgram: PublicKey;
  if (poolInfo) {
    tokenXProgram = poolInfo.tokenXProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    tokenYProgram = poolInfo.tokenYProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  } else {
    tokenXProgram = dlmm.tokenX?.owner ?? TOKEN_PROGRAM_ID;
    tokenYProgram = dlmm.tokenY?.owner ?? TOKEN_PROGRAM_ID;
  }

  const binArrayBitmapExt: PublicKey = dlmm.lbPair.binArrayBitmapExtension ?? dlmmProgramId;

  return {
    meteoraPosition: meteoraPos.publicKey,
    lbPair,
    binArrayBitmapExt,
    binArrayLower,
    binArrayUpper,
    reserveX: poolInfo?.reserveX ?? dlmm.lbPair.reserveX,
    reserveY: poolInfo?.reserveY ?? dlmm.lbPair.reserveY,
    tokenXMint,
    tokenYMint,
    eventAuthority: eventAuth,
    dlmmProgram: dlmmProgramId,
    tokenXProgram,
    tokenYProgram,
    memoProgram: SPL_MEMO_PROGRAM_ID,
  };
}

// ═══ DLMM CACHE ═══

const DLMM_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Max cache entries before LRU eviction.
// 2000 keeps the full warm cache for most deployments (~400MB at ~200KB/entry).
// Override via env var if running on constrained infrastructure.
const DLMM_CACHE_MAX_SIZE = parseInt(process.env.DLMM_CACHE_MAX_SIZE || '2000');

const dlmmCache: Map<string, DLMM> = new Map();
const dlmmCacheTimestamps: Map<string, number> = new Map();

import { withRetry } from './retry';

/**
 * Get or create a DLMM instance with 10-minute cache TTL.
 */
export async function getDLMM(connection: Connection, lbPair: PublicKey): Promise<DLMM> {
  const key = lbPair.toBase58();
  const cachedAt = dlmmCacheTimestamps.get(key) ?? 0;
  const isStale = Date.now() - cachedAt > DLMM_CACHE_TTL_MS;

  if (!dlmmCache.has(key) || isStale) {
    const dlmm = await withRetry(
      () => DLMM.create(connection, lbPair),
      `DLMM.create ${key.slice(0, 8)}`
    );
    dlmmCache.set(key, dlmm);
    dlmmCacheTimestamps.set(key, Date.now());

    // LRU eviction — evict oldest-accessed entry when cache exceeds max size
    if (dlmmCache.size > DLMM_CACHE_MAX_SIZE) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, t] of dlmmCacheTimestamps) {
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        dlmmCache.delete(oldestKey);
        dlmmCacheTimestamps.delete(oldestKey);
      }
    }
  }
  return dlmmCache.get(key)!;
}

// Expose cache size for health endpoint
export function getDLMMCacheSize(): number {
  return dlmmCache.size;
}
