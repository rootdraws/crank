import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  StakeProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
  TransactionInstruction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, MintLayout, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createInitializeMint2Instruction,
} from "@solana/spl-token";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) throw new Error("Set BOT_KEYPAIR_PATH in bot/.env");

const conn = new Connection(rpc, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

const SANCTUM_STAKE_POOL_PROGRAM = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
const MAX_VALIDATORS = 10;

// Borsh layout: struct Fee { denominator: u64, numerator: u64 }
function encodeFee(numerator: number, denominator: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(BigInt(denominator), 0);
  buf.writeBigUInt64LE(BigInt(numerator), 8);
  return buf;
}

// Header = 1 (account_type) + 4 (max_validators u32) + 4 (Borsh Vec length prefix) = 9
// Each ValidatorStakeInfo entry = 73 bytes
function validatorListSpace(maxValidators: number): number {
  return 9 + maxValidators * 73;
}

const STAKE_POOL_ACCOUNT_SPACE = 611;

async function main() {
  console.log("Creating multi-validator stake pool on Sanctum program...");
  console.log("Payer:", payer.publicKey.toBase58());

  const balance = await conn.getBalance(payer.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL");

  const poolKeypair = Keypair.generate();
  const mintKeypair = Keypair.generate();
  const validatorListKeypair = Keypair.generate();
  const reserveStakeKeypair = Keypair.generate();

  console.log("\nGenerated keypairs:");
  console.log("  Pool:", poolKeypair.publicKey.toBase58());
  console.log("  Mint:", mintKeypair.publicKey.toBase58());
  console.log("  Validator list:", validatorListKeypair.publicKey.toBase58());
  console.log("  Reserve stake:", reserveStakeKeypair.publicKey.toBase58());

  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [poolKeypair.publicKey.toBuffer(), Buffer.from("withdraw")],
    SANCTUM_STAKE_POOL_PROGRAM,
  );
  console.log("  Withdraw authority:", withdrawAuthority.toBase58());

  const managerFeeAccount = getAssociatedTokenAddressSync(mintKeypair.publicKey, payer.publicKey);
  console.log("  Manager fee account:", managerFeeAccount.toBase58());

  const poolRent = await conn.getMinimumBalanceForRentExemption(STAKE_POOL_ACCOUNT_SPACE);
  const mintRent = await conn.getMinimumBalanceForRentExemption(MintLayout.span);
  const vlSpace = validatorListSpace(MAX_VALIDATORS);
  const vlRent = await conn.getMinimumBalanceForRentExemption(vlSpace);
  const stakeRent = await conn.getMinimumBalanceForRentExemption(200);
  const reserveMinBalance = stakeRent + 1;

  console.log("\nRent requirements:");
  console.log("  Pool account:", poolRent / LAMPORTS_PER_SOL, "SOL");
  console.log("  Mint:", mintRent / LAMPORTS_PER_SOL, "SOL");
  console.log("  Validator list:", vlRent / LAMPORTS_PER_SOL, "SOL");
  console.log("  Reserve stake:", reserveMinBalance / LAMPORTS_PER_SOL, "SOL");

  // TX 1: Create all raw accounts, initialize mint, create ATA
  console.log("\n--- TX 1: Create accounts ---");

  const tx1 = new Transaction();
  tx1.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));

  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: poolKeypair.publicKey,
      lamports: poolRent,
      space: STAKE_POOL_ACCOUNT_SPACE,
      programId: SANCTUM_STAKE_POOL_PROGRAM,
    }),
  );

  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: validatorListKeypair.publicKey,
      lamports: vlRent,
      space: vlSpace,
      programId: SANCTUM_STAKE_POOL_PROGRAM,
    }),
  );

  // Create mint account + initialize it (mint_authority = withdraw_authority, 9 decimals)
  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      lamports: mintRent,
      space: MintLayout.span,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  tx1.add(
    createInitializeMint2Instruction(
      mintKeypair.publicKey,
      9,
      withdrawAuthority,
      null,
      TOKEN_PROGRAM_ID,
    ),
  );

  // Create reserve stake
  tx1.add(
    StakeProgram.createAccount({
      fromPubkey: payer.publicKey,
      stakePubkey: reserveStakeKeypair.publicKey,
      authorized: {
        staker: withdrawAuthority,
        withdrawer: withdrawAuthority,
      },
      lamports: reserveMinBalance,
    }),
  );

  // Create manager fee ATA (mint is now initialized so this works)
  tx1.add(
    createAssociatedTokenAccountInstruction(
      payer.publicKey,
      managerFeeAccount,
      payer.publicKey,
      mintKeypair.publicKey,
    ),
  );

  const sig1 = await sendAndConfirmTransaction(conn, tx1, [payer, poolKeypair, validatorListKeypair, mintKeypair, reserveStakeKeypair], { commitment: "confirmed" });
  console.log("TX 1 confirmed:", sig1);

  // TX 2: Initialize the stake pool
  console.log("\n--- TX 2: Initialize stake pool ---");

  const epochFee = encodeFee(0, 100);
  const withdrawalFee = encodeFee(1, 1000);
  const depositFee = encodeFee(0, 100);
  const referralFee = 0;

  const initData = Buffer.alloc(1 + 16 + 16 + 16 + 1 + 4);
  let offset = 0;
  initData.writeUInt8(0, offset); offset += 1;
  epochFee.copy(initData, offset); offset += 16;
  withdrawalFee.copy(initData, offset); offset += 16;
  depositFee.copy(initData, offset); offset += 16;
  initData.writeUInt8(referralFee, offset); offset += 1;
  initData.writeUInt32LE(MAX_VALIDATORS, offset);

  const initIx = new TransactionInstruction({
    programId: SANCTUM_STAKE_POOL_PROGRAM,
    keys: [
      { pubkey: poolKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: mintKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  const tx2 = new Transaction();
  tx2.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
  tx2.add(initIx);

  const sig2 = await sendAndConfirmTransaction(conn, tx2, [payer], { commitment: "confirmed" });
  console.log("TX 2 confirmed:", sig2);

  console.log("\n=== STAKE POOL CREATED ===");
  console.log("Pool address:         ", poolKeypair.publicKey.toBase58());
  console.log("Pool mint ($PEGGED):  ", mintKeypair.publicKey.toBase58());
  console.log("Validator list:       ", validatorListKeypair.publicKey.toBase58());
  console.log("Reserve stake:        ", reserveStakeKeypair.publicKey.toBase58());
  console.log("Withdraw authority:   ", withdrawAuthority.toBase58());
  console.log("Manager fee account:  ", managerFeeAccount.toBase58());
  console.log("Manager/Staker:       ", payer.publicKey.toBase58());
  console.log("Max validators:       ", MAX_VALIDATORS);
  console.log("Epoch fee:             0%");
  console.log("Withdrawal fee:        0.1%");
  console.log("Deposit fee:           0%");

  // Save pool info for subsequent scripts
  const poolInfo = {
    pool: poolKeypair.publicKey.toBase58(),
    mint: mintKeypair.publicKey.toBase58(),
    validatorList: validatorListKeypair.publicKey.toBase58(),
    reserveStake: reserveStakeKeypair.publicKey.toBase58(),
    withdrawAuthority: withdrawAuthority.toBase58(),
    managerFeeAccount: managerFeeAccount.toBase58(),
    program: SANCTUM_STAKE_POOL_PROGRAM.toBase58(),
  };
  fs.writeFileSync(
    new URL("../pool-info.json", import.meta.url).pathname,
    JSON.stringify(poolInfo, null, 2),
  );
  console.log("\nPool info saved to pool-info.json");
}

main().catch(e => { console.error(e); process.exit(1); });
