/**
 * core-sdk/meteora.ts
 *
 * Meteora DLMM account resolution and pool data parsing.
 * Extracted from frontend app.js and typed.
 *
 * This is the most important file in core-sdk.
 * resolveMeteoraCPIAccounts() builds all 18 accounts needed for open_position_v2.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  LBPAIR_EXPECTED_SIZE,
  LBPAIR_OFFSETS,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
} from './constants';
import {
  deriveBinArrayPDA,
  deriveBitmapExtPDA,
  deriveEventAuthorityPDA,
  binIdToBinArrayIndex,
} from './pda';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface LbPairData {
  activeId: number;
  binStep: number;
  status: number;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  /** 0 = SPL Token, 1 = Token-2022 */
  tokenXProgramFlag: number;
  /** 0 = SPL Token, 1 = Token-2022 */
  tokenYProgramFlag: number;
}

export interface MeteoraCPIAccounts {
  lbPair: PublicKey;
  binArrayBitmapExt: PublicKey;  // DLMM program ID if no extension exists
  binArrayLower: PublicKey;
  binArrayUpper: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  eventAuthority: PublicKey;
  dlmmProgram: PublicKey;
  tokenXProgramId: PublicKey;
  tokenYProgramId: PublicKey;
}

// ─── Pool Parsing ──────────────────────────────────────────────────────────

/**
 * Parse LbPair account data from raw bytes.
 * Verified against Meteora DLMM IDL + live mainnet accounts.
 * Account must be exactly 904 bytes.
 */
export function parseLbPairData(data: Buffer): LbPairData {
  if (data.length !== LBPAIR_EXPECTED_SIZE) {
    throw new Error(`Not a DLMM pool (expected ${LBPAIR_EXPECTED_SIZE} bytes, got ${data.length})`);
  }

  const activeId = data.readInt32LE(LBPAIR_OFFSETS.ACTIVE_ID);
  const binStep  = data.readUInt16LE(LBPAIR_OFFSETS.BIN_STEP);

  if (binStep === 0 || binStep > 500) {
    throw new Error(`Invalid bin_step ${binStep} — account may not be an LbPair`);
  }

  return {
    activeId,
    binStep,
    status:            data.readUInt8(LBPAIR_OFFSETS.STATUS),
    tokenXMint:        new PublicKey(data.subarray(LBPAIR_OFFSETS.TOKEN_X_MINT, LBPAIR_OFFSETS.TOKEN_X_MINT + 32)),
    tokenYMint:        new PublicKey(data.subarray(LBPAIR_OFFSETS.TOKEN_Y_MINT, LBPAIR_OFFSETS.TOKEN_Y_MINT + 32)),
    reserveX:          new PublicKey(data.subarray(LBPAIR_OFFSETS.RESERVE_X, LBPAIR_OFFSETS.RESERVE_X + 32)),
    reserveY:          new PublicKey(data.subarray(LBPAIR_OFFSETS.RESERVE_Y, LBPAIR_OFFSETS.RESERVE_Y + 32)),
    tokenXProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_X_PROG_FLAG),
    tokenYProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_Y_PROG_FLAG),
  };
}

/**
 * Fetch and parse LbPair account from on-chain.
 */
export async function parseLbPairFull(
  connection: Connection,
  poolAddress: string | PublicKey
): Promise<LbPairData> {
  const pubkey = typeof poolAddress === 'string' ? new PublicKey(poolAddress) : poolAddress;
  const accountInfo = await connection.getAccountInfo(pubkey);
  if (!accountInfo) throw new Error('Pool account not found');
  return parseLbPairData(Buffer.from(accountInfo.data));
}

// ─── CPI Account Resolution ────────────────────────────────────────────────

/**
 * Resolve all Meteora CPI accounts needed for open_position_v2.
 * Reads LbPair on-chain for reserves/mints/token program flags.
 *
 * This is the gold standard account resolver — do not rewrite it.
 * It handles Token-2022 pools correctly via tokenXProgramFlag/tokenYProgramFlag.
 */
export async function resolveMeteoraCPIAccounts(
  connection: Connection,
  poolAddress: string | PublicKey,
  minBinId: number,
  maxBinId: number
): Promise<MeteoraCPIAccounts> {
  const lbPairPubkey = typeof poolAddress === 'string'
    ? new PublicKey(poolAddress)
    : poolAddress;

  const pool = await parseLbPairFull(connection, lbPairPubkey);

  // Bin arrays
  const lowerIdx = binIdToBinArrayIndex(minBinId);
  const upperIdx = binIdToBinArrayIndex(maxBinId);
  const binArrayLower = deriveBinArrayPDA(lbPairPubkey, lowerIdx);
  const binArrayUpper = deriveBinArrayPDA(lbPairPubkey, upperIdx);

  // Event authority
  const eventAuthority = deriveEventAuthorityPDA();

  // Bitmap extension — use DLMM program ID as placeholder if account doesn't exist
  const bitmapExtPDA = deriveBitmapExtPDA(lbPairPubkey);
  let binArrayBitmapExt: PublicKey;
  try {
    const bitmapInfo = await connection.getAccountInfo(bitmapExtPDA);
    binArrayBitmapExt = bitmapInfo ? bitmapExtPDA : METEORA_DLMM_PROGRAM_ID;
  } catch {
    binArrayBitmapExt = METEORA_DLMM_PROGRAM_ID;
  }

  // Token programs — critical for Token-2022 support
  const tokenXProgramId = pool.tokenXProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const tokenYProgramId = pool.tokenYProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  return {
    lbPair: lbPairPubkey,
    binArrayBitmapExt,
    binArrayLower,
    binArrayUpper,
    reserveX: pool.reserveX,
    reserveY: pool.reserveY,
    tokenXMint: pool.tokenXMint,
    tokenYMint: pool.tokenYMint,
    eventAuthority,
    dlmmProgram: METEORA_DLMM_PROGRAM_ID,
    tokenXProgramId,
    tokenYProgramId,
  };
}

// ─── ATA Helpers ───────────────────────────────────────────────────────────

/**
 * Derive ATA with correct token program (handles Token-2022).
 * For vault PDAs (off-curve): allowOwnerOffCurve = true.
 */
export function deriveATA(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey,
  allowOwnerOffCurve = false
): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, tokenProgramId);
}
