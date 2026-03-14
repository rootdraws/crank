/**
 * update-pool-and-forward.ts
 *
 * One-off script to push SOL through the full fee pipeline:
 *   1. UpdateValidatorListBalance (Sanctum variant 7) — update epoch
 *   2. UpdateStakePoolBalance (Sanctum variant 8) — update totals
 *   3. stake_and_forward — bridge_vault SOL → SPL stake pool → $PEGGED → dist_pool ATA
 *   4. deposit_pegged — dist_pool $PEGGED → program_vault $PEGGED → accumulator
 *
 * This script validates the Sanctum account layouts on-chain.
 * The exact instruction construction is then copied into keeper.ts and app.js.
 *
 * Usage: npx tsx scripts/update-pool-and-forward.ts
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) throw new Error("Set BOT_KEYPAIR_PATH in bot/.env");

const conn = new Connection(rpc, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
const wallet = new Wallet(kp);
const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });

const poolInfo = JSON.parse(fs.readFileSync(new URL("../pool-info.json", import.meta.url).pathname, "utf-8"));

const SANCTUM_PROGRAM = new PublicKey(poolInfo.program);   // SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY
const STAKE_POOL      = new PublicKey(poolInfo.pool);       // 9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg
const PEGGED_MINT     = new PublicKey(poolInfo.mint);       // GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1
const RESERVE_STAKE   = new PublicKey(poolInfo.reserveStake);
const WITHDRAW_AUTH   = new PublicKey(poolInfo.withdrawAuthority);
const MANAGER_FEE     = new PublicKey(poolInfo.managerFeeAccount);
const VALIDATOR_LIST  = new PublicKey(poolInfo.validatorList);
const DIST_POOL_ATA   = new PublicKey(poolInfo.distPoolAta);
const STAKE_PROGRAM   = new PublicKey("Stake11111111111111111111111111111111111111");

const BRIDGE_PROGRAM_ID = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");
const MONKE_PROGRAM_ID  = new PublicKey("myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH");

const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE_PROGRAM_ID);
const [bridgeVault]  = PublicKey.findProgramAddressSync([Buffer.from("bridge_vault")], BRIDGE_PROGRAM_ID);
const bridgePeggedAta = getAssociatedTokenAddressSync(PEGGED_MINT, bridgeVault, true);

const [monkeState]    = PublicKey.findProgramAddressSync([Buffer.from("monke_state")], MONKE_PROGRAM_ID);
const [distPool]      = PublicKey.findProgramAddressSync([Buffer.from("dist_pool")], MONKE_PROGRAM_ID);
const [programVault]  = PublicKey.findProgramAddressSync([Buffer.from("program_vault")], MONKE_PROGRAM_ID);

const idlDir = new URL("../bot/idl", import.meta.url).pathname;
const bridgeIdl = JSON.parse(fs.readFileSync(idlDir + "/pegged_bridge.json", "utf-8"));
const monkeIdl  = JSON.parse(fs.readFileSync(idlDir + "/monke_bananas.json", "utf-8"));
const bridgeProgram = new Program(bridgeIdl, provider);
const monkeProgram  = new Program(monkeIdl, provider);

// ═══════════════════════════════════════════════════════════
// Sanctum pool epoch update — permissionless, zero signers
// ═══════════════════════════════════════════════════════════

interface ValidatorEntry {
  voteAccount: PublicKey;
  validatorSeedSuffix: number;   // u32
  transientSeedSuffix: bigint;   // u64
  lastUpdateEpoch: bigint;       // u64
}

function parseValidatorList(data: Buffer): ValidatorEntry[] {
  // Header: account_type(1) + max_validators(4) = 5 bytes
  // BigVec count: 4 bytes (u32 LE)
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

    // Skip validators marked ReadyForRemoval (status == 2)
    if (status === 2) continue;
    // Skip zero vote accounts (empty slots)
    if (voteAccount.equals(PublicKey.default)) continue;

    entries.push({ voteAccount, validatorSeedSuffix, transientSeedSuffix, lastUpdateEpoch });
  }
  return entries;
}

function deriveValidatorStakePDA(voteAccount: PublicKey, stakePool: PublicKey, seedSuffix: number): PublicKey {
  const seeds: Buffer[] = [voteAccount.toBuffer(), stakePool.toBuffer()];
  if (seedSuffix !== 0) {
    const suffixBuf = Buffer.alloc(4);
    suffixBuf.writeUInt32LE(seedSuffix);
    seeds.push(suffixBuf);
  }
  return PublicKey.findProgramAddressSync(seeds, SANCTUM_PROGRAM)[0];
}

function deriveTransientStakePDA(voteAccount: PublicKey, stakePool: PublicKey, seedSuffix: bigint): PublicKey {
  const seedBuf = Buffer.alloc(8);
  seedBuf.writeBigUInt64LE(seedSuffix);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("transient"), voteAccount.toBuffer(), stakePool.toBuffer(), seedBuf],
    SANCTUM_PROGRAM,
  )[0];
}

function buildUpdateValidatorListBalanceIx(validators: ValidatorEntry[]): TransactionInstruction {
  // Variant 6: data = [6, start_index: u32 LE, no_merge: bool] = 6 bytes
  // (Enum indices: 0=Init, 1=AddValidator, 2=RemoveValidator, 3=DecreaseStake,
  //  4=IncreaseStake, 5=SetPreferred, 6=UpdateValidatorListBalance, 7=UpdateStakePoolBalance)
  const data = Buffer.alloc(6);
  data[0] = 6;
  data.writeUInt32LE(0, 1);  // start_index = 0
  data[5] = 0;               // no_merge = false

  const keys = [
    { pubkey: STAKE_POOL,    isSigner: false, isWritable: false }, // 0: stake_pool (READONLY)
    { pubkey: WITHDRAW_AUTH, isSigner: false, isWritable: false }, // 1: withdraw_authority (READONLY)
    { pubkey: VALIDATOR_LIST,isSigner: false, isWritable: true  }, // 2: validator_list (WRITABLE)
    { pubkey: RESERVE_STAKE, isSigner: false, isWritable: true  }, // 3: reserve_stake (WRITABLE)
    { pubkey: SYSVAR_CLOCK_PUBKEY,         isSigner: false, isWritable: false }, // 4: clock
    { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // 5: stake_history
    { pubkey: STAKE_PROGRAM, isSigner: false, isWritable: false }, // 6: stake_program
  ];

  for (const v of validators) {
    const validatorStake  = deriveValidatorStakePDA(v.voteAccount, STAKE_POOL, v.validatorSeedSuffix);
    const transientStake  = deriveTransientStakePDA(v.voteAccount, STAKE_POOL, v.transientSeedSuffix);
    keys.push({ pubkey: validatorStake,  isSigner: false, isWritable: true });
    keys.push({ pubkey: transientStake,  isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({ programId: SANCTUM_PROGRAM, keys, data });
}

function buildUpdateStakePoolBalanceIx(): TransactionInstruction {
  // Variant 7: data = [7] (no fields)
  const data = Buffer.from([7]);

  const keys = [
    { pubkey: STAKE_POOL,    isSigner: false, isWritable: true  }, // 0: stake_pool (WRITABLE)
    { pubkey: WITHDRAW_AUTH, isSigner: false, isWritable: false }, // 1: withdraw_authority (READONLY)
    { pubkey: VALIDATOR_LIST,isSigner: false, isWritable: true  }, // 2: validator_list (WRITABLE)
    { pubkey: RESERVE_STAKE, isSigner: false, isWritable: false }, // 3: reserve_stake (READONLY)
    { pubkey: MANAGER_FEE,   isSigner: false, isWritable: true  }, // 4: manager_fee_account (WRITABLE)
    { pubkey: PEGGED_MINT,   isSigner: false, isWritable: true  }, // 5: pool_mint (WRITABLE)
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 6: token_program (READONLY)
  ];

  return new TransactionInstruction({ programId: SANCTUM_PROGRAM, keys, data });
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log("=== Update Pool & Forward Pipeline ===\n");
  console.log("Signer:          ", kp.publicKey.toBase58());
  console.log("Stake pool:      ", STAKE_POOL.toBase58());
  console.log("Validator list:  ", VALIDATOR_LIST.toBase58());
  console.log("Bridge vault:    ", bridgeVault.toBase58());

  // Check bridge vault balance
  const vaultBalance = await conn.getBalance(bridgeVault);
  const rent = 890880;
  const available = vaultBalance - rent;
  console.log(`\nBridge vault:     ${vaultBalance / 1e9} SOL (${available / 1e9} available after rent)`);

  if (available < 10_000_000) {
    console.log("⚠ Bridge vault has < 0.01 SOL available. stake_and_forward will skip.");
  }

  // ─── Step 1: Parse validator list and update epoch ───
  console.log("\n─── Step 1: UpdateValidatorListBalance ───");

  const validatorListInfo = await conn.getAccountInfo(VALIDATOR_LIST);
  if (!validatorListInfo) throw new Error("Validator list account not found");

  const validators = parseValidatorList(validatorListInfo.data as Buffer);
  console.log(`Found ${validators.length} active validator(s):`);

  const epochInfo = await conn.getEpochInfo();
  const currentEpoch = BigInt(epochInfo.epoch);

  for (const v of validators) {
    const stale = v.lastUpdateEpoch < currentEpoch;
    const validatorStake = deriveValidatorStakePDA(v.voteAccount, STAKE_POOL, v.validatorSeedSuffix);
    const transientStake = deriveTransientStakePDA(v.voteAccount, STAKE_POOL, v.transientSeedSuffix);
    console.log(`  vote: ${v.voteAccount.toBase58().slice(0, 8)}... seed=${v.validatorSeedSuffix} epoch=${v.lastUpdateEpoch} ${stale ? '(STALE)' : '(current)'}`);
    console.log(`    validator_stake: ${validatorStake.toBase58()}`);
    console.log(`    transient_stake: ${transientStake.toBase58()}`);
  }

  const anyStale = validators.some(v => v.lastUpdateEpoch < currentEpoch);
  if (!anyStale) {
    console.log("\nAll validators already updated for current epoch. Skipping epoch update.");
  }

  // Build epoch update TX (always send — it's idempotent if already current)
  const updateTx = new Transaction();
  updateTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  updateTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  updateTx.add(buildUpdateValidatorListBalanceIx(validators));
  updateTx.add(buildUpdateStakePoolBalanceIx());

  console.log("\nSending UpdateValidatorListBalance + UpdateStakePoolBalance...");
  const updateSig = await sendAndConfirmTransaction(conn, updateTx, [kp], { commitment: "confirmed" });
  console.log("✓ Pool epoch update TX:", updateSig);

  // ─── Step 2: stake_and_forward ───
  console.log("\n─── Step 2: stake_and_forward ───");

  if (available < 10_000_000) {
    console.log("Skipping stake_and_forward — not enough SOL in bridge vault");
  } else {
    const sfTx = await bridgeProgram.methods
      .stakeAndForward()
      .accounts({
        crank: kp.publicKey,
        config: bridgeConfig,
        bridgeVault,
        bridgePeggedAta,
        distPoolPeggedAta: DIST_POOL_ATA,
        peggedMint: PEGGED_MINT,
        stakePool: STAKE_POOL,
        stakePoolWithdrawAuthority: WITHDRAW_AUTH,
        reserveStake: RESERVE_STAKE,
        managerFeeAccount: MANAGER_FEE,
        stakePoolProgram: SANCTUM_PROGRAM,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ])
      .signers([kp])
      .rpc();

    console.log("✓ stake_and_forward TX:", sfTx);
  }

  // ─── Step 3: deposit_pegged ───
  console.log("\n─── Step 3: deposit_pegged ───");

  const distPoolPeggedAta = getAssociatedTokenAddressSync(PEGGED_MINT, distPool, true);
  const programVaultPeggedAta = getAssociatedTokenAddressSync(PEGGED_MINT, programVault, true);

  // Check dist pool $PEGGED balance
  const distPoolAtaInfo = await conn.getAccountInfo(distPoolPeggedAta);
  const peggedBalance = distPoolAtaInfo && distPoolAtaInfo.data.length >= 72
    ? Number(distPoolAtaInfo.data.readBigUInt64LE(64))
    : 0;
  console.log(`Dist pool $PEGGED balance: ${peggedBalance / 1e9}`);

  if (peggedBalance === 0) {
    console.log("Skipping deposit_pegged — no $PEGGED in dist pool");
  } else {
    const dpTx = await monkeProgram.methods
      .depositPegged()
      .accounts({
        caller: kp.publicKey,
        state: monkeState,
        distPool,
        distPoolPeggedAta,
        programVaultPeggedAta,
        programVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ])
      .signers([kp])
      .rpc();

    console.log("✓ deposit_pegged TX:", dpTx);
  }

  // ─── Summary ───
  console.log("\n─── Summary ───");
  const finalVaultBal = await conn.getBalance(bridgeVault);
  console.log(`Bridge vault:  ${finalVaultBal / 1e9} SOL`);

  const finalDistInfo = await conn.getAccountInfo(distPoolPeggedAta);
  const finalDistBal = finalDistInfo && finalDistInfo.data.length >= 72
    ? Number(finalDistInfo.data.readBigUInt64LE(64))
    : 0;
  console.log(`Dist pool:     ${finalDistBal / 1e9} $PEGGED`);

  const finalVaultPeggedInfo = await conn.getAccountInfo(programVaultPeggedAta);
  const finalVaultPegged = finalVaultPeggedInfo && finalVaultPeggedInfo.data.length >= 72
    ? Number(finalVaultPeggedInfo.data.readBigUInt64LE(64))
    : 0;
  console.log(`Program vault: ${finalVaultPegged / 1e9} $PEGGED (claimable by holders)`);

  console.log("\n✓ Pipeline complete.");
}

main().catch(e => { console.error(e); process.exit(1); });
