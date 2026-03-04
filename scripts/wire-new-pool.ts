import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
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
const wallet = new Wallet(kp);
const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });

const poolInfo = JSON.parse(fs.readFileSync(new URL("../pool-info.json", import.meta.url).pathname, "utf-8"));
const NEW_POOL = new PublicKey(poolInfo.pool);
const NEW_MINT = new PublicKey(poolInfo.mint);

const idlDir = new URL("../bot/idl", import.meta.url).pathname;
const bridgeIdl = JSON.parse(fs.readFileSync(idlDir + "/pegged_bridge.json", "utf-8"));
const monkeIdl = JSON.parse(fs.readFileSync(idlDir + "/monke_bananas.json", "utf-8"));
const bridgeProgram = new Program(bridgeIdl, provider);
const monkeProgram = new Program(monkeIdl, provider);

const BRIDGE_PROGRAM_ID = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");
const MONKE_PROGRAM_ID = new PublicKey("myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH");

const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE_PROGRAM_ID);
const [bridgeVault] = PublicKey.findProgramAddressSync([Buffer.from("bridge_vault")], BRIDGE_PROGRAM_ID);
const [distPool] = PublicKey.findProgramAddressSync([Buffer.from("dist_pool")], MONKE_PROGRAM_ID);
const [programVault] = PublicKey.findProgramAddressSync([Buffer.from("program_vault")], MONKE_PROGRAM_ID);
const [monkeState] = PublicKey.findProgramAddressSync([Buffer.from("monke_state")], MONKE_PROGRAM_ID);

async function main() {
  console.log("=== Wire new pool to existing programs ===");
  console.log("New pool:", NEW_POOL.toBase58());
  console.log("New mint:", NEW_MINT.toBase58());
  console.log("Payer:", kp.publicKey.toBase58());
  console.log();

  // Step 1: Create ATAs for new mint on all 3 PDAs
  const bridgeVaultAta = getAssociatedTokenAddressSync(NEW_MINT, bridgeVault, true);
  const distPoolAta = getAssociatedTokenAddressSync(NEW_MINT, distPool, true);
  const programVaultAta = getAssociatedTokenAddressSync(NEW_MINT, programVault, true);

  console.log("Bridge vault ATA:", bridgeVaultAta.toBase58());
  console.log("Dist pool ATA:", distPoolAta.toBase58());
  console.log("Program vault ATA:", programVaultAta.toBase58());
  console.log();

  // Check which ATAs already exist
  const ataChecks = await Promise.all([
    conn.getAccountInfo(bridgeVaultAta),
    conn.getAccountInfo(distPoolAta),
    conn.getAccountInfo(programVaultAta),
  ]);

  const tx1 = new Transaction();
  tx1.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }));
  let ataCount = 0;

  if (!ataChecks[0]) {
    tx1.add(createAssociatedTokenAccountInstruction(kp.publicKey, bridgeVaultAta, bridgeVault, NEW_MINT));
    ataCount++;
    console.log("  Creating bridge_vault ATA...");
  } else {
    console.log("  bridge_vault ATA already exists.");
  }
  if (!ataChecks[1]) {
    tx1.add(createAssociatedTokenAccountInstruction(kp.publicKey, distPoolAta, distPool, NEW_MINT));
    ataCount++;
    console.log("  Creating dist_pool ATA...");
  } else {
    console.log("  dist_pool ATA already exists.");
  }
  if (!ataChecks[2]) {
    tx1.add(createAssociatedTokenAccountInstruction(kp.publicKey, programVaultAta, programVault, NEW_MINT));
    ataCount++;
    console.log("  Creating program_vault ATA...");
  } else {
    console.log("  program_vault ATA already exists.");
  }

  if (ataCount > 0) {
    const sig1 = await sendAndConfirmTransaction(conn, tx1, [kp], { commitment: "confirmed" });
    console.log(`\nCreated ${ataCount} ATAs. TX: ${sig1}`);
  }

  // Step 2: Call update_config on bridge (new params: stake_pool, pegged_mint, dist_pool_ata)
  console.log("\n--- Step 2: update_config on pegged_bridge ---");
  const tx2 = await bridgeProgram.methods
    .updateConfig(NEW_POOL, NEW_MINT, distPoolAta)
    .accounts({
      authority: kp.publicKey,
      config: bridgeConfig,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })])
    .signers([kp])
    .rpc();
  console.log("update_config TX:", tx2);

  // Step 3: Call set_pegged_mint on monke_bananas
  console.log("\n--- Step 3: set_pegged_mint on monke_bananas ---");
  const tx3 = await monkeProgram.methods
    .setPeggedMint(NEW_MINT)
    .accounts({
      authority: kp.publicKey,
      state: monkeState,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })])
    .signers([kp])
    .rpc();
  console.log("set_pegged_mint TX:", tx3);

  console.log("\n=== WIRING COMPLETE ===");
  console.log("New $PEGGED mint:", NEW_MINT.toBase58());
  console.log("Bridge vault ATA:", bridgeVaultAta.toBase58());
  console.log("Dist pool ATA:", distPoolAta.toBase58());
  console.log("Program vault ATA:", programVaultAta.toBase58());

  // Save wiring info
  const wiringInfo = {
    ...poolInfo,
    bridgeVaultAta: bridgeVaultAta.toBase58(),
    distPoolAta: distPoolAta.toBase58(),
    programVaultAta: programVaultAta.toBase58(),
  };
  fs.writeFileSync(
    new URL("../pool-info.json", import.meta.url).pathname,
    JSON.stringify(wiringInfo, null, 2),
  );
  console.log("\nUpdated pool-info.json with ATA addresses.");
}

main().catch(e => { console.error(e); process.exit(1); });
