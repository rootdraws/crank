/**
 * core-sdk/whitelist-addin.ts
 *
 * Hand-rolled ix builders + PDA helpers for the proposal-whitelist-addin
 * Anchor program (programs/proposal-whitelist-addin).
 *
 * The addin gates community-side voter weight on SPL Governance proposals.
 * Bot calls update_voter_weight_record in tx1 before castVote; the addin
 * inspects every inner ix in every ProposalTransaction and grants weight
 * iff every ix matches the registrar's whitelist.
 *
 * No I/O — pure ix construction. Caller resolves all account pubkeys.
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import { createHash } from 'crypto';

// SPL Governance VoterWeightAction tags (u8). castVote = 0.
export const VWR_ACTION_CAST_VOTE = 0;
export const VWR_ACTION_COMMENT_PROPOSAL = 1;
export const VWR_ACTION_CREATE_GOVERNANCE = 2;
export const VWR_ACTION_CREATE_PROPOSAL = 3;
export const VWR_ACTION_SIGN_OFF_PROPOSAL = 4;

function disc(ixName: string): Buffer {
  return createHash('sha256').update(`global:${ixName}`).digest().subarray(0, 8);
}

// ─── PDAs ──────────────────────────────────────────────────────────────────

export function getRegistrarPDA(
  addinProgramId: PublicKey,
  realm: PublicKey,
  governingTokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('registrar'), realm.toBuffer(), governingTokenMint.toBuffer()],
    addinProgramId,
  );
}

export function getVoterWeightRecordPDA(
  addinProgramId: PublicKey,
  realm: PublicKey,
  governingTokenMint: PublicKey,
  governingTokenOwner: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('voter-weight-record'),
      realm.toBuffer(),
      governingTokenMint.toBuffer(),
      governingTokenOwner.toBuffer(),
    ],
    addinProgramId,
  );
}

export function getMaxVoterWeightRecordPDA(
  addinProgramId: PublicKey,
  realm: PublicKey,
  governingTokenMint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('max-voter-weight-record'),
      realm.toBuffer(),
      governingTokenMint.toBuffer(),
    ],
    addinProgramId,
  );
}

// ─── Whitelist entry encoding (matches Rust WhitelistEntry) ────────────────

export interface WhitelistEntry {
  programId: PublicKey;
  /** Up to 8 bytes; left-padded with zeros if shorter. discLen carries the real length. */
  discriminator: Buffer;
  discLen: number;
}

function encodeWhitelistEntry(e: WhitelistEntry): Buffer {
  const padded = Buffer.alloc(8);
  e.discriminator.copy(padded, 0, 0, Math.min(e.discriminator.length, 8));
  return Buffer.concat([
    e.programId.toBuffer(),
    padded,
    Buffer.from([e.discLen]),
  ]);
}

// ─── Instruction discriminators ────────────────────────────────────────────

const DISC_CREATE_REGISTRAR = disc('create_registrar');
const DISC_UPDATE_REGISTRAR_WHITELIST = disc('update_registrar_whitelist');
const DISC_SET_REGISTRAR_AUTHORITY = disc('set_registrar_authority');
const DISC_CREATE_VOTER_WEIGHT_RECORD = disc('create_voter_weight_record');
const DISC_UPDATE_VOTER_WEIGHT_RECORD = disc('update_voter_weight_record');
const DISC_CREATE_MAX_VOTER_WEIGHT_RECORD = disc('create_max_voter_weight_record');

// ─── Ix builders ───────────────────────────────────────────────────────────

export interface CreateRegistrarArgs {
  addinProgramId: PublicKey;
  realm: PublicKey;
  governingTokenMint: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
  governanceProgramId: PublicKey;
}

export function buildCreateRegistrarIx(args: CreateRegistrarArgs): TransactionInstruction {
  const [registrar] = getRegistrarPDA(args.addinProgramId, args.realm, args.governingTokenMint);
  const data = Buffer.concat([DISC_CREATE_REGISTRAR, args.governanceProgramId.toBuffer()]);
  return new TransactionInstruction({
    programId: args.addinProgramId,
    keys: [
      { pubkey: registrar,                isSigner: false, isWritable: true  },
      { pubkey: args.realm,               isSigner: false, isWritable: false },
      { pubkey: args.governingTokenMint,  isSigner: false, isWritable: false },
      { pubkey: args.authority,           isSigner: true,  isWritable: false },
      { pubkey: args.payer,               isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface UpdateRegistrarWhitelistArgs {
  addinProgramId: PublicKey;
  realm: PublicKey;
  governingTokenMint: PublicKey;
  authority: PublicKey;
  whitelist: WhitelistEntry[];
}

export function buildUpdateRegistrarWhitelistIx(
  args: UpdateRegistrarWhitelistArgs,
): TransactionInstruction {
  const [registrar] = getRegistrarPDA(args.addinProgramId, args.realm, args.governingTokenMint);
  // Borsh: u32 LE length, then encoded entries
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(args.whitelist.length, 0);
  const encoded = Buffer.concat([
    DISC_UPDATE_REGISTRAR_WHITELIST,
    lenBuf,
    ...args.whitelist.map(encodeWhitelistEntry),
  ]);
  return new TransactionInstruction({
    programId: args.addinProgramId,
    keys: [
      { pubkey: registrar,        isSigner: false, isWritable: true  },
      { pubkey: args.authority,   isSigner: true,  isWritable: false },
    ],
    data: encoded,
  });
}

export interface SetRegistrarAuthorityArgs {
  addinProgramId: PublicKey;
  realm: PublicKey;
  governingTokenMint: PublicKey;
  authority: PublicKey;
  newAuthority: PublicKey;
}

export function buildSetRegistrarAuthorityIx(
  args: SetRegistrarAuthorityArgs,
): TransactionInstruction {
  const [registrar] = getRegistrarPDA(args.addinProgramId, args.realm, args.governingTokenMint);
  const data = Buffer.concat([DISC_SET_REGISTRAR_AUTHORITY, args.newAuthority.toBuffer()]);
  return new TransactionInstruction({
    programId: args.addinProgramId,
    keys: [
      { pubkey: registrar,       isSigner: false, isWritable: true  },
      { pubkey: args.authority,  isSigner: true,  isWritable: false },
    ],
    data,
  });
}

export interface CreateVoterWeightRecordArgs {
  addinProgramId: PublicKey;
  realm: PublicKey;
  governingTokenMint: PublicKey;
  governingTokenOwner: PublicKey;
  payer: PublicKey;
}

export function buildCreateVoterWeightRecordIx(
  args: CreateVoterWeightRecordArgs,
): TransactionInstruction {
  const [registrar] = getRegistrarPDA(args.addinProgramId, args.realm, args.governingTokenMint);
  const [vwr] = getVoterWeightRecordPDA(
    args.addinProgramId, args.realm, args.governingTokenMint, args.governingTokenOwner,
  );
  return new TransactionInstruction({
    programId: args.addinProgramId,
    keys: [
      { pubkey: registrar,                  isSigner: false, isWritable: false },
      { pubkey: args.governingTokenOwner,   isSigner: false, isWritable: false },
      { pubkey: vwr,                        isSigner: false, isWritable: true  },
      { pubkey: args.payer,                 isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },
    ],
    data: DISC_CREATE_VOTER_WEIGHT_RECORD,
  });
}

export interface UpdateVoterWeightRecordArgs {
  addinProgramId: PublicKey;
  realm: PublicKey;
  governingTokenMint: PublicKey;
  governingTokenOwner: PublicKey;
  /** voter_weight_action enum tag (u8). 0 = CastVote. */
  voterWeightAction: number;
  /** The proposal account pubkey. Passed as remaining_accounts[0]. */
  proposal: PublicKey;
  /** ProposalTransaction PDAs in option-major + index-major order. remaining_accounts[1..]. */
  proposalTransactions: PublicKey[];
}

export function buildUpdateVoterWeightRecordIx(
  args: UpdateVoterWeightRecordArgs,
): TransactionInstruction {
  const [registrar] = getRegistrarPDA(args.addinProgramId, args.realm, args.governingTokenMint);
  const [vwr] = getVoterWeightRecordPDA(
    args.addinProgramId, args.realm, args.governingTokenMint, args.governingTokenOwner,
  );
  return new TransactionInstruction({
    programId: args.addinProgramId,
    keys: [
      // Anchor accounts (fixed order, defined by UpdateVoterWeightRecord struct)
      { pubkey: registrar, isSigner: false, isWritable: false },
      { pubkey: vwr,       isSigner: false, isWritable: true  },
      // Remaining accounts: Proposal first, then ProposalTransactions
      { pubkey: args.proposal, isSigner: false, isWritable: false },
      ...args.proposalTransactions.map(pt => ({
        pubkey: pt, isSigner: false, isWritable: false,
      })),
    ],
    data: Buffer.concat([
      DISC_UPDATE_VOTER_WEIGHT_RECORD,
      Buffer.from([args.voterWeightAction & 0xff]),
    ]),
  });
}

export interface CreateMaxVoterWeightRecordArgs {
  addinProgramId: PublicKey;
  realm: PublicKey;
  governingTokenMint: PublicKey;
  payer: PublicKey;
}

export function buildCreateMaxVoterWeightRecordIx(
  args: CreateMaxVoterWeightRecordArgs,
): TransactionInstruction {
  const [registrar] = getRegistrarPDA(args.addinProgramId, args.realm, args.governingTokenMint);
  const [mvwr] = getMaxVoterWeightRecordPDA(
    args.addinProgramId, args.realm, args.governingTokenMint,
  );
  return new TransactionInstruction({
    programId: args.addinProgramId,
    keys: [
      { pubkey: registrar,                isSigner: false, isWritable: false },
      { pubkey: mvwr,                     isSigner: false, isWritable: true  },
      { pubkey: args.payer,               isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data: DISC_CREATE_MAX_VOTER_WEIGHT_RECORD,
  });
}

export const __addinTest = {
  DISC_CREATE_REGISTRAR,
  DISC_UPDATE_REGISTRAR_WHITELIST,
  DISC_CREATE_VOTER_WEIGHT_RECORD,
  DISC_UPDATE_VOTER_WEIGHT_RECORD,
};
