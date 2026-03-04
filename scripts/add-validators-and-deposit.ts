import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  StakeProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
  TransactionInstruction, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) throw new Error("Set BOT_KEYPAIR_PATH in bot/.env");

const conn = new Connection(rpc, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

const poolInfo = JSON.parse(fs.readFileSync(new URL("../pool-info.json", import.meta.url).pathname, "utf-8"));
const POOL = new PublicKey(poolInfo.pool);
const MINT = new PublicKey(poolInfo.mint);
const VALIDATOR_LIST = new PublicKey(poolInfo.validatorList);
const RESERVE_STAKE = new PublicKey(poolInfo.reserveStake);
const WITHDRAW_AUTHORITY = new PublicKey(poolInfo.withdrawAuthority);
const MANAGER_FEE_ACCOUNT = new PublicKey(poolInfo.managerFeeAccount);
const SANCTUM_PROGRAM = new PublicKey(poolInfo.program);

const STAKE_CONFIG = new PublicKey("StakeConfig11111111111111111111111111111111");

const VALIDATORS = [
  { name: "MonkeDAO",       vote: new PublicKey("DfpdmTsSCBPxCDwZwgBMfjjV8mF8xHkGRcXP8dJBVmrq") },
  { name: "LP Army (Sign)", vote: new PublicKey("91413b9eEvG6UofpSgwdUgH9Lz4QBF1G3J325Bw7JwGR") },
  { name: "Helius",         vote: new PublicKey("he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk") },
];

function deriveValidatorStakeAccount(pool: PublicKey, vote: PublicKey, seed: number = 0): PublicKey {
  const seeds: Buffer[] = [vote.toBuffer(), pool.toBuffer()];
  if (seed > 0) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(seed);
    seeds.push(buf);
  }
  const [pda] = PublicKey.findProgramAddressSync(seeds, SANCTUM_PROGRAM);
  return pda;
}

async function main() {
  console.log("Pool:", POOL.toBase58());
  console.log("Payer/Staker:", payer.publicKey.toBase58());

  const balance = await conn.getBalance(payer.publicKey);
  console.log("Balance:", balance / LAMPORTS_PER_SOL, "SOL\n");

  // Step 1: Deposit SOL to build up reserve (skip if already funded)
  const reserveBalance = await conn.getBalance(RESERVE_STAKE);
  console.log("Reserve balance:", reserveBalance / LAMPORTS_PER_SOL, "SOL");
  if (reserveBalance > 3 * LAMPORTS_PER_SOL) {
    console.log("Reserve already funded, skipping deposit.\n");
  } else {
    console.log("=== Step 1: Deposit SOL to reserve ===");
  }
  const depositAmount = 0; // Set >0 if reserve needs more funds
  const payerPoolTokenAta = getAssociatedTokenAddressSync(MINT, payer.publicKey);

  // DepositSol instruction (variant index 14)
  const depositData = Buffer.alloc(9);
  depositData.writeUInt8(14, 0);
  depositData.writeBigUInt64LE(BigInt(depositAmount), 1);

  const depositIx = new TransactionInstruction({
    programId: SANCTUM_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: WITHDRAW_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: RESERVE_STAKE, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: payerPoolTokenAta, isSigner: false, isWritable: true },
      { pubkey: MANAGER_FEE_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: payerPoolTokenAta, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: depositData,
  });

  const txDeposit = new Transaction();
  txDeposit.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
  txDeposit.add(depositIx);

  if (depositAmount > 0) {
    const sigDeposit = await sendAndConfirmTransaction(conn, txDeposit, [payer], { commitment: "confirmed" });
    console.log("Deposit TX:", sigDeposit);
  }

  // Step 2: Add each validator
  for (const { name, vote } of VALIDATORS) {
    console.log(`\n=== Adding validator: ${name} (${vote.toBase58()}) ===`);

    const validatorStake = deriveValidatorStakeAccount(POOL, vote);
    console.log("  Validator stake PDA:", validatorStake.toBase58());

    // AddValidatorToPool instruction (variant index 1)
    // Layout: u8(1) + u32(optional_seed, LE)
    const addData = Buffer.alloc(5);
    addData.writeUInt8(1, 0);
    addData.writeUInt32LE(0, 1);

    const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
    const addIx = new TransactionInstruction({
      programId: SANCTUM_PROGRAM,
      keys: [
        { pubkey: POOL, isSigner: false, isWritable: true },                      // 0: stake_pool
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },            // 1: staker
        { pubkey: RESERVE_STAKE, isSigner: false, isWritable: true },              // 2: reserve_stake
        { pubkey: WITHDRAW_AUTHORITY, isSigner: false, isWritable: false },        // 3: withdraw_authority
        { pubkey: VALIDATOR_LIST, isSigner: false, isWritable: true },             // 4: validator_list
        { pubkey: validatorStake, isSigner: false, isWritable: true },             // 5: validator stake PDA
        { pubkey: vote, isSigner: false, isWritable: false },                      // 6: vote account
        { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },               // 7: rent sysvar
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },       // 8: clock sysvar
        { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // 9: stake history
        { pubkey: STAKE_CONFIG, isSigner: false, isWritable: false },              // 10: stake config
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 11: system program
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },    // 12: stake program
      ],
      data: addData,
    });

    const txAdd = new Transaction();
    txAdd.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
    txAdd.add(addIx);

    const sigAdd = await sendAndConfirmTransaction(conn, txAdd, [payer], { commitment: "confirmed" });
    console.log(`  Added! TX: ${sigAdd}`);
  }

  console.log("\n=== All 3 validators added ===");
  console.log("Run `spl-stake-pool list` or check on-chain to verify.");
}

main().catch(e => { console.error(e); process.exit(1); });
