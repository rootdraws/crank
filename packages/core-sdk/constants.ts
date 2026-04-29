/**
 * core-sdk/constants.ts
 *
 * All program IDs, token mints, and constants for crank.money.
 * SOURCE OF TRUTH — do not hardcode these anywhere else.
 */

import { PublicKey } from '@solana/web3.js';

// ─── Program IDs ───────────────────────────────────────────────────────────

export const BIN_FARM_PROGRAM_ID     = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
export const HOPPER_PROGRAM_ID       = new PublicKey('2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF');
export const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// ─── Token Programs ────────────────────────────────────────────────────────

export const TOKEN_PROGRAM_ID        = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID   = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PID    = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SPL_MEMO_PROGRAM_ID     = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const NATIVE_MINT             = new PublicKey('So11111111111111111111111111111111111111112');

// ─── Token Mints ───────────────────────────────────────────────────────────

export const CRANK_MINT  = new PublicKey('Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump');
export const BANK_MINT   = new PublicKey('BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA');
export const USDC_MINT   = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// ─── LbPair Account Layout ─────────────────────────────────────────────────
// Verified against Meteora DLMM IDL + live mainnet accounts. 904 bytes total.

export const LBPAIR_EXPECTED_SIZE = 904;
export const LBPAIR_OFFSETS = {
  ACTIVE_ID:         76,   // i32  — current active bin
  BIN_STEP:          80,   // u16  — bin step in bps
  STATUS:            82,   // u8
  TOKEN_X_MINT:      88,   // pubkey (32 bytes)
  TOKEN_Y_MINT:      120,  // pubkey (32 bytes)
  RESERVE_X:         152,  // pubkey (32 bytes)
  RESERVE_Y:         184,  // pubkey (32 bytes)
  TOKEN_X_PROG_FLAG: 880,  // u8 — 0=SPL Token, 1=Token-2022
  TOKEN_Y_PROG_FLAG: 881,  // u8
} as const;

// ─── Bin Array Layout ──────────────────────────────────────────────────────
// From Meteora DLMM IDL (repr C, bytemuck layout)

export const BINS_PER_ARRAY    = 70;
export const BIN_ARRAY_HEADER  = 56;   // discriminator(8) + index(8) + version(1) + padding(7) + lb_pair(32)
export const BIN_SIZE          = 144;  // full bin struct size
export const BIN_AMOUNT_X_OFF  = 0;   // u64 at offset 0 within bin
export const BIN_AMOUNT_Y_OFF  = 8;   // u64 at offset 8 within bin

// ─── Protocol Constants ────────────────────────────────────────────────────

export const DEFAULT_FEE_BPS          = 50;       // 0.5%
export const MAX_POSITION_WIDTH       = 70;       // max bins per position
export const MIN_POSITION_AMOUNT      = 10_000n;  // base units, anti-griefing
export const DEFAULT_PRIORITY_ULAMPORTS = 100_000; // microlamports per CU

// ─── Known Token Symbols (for display) ────────────────────────────────────

export const KNOWN_TOKENS: Record<string, string> = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump': 'CRANK',
  'BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA': 'BANK',
};

