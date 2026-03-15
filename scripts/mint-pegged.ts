/**
 * mint-pegged.ts
 *
 * Deposit SOL directly into the Sanctum SPL stake pool to mint $PEGGED (crankSOL).
 * Prepends epoch update instructions so it works at any point in the epoch.
 *
 * Usage: npx tsx scripts/mint-pegged.ts <amount_in_sol>
 * Example: npx tsx scripts/mint-pegged.ts 1.5
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) throw new Error("Set BOT_KEYPAIR_PATH in bot/.env");

const conn = new Connection(rpc, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

const poolInfo = JSON.parse(fs.readFileSync(new URL("../pool-info.json", import.meta.url).pathname, "utf-8"));

const SANCTUM_PROGRAM = new PublicKey(poolInfo.program);
const STAKE_POOL      = new PublicKey(poolInfo.pool);
const PEGGED_MINT     = new PublicKey(poolInfo.mint);
const RESERVE_STAKE   = new PublicKey(poolInfo.reserveStake);
const WITHDRAW_AUTH   = new PublicKey(poolInfo.withdrawAuthority);
const MANAGER_FEE     = new PublicKey(poolInfo.managerFeeAccount);
const VALIDATOR_LIST  = new PublicKey(poolInfo.validatorList);
const STAKE_PROGRAM   = new PublicKey("Stake11111111111111111111111111111111111111");

// ─── Validator list parsing (same as update-pool-and-forward.ts) ───

interface ValidatorEntry {
  voteAccount: PublicKey;
  validatorSeedSuffix: number;
  transientSeedSuffix: bigint;
  lastUpdateEpoch: bigint;
}

function parseValidatorList(data: Buffer): ValidatorEntry[] {
  const count = data.readUInt32LE(5);
  const ENTRY_SIZE = 73;
  const ENTRIES_OFFSET = 9;
  const entries: ValidatorEntry[] = [];
  for (let i = 0; i < count; i++) {
    const off = ENTRIES_OFFSET + i * ENTRY_SIZE;
    if (off + ENTRY_SIZE > data.length) break;
    const lastUpdateEpoch     = data.readBigUInt64LE(off + 16);
    const transientSeedSuffix = data.readBigUInt64LE(off + 24);
    const validatorSeedSuffix = data.readUInt32LE(off + 36);
    const status              = data[off + 40];
    const voteAccount         = new PublicKey(data.subarray(off + 41, off + 73));
    if (status === 2 || voteAccount.equals(PublicKey.default)) continue;
    entries.push({ voteAccount, validatorSeedSuffix, transientSeedSuffix, lastUpdateEpoch });
  }
  return entries;
}

function deriveValidatorStakePDA(voteAccount: PublicKey, stakePool: PublicKey, seedSuffix: number): PublicKey {
  const seeds: Buffer[] = [voteAccount.toBuffer(), stakePool.toBuffer()];
  if (seedSuffix !== 0) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(seedSuffix);
    seeds.push(buf);
  }
  return PublicKey.findProgramAddressSync(seeds, SANCTUM_PROGRAM)[0];
}

function deriveTransientStakePDA(voteAccount: PublicKey, stakePool: PublicKey, seedSuffix: bigint): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(seedSuffix);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transient"), voteAccount.toBuffer(), stakePool.toBuffer(), buf],
    SANCTUM_PROGRAM,
  )[0];
}

function buildUpdateValidatorListBalanceIx(validators: ValidatorEntry[]): TransactionInstruction {
  const data = Buffer.alloc(6);
  data[0] = 6;
  data.writeUInt32LE(0, 1);
  data[5] = 0;
  const keys = [
    { pubkey: STAKE_POOL,    isSigner: false, isWritable: false },
    { pubkey: WITHDRAW_AUTH, isSigner: false, isWritable: false },
    { pubkey: VALIDATOR_LIST,isSigner: false, isWritable: true  },
    { pubkey: RESERVE_STAKE, isSigner: false, isWritable: true  },
    { pubkey: SYSVAR_CLOCK_PUBKEY,         isSigner: false, isWritable: false },
    { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: STAKE_PROGRAM, isSigner: false, isWritable: false },
  ];
  for (const v of validators) {
    keys.push({ pubkey: deriveValidatorStakePDA(v.voteAccount, STAKE_POOL, v.validatorSeedSuffix), isSigner: false, isWritable: true });
    keys.push({ pubkey: deriveTransientStakePDA(v.voteAccount, STAKE_POOL, v.transientSeedSuffix), isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({ programId: SANCTUM_PROGRAM, keys, data });
}

function buildUpdateStakePoolBalanceIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: SANCTUM_PROGRAM,
    keys: [
      { pubkey: STAKE_POOL,    isSigner: false, isWritable: true  },
      { pubkey: WITHDRAW_AUTH, isSigner: false, isWritable: false },
      { pubkey: VALIDATOR_LIST,isSigner: false, isWritable: true  },
      { pubkey: RESERVE_STAKE, isSigner: false, isWritable: false },
      { pubkey: MANAGER_FEE,   isSigner: false, isWritable: true  },
      { pubkey: PEGGED_MINT,   isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([7]),
  });
}

// ─── DepositSol (SPL Stake Pool variant 14) ───

function buildDepositSolIx(depositor: PublicKey, destAta: PublicKey, lamports: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 14;
  data.writeBigUInt64LE(lamports, 1);

  return new TransactionInstruction({
    programId: SANCTUM_PROGRAM,
    keys: [
      { pubkey: STAKE_POOL,       isSigner: false, isWritable: true  },
      { pubkey: WITHDRAW_AUTH,    isSigner: false, isWritable: false },
      { pubkey: RESERVE_STAKE,    isSigner: false, isWritable: true  },
      { pubkey: depositor,        isSigner: true,  isWritable: true  },
      { pubkey: destAta,          isSigner: false, isWritable: true  },
      { pubkey: MANAGER_FEE,      isSigner: false, isWritable: true  },
      { pubkey: destAta,          isSigner: false, isWritable: true  }, // referral = self (no referrer)
      { pubkey: PEGGED_MINT,      isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ─── Main ───

async function main() {
  const amountArg = process.argv[2];
  if (!amountArg) {
    console.error("Usage: npx tsx scripts/mint-pegged.ts <amount_in_sol>");
    console.error("Example: npx tsx scripts/mint-pegged.ts 1.5");
    process.exit(1);
  }

  const solAmount = parseFloat(amountArg);
  if (isNaN(solAmount) || solAmount <= 0) {
    console.error("Invalid amount. Provide a positive number of SOL.");
    process.exit(1);
  }

  const lamports = BigInt(Math.round(solAmount * 1e9));
  const userPeggedAta = getAssociatedTokenAddressSync(PEGGED_MINT, kp.publicKey);

  console.log("=== Mint $PEGGED (crankSOL) ===\n");
  console.log("Depositor:   ", kp.publicKey.toBase58());
  console.log("Amount:      ", solAmount, "SOL");
  console.log("Stake pool:  ", STAKE_POOL.toBase58());
  console.log("$PEGGED mint:", PEGGED_MINT.toBase58());
  console.log("Dest ATA:    ", userPeggedAta.toBase58());

  const balance = await conn.getBalance(kp.publicKey);
  console.log(`\nWallet balance: ${balance / 1e9} SOL`);
  if (BigInt(balance) < lamports + 10_000_000n) {
    console.error("Insufficient balance (need amount + ~0.01 SOL for fees/rent).");
    process.exit(1);
  }

  // Parse validator list for epoch update
  const validatorListInfo = await conn.getAccountInfo(VALIDATOR_LIST);
  if (!validatorListInfo) throw new Error("Validator list account not found");
  const validators = parseValidatorList(validatorListInfo.data as Buffer);
  console.log(`\nValidators: ${validators.length}`);

  // TX 1: Epoch update (idempotent if already current)
  console.log("\n─── Epoch update ───");
  const updateTx = new Transaction();
  updateTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  updateTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  updateTx.add(buildUpdateValidatorListBalanceIx(validators));
  updateTx.add(buildUpdateStakePoolBalanceIx());

  const updateSig = await sendAndConfirmTransaction(conn, updateTx, [kp], { commitment: "confirmed" });
  console.log("Epoch update TX:", updateSig);

  // TX 2: Create ATA (if needed) + DepositSol
  console.log("\n─── DepositSol ───");
  const depositTx = new Transaction();
  depositTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  depositTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  depositTx.add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, userPeggedAta, kp.publicKey, PEGGED_MINT));
  depositTx.add(buildDepositSolIx(kp.publicKey, userPeggedAta, lamports));

  const depositSig = await sendAndConfirmTransaction(conn, depositTx, [kp], { commitment: "confirmed" });
  console.log("DepositSol TX:", depositSig);

  // Check result
  const ataInfo = await conn.getAccountInfo(userPeggedAta);
  const peggedBalance = ataInfo && ataInfo.data.length >= 72
    ? Number(ataInfo.data.readBigUInt64LE(64))
    : 0;
  console.log(`\n$PEGGED balance: ${peggedBalance / 1e9}`);
  console.log("\nDone. Verify: https://solscan.io/tx/" + depositSig);
}

main().catch(e => { console.error(e); process.exit(1); });
