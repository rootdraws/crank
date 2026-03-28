/**
 * core-sdk/pda.ts
 *
 * All PDA derivation functions for crank.money programs.
 * Extracted verbatim from frontend app.js and typed.
 *
 * IMPORTANT: getMeteoraPosiitonPDA has a typo (double 'i') — kept for
 * consistency with the frontend. Do not rename it.
 */

import { PublicKey } from '@solana/web3.js';
import {
  BIN_FARM_PROGRAM_ID,
  MONKE_BANANAS_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
} from './constants';

// ─── bin_farm PDAs ─────────────────────────────────────────────────────────

export function getConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    BIN_FARM_PROGRAM_ID
  );
}

export function getPositionPDA(meteoraPosition: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('position'), meteoraPosition.toBuffer()],
    BIN_FARM_PROGRAM_ID
  );
}

export function getVaultPDA(meteoraPosition: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), meteoraPosition.toBuffer()],
    BIN_FARM_PROGRAM_ID
  );
}

export function getPositionCounterPDA(user: PublicKey, lbPair: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pos_counter'), user.toBuffer(), lbPair.toBuffer()],
    BIN_FARM_PROGRAM_ID
  );
}

/**
 * NOTE: Typo is intentional — matches frontend app.js spelling.
 * The meteora_position PDA is derived from the CURRENT counter value
 * (before increment). Read position_counter.count first, then call this.
 */
export function getMeteoraPosiitonPDA(
  user: PublicKey,
  lbPair: PublicKey,
  count: number
): [PublicKey, number] {
  const countBuf = Buffer.alloc(8);
  countBuf.writeBigUInt64LE(BigInt(count), 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('meteora_pos'), user.toBuffer(), lbPair.toBuffer(), countBuf],
    BIN_FARM_PROGRAM_ID
  );
}

export function getRoverAuthorityPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rover_authority')],
    BIN_FARM_PROGRAM_ID
  );
}

// ─── monke_bananas PDAs ────────────────────────────────────────────────────

export function getMonkeStatePDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('monke_state')],
    MONKE_BANANAS_PROGRAM_ID
  );
}

export function getMonkeBurnPDA(nftMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('monke_burn'), nftMint.toBuffer()],
    MONKE_BANANAS_PROGRAM_ID
  );
}

export function getDistPoolPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('dist_pool')],
    MONKE_BANANAS_PROGRAM_ID
  );
}

export function getProgramVaultPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('program_vault')],
    MONKE_BANANAS_PROGRAM_ID
  );
}

// ─── Meteora DLMM PDAs ─────────────────────────────────────────────────────

/**
 * Derive bin array PDA. Uses i64 LE encoding for the array index.
 */
export function deriveBinArrayPDA(lbPair: PublicKey, arrayIndex: number): PublicKey {
  // Must use i64 signed encoding — BigInt handles two's complement correctly
  const signed = BigInt(arrayIndex);
  const unsigned = signed < 0n ? signed + (1n << 64n) : signed;
  const buf = Buffer.alloc(8);
  for (let byte = 0; byte < 8; byte++) {
    buf[byte] = Number((unsigned >> BigInt(byte * 8)) & 0xFFn);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bin_array'), lbPair.toBuffer(), buf],
    METEORA_DLMM_PROGRAM_ID
  );
  return pda;
}

export function deriveEventAuthorityPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    METEORA_DLMM_PROGRAM_ID
  );
  return pda;
}

export function deriveBitmapExtPDA(lbPair: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bitmap'), lbPair.toBuffer()],
    METEORA_DLMM_PROGRAM_ID
  );
  return pda;
}

/**
 * Convert bin ID to bin array index.
 * Matches Meteora SDK binIdToBinArrayIndex exactly.
 */
export function binIdToBinArrayIndex(binId: number): number {
  const BINS = 70;
  if (binId >= 0) return Math.floor(binId / BINS);
  return Math.floor((binId - (BINS - 1)) / BINS);
}

// ─── Metaplex PDAs ─────────────────────────────────────────────────────────

const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export function getMetadataPDA(nftMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METAPLEX_PROGRAM_ID.toBuffer(),
      nftMint.toBuffer(),
    ],
    METAPLEX_PROGRAM_ID
  );
}
