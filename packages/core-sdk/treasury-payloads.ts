/**
 * core-sdk/treasury-payloads.ts
 *
 * Hand-rolled instruction builders for the three new bin-farm ixs added in the
 * cranksettle-folded-into-bin-farm upgrade:
 *
 *   - record_settle_meta(proposer)  — open ix #2
 *   - settle_proposer()             — close ix #1
 *   - close_settle()                — close ix #3
 *
 * These exist as TS-side hand-rolls because the ixs were added to bin-farm
 * Rust but Codama clients haven't been regenerated yet (anchor build needs
 * SBF toolchain). After regen, callers can switch to the generated clients;
 * the on-chain account/data layout is the same.
 *
 * No I/O — pure ix construction. Callers pass pre-resolved account pubkeys.
 */

import { PublicKey, TransactionInstruction, AccountMeta, SystemProgram } from '@solana/web3.js';
import { createHash } from 'crypto';
import { BIN_FARM_PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants';
import {
  getConfigPDA,
  getPositionPDA,
  getPositionSettlePDA,
  getUserVaultPDA,
  getVaultPDA,
} from './pda';

// ─── Anchor discriminator ───────────────────────────────────────────────────

function disc(ixName: string): Buffer {
  return createHash('sha256').update(`global:${ixName}`).digest().subarray(0, 8);
}

const RECORD_SETTLE_META_DISC = disc('record_settle_meta');
const SETTLE_PROPOSER_DISC    = disc('settle_proposer');
const CLOSE_SETTLE_DISC       = disc('close_settle');

// ─── record_settle_meta(proposer) ───────────────────────────────────────────

export interface RecordSettleMetaArgs {
  /** Caller — bot wallet OR vault owner. Must be a signer on the outer tx. */
  caller: PublicKey;
  /** Treasury vault owner (= Native Treasury PDA for treasury opens). */
  treasuryVaultOwner: PublicKey;
  /** The newly-created Meteora position from open_position_v2. */
  meteoraPosition: PublicKey;
  /** Token X mint of the position's lb_pair. */
  tokenXMint: PublicKey;
  /** Token Y mint of the position's lb_pair. */
  tokenYMint: PublicKey;
  /** Wallet pubkey to record as proposer (= user who triggered the matched open). */
  proposer: PublicKey;
}

export function buildRecordSettleMetaIx(args: RecordSettleMetaArgs): TransactionInstruction {
  const [config] = getConfigPDA();
  const [position] = getPositionPDA(args.meteoraPosition);
  const [userVault] = getUserVaultPDA(args.treasuryVaultOwner);
  const [positionSettle] = getPositionSettlePDA(args.meteoraPosition);

  const data = Buffer.concat([RECORD_SETTLE_META_DISC, args.proposer.toBuffer()]);

  return new TransactionInstruction({
    programId: BIN_FARM_PROGRAM_ID,
    keys: [
      { pubkey: args.caller,           isSigner: true,  isWritable: true  },
      { pubkey: config,                isSigner: false, isWritable: false },
      { pubkey: args.meteoraPosition,  isSigner: false, isWritable: false },
      { pubkey: position,              isSigner: false, isWritable: false },
      { pubkey: userVault,             isSigner: false, isWritable: false },
      { pubkey: positionSettle,        isSigner: false, isWritable: true  },
      { pubkey: args.tokenXMint,       isSigner: false, isWritable: false },
      { pubkey: args.tokenYMint,       isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── settle_proposer() ──────────────────────────────────────────────────────

export interface SettleProposerArgs {
  /** Caller — bot or vault owner; signer on outer tx. */
  caller: PublicKey;
  /** Treasury vault owner (= Native Treasury PDA). */
  treasuryVaultOwner: PublicKey;
  /** The position being closed. Per-position vault PDA derived from this. */
  meteoraPosition: PublicKey;
  /** Position vault's ATA for the OUTPUT mint (source of payout transfer). */
  positionVaultOutputAta: PublicKey;
  /** Proposer's ATA for the output mint (destination). Must be owned by the
   *  recorded proposer — bin-farm enforces. */
  proposerOutputAta: PublicKey;
  /** The output mint (SOL=NATIVE_MINT for sells, CRANK for buys). */
  outputMint: PublicKey;
  /** SPL Token program ID — Token or Token-2022. Default Token. */
  tokenProgram?: PublicKey;
}

export function buildSettleProposerIx(args: SettleProposerArgs): TransactionInstruction {
  const [config] = getConfigPDA();
  const [userVault] = getUserVaultPDA(args.treasuryVaultOwner);
  const [positionSettle] = getPositionSettlePDA(args.meteoraPosition);
  const [vault] = getVaultPDA(args.meteoraPosition);
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID;

  return new TransactionInstruction({
    programId: BIN_FARM_PROGRAM_ID,
    keys: [
      { pubkey: args.caller,                isSigner: true,  isWritable: true  },
      { pubkey: config,                     isSigner: false, isWritable: false },
      { pubkey: userVault,                  isSigner: false, isWritable: false },
      { pubkey: positionSettle,             isSigner: false, isWritable: true  },
      { pubkey: vault,                      isSigner: false, isWritable: false },
      { pubkey: args.meteoraPosition,       isSigner: false, isWritable: false },
      { pubkey: args.positionVaultOutputAta, isSigner: false, isWritable: true  },
      { pubkey: args.proposerOutputAta,     isSigner: false, isWritable: true  },
      { pubkey: args.outputMint,            isSigner: false, isWritable: false },
      { pubkey: tokenProgram,               isSigner: false, isWritable: false },
    ],
    data: SETTLE_PROPOSER_DISC,
  });
}

// ─── close_settle() ─────────────────────────────────────────────────────────

export interface CloseSettleArgs {
  /** Caller — bot or vault owner. */
  caller: PublicKey;
  /** Treasury vault owner (= Native Treasury PDA). */
  treasuryVaultOwner: PublicKey;
  /** The closed Meteora position. */
  meteoraPosition: PublicKey;
}

export function buildCloseSettleIx(args: CloseSettleArgs): TransactionInstruction {
  const [config] = getConfigPDA();
  const [userVault] = getUserVaultPDA(args.treasuryVaultOwner);
  const [positionSettle] = getPositionSettlePDA(args.meteoraPosition);

  return new TransactionInstruction({
    programId: BIN_FARM_PROGRAM_ID,
    keys: [
      { pubkey: args.caller,         isSigner: true,  isWritable: true  },
      { pubkey: config,              isSigner: false, isWritable: false },
      { pubkey: userVault,           isSigner: false, isWritable: true  },
      { pubkey: positionSettle,      isSigner: false, isWritable: true  },
      { pubkey: args.meteoraPosition, isSigner: false, isWritable: false },
    ],
    data: CLOSE_SETTLE_DISC,
  });
}

// ─── High-level payload composers ──────────────────────────────────────────

/**
 * Compose the OPEN proposal payload (Path B). The treasury's `open_position_v2`
 * is the caller's responsibility (built via Anchor's coreProgram or generated
 * client) since its account list is large and well-handled by the existing buy.ts
 * flow. This helper just appends `record_settle_meta`.
 */
export function composeOpenPayload(
  treasuryOpenIx: TransactionInstruction,
  recordMetaArgs: RecordSettleMetaArgs,
): TransactionInstruction[] {
  return [treasuryOpenIx, buildRecordSettleMetaIx(recordMetaArgs)];
}

/**
 * Compose the CLOSE proposal payload (Path B treasury close).
 *
 * Order matters:
 *   1. settle_proposer   — pays 20% of OUTPUT to proposer; reads per-position vault BEFORE drain
 *   2. treasury_user_close — drains remaining 80% to treasury vault; closes treasury position
 *   3. close_settle      — refunds PositionSettle PDA rent to treasury vault
 *   4. user_user_close   — OPTIONAL user's Path A close. When provided, the user's
 *                          close runs atomically in the same proposal as the treasury
 *                          close. When omitted, the user's close is expected to run
 *                          separately as a Path A tx (preserves existing v1 simplicity).
 */
export function composeClosePayload(
  settleArgs: SettleProposerArgs,
  treasuryUserCloseIx: TransactionInstruction,
  closeSettleArgs: CloseSettleArgs,
  userUserCloseIx?: TransactionInstruction,
): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [
    buildSettleProposerIx(settleArgs),
    treasuryUserCloseIx,
    buildCloseSettleIx(closeSettleArgs),
  ];
  if (userUserCloseIx) ixs.push(userUserCloseIx);
  return ixs;
}

/** Exported for tests + cross-checking discriminators. */
export const __test = {
  RECORD_SETTLE_META_DISC,
  SETTLE_PROPOSER_DISC,
  CLOSE_SETTLE_DISC,
};

// Avoid unused-import warning when bin-farm program isn't fully exercised here.
export type _AccountMeta = AccountMeta;
