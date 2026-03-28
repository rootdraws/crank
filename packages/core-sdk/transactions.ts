/**
 * core-sdk/transactions.ts
 *
 * Transaction building utilities: bin array init, ATA setup,
 * SOL wrapping, confirmation, compute budget.
 * Extracted from frontend app.js and typed.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import {
  METEORA_DLMM_PROGRAM_ID,
  DEFAULT_PRIORITY_ULAMPORTS,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from './constants';
import { deriveBinArrayPDA, binIdToBinArrayIndex } from './pda';

// ─── Compute Budget ────────────────────────────────────────────────────────

/**
 * Build SetComputeUnitPrice instruction without Buffer dependency.
 * (Browser-compatible implementation from app.js)
 */
export function makeComputeUnitPriceIx(microLamports: number): TransactionInstruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, BigInt(microLamports), true);
  return new TransactionInstruction({
    programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
    keys: [],
    data: Buffer.from(data),
  });
}

/**
 * Build standard priority fee instructions.
 * Fetches recent fees from RPC, uses median or floor.
 */
export async function buildPriorityFeeIxs(
  connection: Connection,
  units = 400_000
): Promise<TransactionInstruction[]> {
  let microLamports = DEFAULT_PRIORITY_ULAMPORTS;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length > 0) {
      const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      microLamports = Math.max(median, DEFAULT_PRIORITY_ULAMPORTS);
    }
  } catch {
    // Use floor
  }
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    makeComputeUnitPriceIx(microLamports),
  ];
}

// ─── Bin Array Initialization ─────────────────────────────────────────────

/**
 * Build Meteora initializeBinArray instruction.
 * Discriminator: [35, 86, 19, 185, 78, 212, 75, 211] — from IDL.
 */
function buildInitBinArrayIx(
  lbPair: PublicKey,
  binArrayPDA: PublicKey,
  funder: PublicKey,
  arrayIndex: number
): TransactionInstruction {
  const disc = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);
  const argBuf = Buffer.alloc(8);
  // Use signed i64 LE encoding
  const signed = BigInt(arrayIndex);
  const unsigned = signed < 0n ? signed + (1n << 64n) : signed;
  for (let b = 0; b < 8; b++) {
    argBuf[b] = Number((unsigned >> BigInt(b * 8)) & 0xFFn);
  }
  const data = Buffer.concat([disc, argBuf]);

  return new TransactionInstruction({
    programId: METEORA_DLMM_PROGRAM_ID,
    keys: [
      { pubkey: lbPair,                             isSigner: false, isWritable: false },
      { pubkey: binArrayPDA,                        isSigner: false, isWritable: true  },
      { pubkey: funder,                             isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,            isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Check which bin arrays exist and return init instructions for missing ones.
 * Must be sent BEFORE the open_position_v2 transaction.
 */
export async function ensureBinArraysExist(
  connection: Connection,
  lbPair: PublicKey,
  minBinId: number,
  maxBinId: number,
  funder: PublicKey
): Promise<TransactionInstruction[]> {
  const indices = new Set<number>();
  indices.add(binIdToBinArrayIndex(minBinId));
  indices.add(binIdToBinArrayIndex(maxBinId));
  const sorted = [...indices].sort((a, b) => a - b);

  const ixs: TransactionInstruction[] = [];
  for (const idx of sorted) {
    const pda = deriveBinArrayPDA(lbPair, idx);
    const info = await connection.getAccountInfo(pda);
    if (!info) {
      ixs.push(buildInitBinArrayIx(lbPair, pda, funder, idx));
    }
  }
  return ixs;
}

// ─── ATA Setup ─────────────────────────────────────────────────────────────

export interface ATACheck {
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}

/**
 * Create a setup transaction that ensures all required ATAs exist.
 * Also accepts extra instructions (bin array inits, SOL wrapping).
 * Returns null if nothing needs to be done.
 *
 * Send this BEFORE the execute transaction.
 * This separation keeps the execute tx clean (compute budget + 1 instruction).
 */
export async function buildSetupTx(
  connection: Connection,
  payer: PublicKey,
  ataChecks: ATACheck[],
  extraIxs: TransactionInstruction[] = []
): Promise<Transaction | null> {
  const accounts = ataChecks.map(c => c.ata);
  const infos = await connection.getMultipleAccountsInfo(accounts);

  const setupIxs: TransactionInstruction[] = [];
  for (let i = 0; i < ataChecks.length; i++) {
    if (!infos[i]) {
      const c = ataChecks[i];
      setupIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer, c.ata, c.owner, c.mint, c.tokenProgram
        )
      );
    }
  }
  setupIxs.push(...extraIxs);

  if (setupIxs.length === 0) return null;

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_ULAMPORTS));
  for (const ix of setupIxs) tx.add(ix);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer;

  return tx;
}

// ─── SOL Wrapping ─────────────────────────────────────────────────────────

/**
 * Build instructions to wrap SOL into a wSOL ATA.
 * Returns [SystemTransfer, SyncNative] instructions.
 */
export function buildWrapSolIxs(
  from: PublicKey,
  wsolAta: PublicKey,
  lamports: bigint
): TransactionInstruction[] {
  // System transfer
  const transferData = Buffer.alloc(12);
  transferData.writeUInt32LE(2, 0); // transfer variant = 2
  transferData.writeBigUInt64LE(lamports, 4);

  const transferIx = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [
      { pubkey: from,    isSigner: true,  isWritable: true },
      { pubkey: wsolAta, isSigner: false, isWritable: true },
    ],
    data: transferData,
  });

  // SyncNative (variant 17)
  const syncIx = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  });

  return [transferIx, syncIx];
}

// ─── Transaction Confirmation ─────────────────────────────────────────────

/**
 * Confirm transaction AND check for on-chain program errors.
 * confirmTransaction alone does NOT throw on program failures.
 *
 * Extracted verbatim from frontend app.js.
 */
export async function confirmAndCheck(
  connection: Connection,
  sig: string,
  blockhash: string,
  lastValidBlockHeight: number
): Promise<void> {
  const confirmation = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  if (confirmation.value.err) {
    // Fetch logs for better error message
    let anchorErr: string | undefined;
    try {
      const tx = await connection.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages || [];
      anchorErr = logs.find(l =>
        l.includes('Error Number:') ||
        l.includes('AnchorError') ||
        l.includes('failed:')
      );
    } catch {}
    throw new Error(
      anchorErr || `Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`
    );
  }
}

// ─── @solana/kit adapter (for Codama generated clients) ──────────────────

/**
 * Convert a @solana/kit Instruction to @solana/web3.js TransactionInstruction.
 * Codama-generated clients return kit-format instructions.
 */
export function kitIxToWeb3(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((m: any) => ({
      pubkey: new PublicKey(m.address),
      isSigner:   (m.role & 2) !== 0,
      isWritable: (m.role & 1) !== 0,
    })),
    data: Buffer.from(ix.data),
  });
}

/**
 * Wrap a PublicKey as a @solana/kit TransactionSigner shim.
 * Used when Codama expects a signer object.
 */
export function asSigner(pubkey: PublicKey): any {
  const addr = pubkey.toBase58();
  return {
    address: addr,
    signTransactions: async () => {
      throw new Error('use web3.js for signing — asSigner is a shim');
    },
  };
}
