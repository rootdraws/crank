/**
 * deploy-admin.ts — Initialize all new BANK system programs in sequence.
 *
 * Usage:
 *   npx tsx scripts/deploy-admin.ts --bank-mint <BANK_MINT_ADDRESS>
 *
 * Executes:
 *   1. bank_mint::initialize
 *   2. gauge_voter::initialize
 *   3. merkle_distributor::initialize  (creates vault ATA first)
 *   4. bin_farm::set_trader_dest
 *   5. pegged_bridge::update_config    (reroute dist_pool_pegged_ata → Merkle vault)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import dotenv from "dotenv";
import { parseArgs } from "util";

dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) throw new Error("Set BOT_KEYPAIR_PATH in bot/.env");

const { values: args } = parseArgs({
  options: { "bank-mint": { type: "string" } },
  strict: false,
});
const bankMintStr = args["bank-mint"];
if (!bankMintStr) throw new Error("Pass --bank-mint <address>");

const BANK_MINT = new PublicKey(bankMintStr);
const CRANK_MINT = new PublicKey("Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump");
const PEGGED_MINT = new PublicKey("GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1");

const BANK_MINT_PROGRAM = new PublicKey("FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk");
const GAUGE_VOTER_PROGRAM = new PublicKey("DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA");
const MERKLE_DIST_PROGRAM = new PublicKey("DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV");
const CORE_PROGRAM = new PublicKey("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia");
const BRIDGE_PROGRAM = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");

const conn = new Connection(rpc, "confirmed");
const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8")))
);
const wallet = new Wallet(kp);
const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });

const idlDir = new URL("../bot/idl", import.meta.url).pathname;
function loadProgram(name: string): Program {
  const idl = JSON.parse(fs.readFileSync(`${idlDir}/${name}.json`, "utf-8"));
  return new Program(idl, provider);
}

const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });

async function step1_initBankMint() {
  console.log("\n═══ Step 1: bank_mint::initialize ═══");
  const program = loadProgram("bank_mint");

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("bank_config")],
    BANK_MINT_PROGRAM
  );
  console.log("  config PDA:", config.toBase58());
  console.log("  crank_mint:", CRANK_MINT.toBase58());
  console.log("  bank_mint:", BANK_MINT.toBase58());

  const tx = await program.methods
    .initialize()
    .accounts({
      authority: kp.publicKey,
      config,
      crankMint: CRANK_MINT,
      bankMint: BANK_MINT,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([priorityIx])
    .signers([kp])
    .rpc();

  console.log("  tx:", tx);
}

async function step2_initGaugeVoter() {
  console.log("\n═══ Step 2: gauge_voter::initialize ═══");
  const program = loadProgram("gauge_voter");

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("gauge_config")],
    GAUGE_VOTER_PROGRAM
  );
  console.log("  config PDA:", config.toBase58());
  console.log("  bank_mint:", BANK_MINT.toBase58());

  const tx = await program.methods
    .initialize()
    .accounts({
      authority: kp.publicKey,
      config,
      bankMint: BANK_MINT,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([priorityIx])
    .signers([kp])
    .rpc();

  console.log("  tx:", tx);
}

async function step3_initMerkleDistributor() {
  console.log("\n═══ Step 3: merkle_distributor::initialize ═══");
  const program = loadProgram("merkle_distributor");

  const [distributorPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("distributor")],
    MERKLE_DIST_PROGRAM
  );
  const vaultAta = getAssociatedTokenAddressSync(PEGGED_MINT, distributorPDA, true);

  console.log("  distributor PDA:", distributorPDA.toBase58());
  console.log("  vault ATA:", vaultAta.toBase58());

  // Create vault ATA (owned by distributor PDA) if it doesn't exist
  const vaultInfo = await conn.getAccountInfo(vaultAta);
  if (!vaultInfo) {
    console.log("  Creating vault ATA...");
    const createAtaIx = createAssociatedTokenAccountInstruction(
      kp.publicKey,
      vaultAta,
      distributorPDA,
      PEGGED_MINT
    );
    const ataTx = new Transaction().add(priorityIx, createAtaIx);
    const ataSig = await sendAndConfirmTransaction(conn, ataTx, [kp]);
    console.log("  vault ATA created:", ataSig);
  } else {
    console.log("  vault ATA already exists");
  }

  const tx = await program.methods
    .initialize()
    .accounts({
      authority: kp.publicKey,
      distributor: distributorPDA,
      mint: PEGGED_MINT,
      vault: vaultAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([priorityIx])
    .signers([kp])
    .rpc();

  console.log("  tx:", tx);
  return vaultAta;
}

async function step4_setTraderDest() {
  console.log("\n═══ Step 4: bin_farm::set_trader_dest ═══");
  const program = loadProgram("bin_farm");

  const [coreConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    CORE_PROGRAM
  );
  const [roverAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("rover_authority")],
    CORE_PROGRAM
  );

  // trader_dest receives the 40% trader share as SOL.
  // The bot converts it to $PEGGED and includes in the Merkle tree.
  // Use the deployer wallet as the initial trader accumulation address.
  const traderDest = kp.publicKey;

  console.log("  config:", coreConfig.toBase58());
  console.log("  rover_authority:", roverAuthority.toBase58());
  console.log("  trader_dest:", traderDest.toBase58());

  const tx = await program.methods
    .setTraderDest(traderDest)
    .accounts({
      authority: kp.publicKey,
      config: coreConfig,
      roverAuthority,
    })
    .preInstructions([priorityIx])
    .signers([kp])
    .rpc();

  console.log("  tx:", tx);
}

async function step5_rerouteBridge(merkleVaultAta: PublicKey) {
  console.log("\n═══ Step 5: pegged_bridge::update_config ═══");
  const program = loadProgram("pegged_bridge");

  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("bridge_config")],
    BRIDGE_PROGRAM
  );

  console.log("  bridge_config:", bridgeConfig.toBase58());
  console.log("  new dist_pool_pegged_ata:", merkleVaultAta.toBase58());

  const tx = await program.methods
    .updateConfig(null, null, merkleVaultAta)
    .accounts({
      authority: kp.publicKey,
      config: bridgeConfig,
    })
    .preInstructions([priorityIx])
    .signers([kp])
    .rpc();

  console.log("  tx:", tx);
}

async function main() {
  console.log("BANK System Admin Deployment");
  console.log("============================");
  console.log("Deployer:", kp.publicKey.toBase58());
  console.log("BANK mint:", BANK_MINT.toBase58());
  console.log("Balance:", (await conn.getBalance(kp.publicKey)) / 1e9, "SOL");

  await step1_initBankMint();
  await step2_initGaugeVoter();
  const merkleVaultAta = await step3_initMerkleDistributor();
  await step4_setTraderDest();
  await step5_rerouteBridge(merkleVaultAta);

  console.log("\n============================");
  console.log("All admin transactions complete!");
  console.log("Balance:", (await conn.getBalance(kp.publicKey)) / 1e9, "SOL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
