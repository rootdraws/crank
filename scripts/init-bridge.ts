import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
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

const idlDir = new URL("../bot/idl", import.meta.url).pathname;
const idl = JSON.parse(fs.readFileSync(idlDir + "/pegged_bridge.json", "utf-8"));
const program = new Program(idl, provider);

const STAKE_POOL = new PublicKey("SVhYuHZMyXobKkCrcAbF2cq44amK5TiYzmNpKngfwqg");
const PEGGED_MINT = new PublicKey("3wJYuCVWvNj4aWh5nBdZ782Wz8xVzW74CXr8UepZMG4j");
const DIST_POOL_PEGGED_ATA = new PublicKey("2yqzo5ZfkEBFgvyJ7c5A92MLKJqgYV9V8KDXzSqbKrx9");

const BRIDGE_PROGRAM_ID = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");
const [config] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE_PROGRAM_ID);
const [bridgeVault] = PublicKey.findProgramAddressSync([Buffer.from("bridge_vault")], BRIDGE_PROGRAM_ID);

async function main() {
  console.log("Initializing pegged_bridge...");
  console.log("  config PDA:", config.toBase58());
  console.log("  bridge_vault PDA:", bridgeVault.toBase58());
  
  const tx = await program.methods
    .initialize(STAKE_POOL, PEGGED_MINT, DIST_POOL_PEGGED_ATA)
    .accounts({
      authority: kp.publicKey,
      config,
      bridgeVault,
      systemProgram: SystemProgram.programId,
    })
    .signers([kp])
    .rpc();

  console.log("Bridge initialized! Tx:", tx);
}

main().catch(e => { console.error(e); process.exit(1); });
