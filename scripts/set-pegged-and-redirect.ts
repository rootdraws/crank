import { Connection, Keypair, PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
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
const monkeIdl = JSON.parse(fs.readFileSync(idlDir + "/monke_bananas.json", "utf-8"));
const coreIdl = JSON.parse(fs.readFileSync(idlDir + "/bin_farm.json", "utf-8"));

const monkeProgram = new Program(monkeIdl, provider);
const coreProgram = new Program(coreIdl, provider);

const PEGGED_MINT = new PublicKey("GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1");
const MONKE_PROGRAM_ID = new PublicKey("myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH");
const CORE_PROGRAM_ID = new PublicKey("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia");
const BRIDGE_PROGRAM_ID = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");

const [monkeState] = PublicKey.findProgramAddressSync([Buffer.from("monke_state")], MONKE_PROGRAM_ID);
const [bridgeVault] = PublicKey.findProgramAddressSync([Buffer.from("bridge_vault")], BRIDGE_PROGRAM_ID);
const [coreConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], CORE_PROGRAM_ID);
const [roverAuthority] = PublicKey.findProgramAddressSync([Buffer.from("rover_authority")], CORE_PROGRAM_ID);

async function main() {
  // Step 1: set_pegged_mint on monke_bananas
  console.log("Step 1: set_pegged_mint...");
  console.log("  monke_state:", monkeState.toBase58());
  console.log("  pegged_mint:", PEGGED_MINT.toBase58());

  const tx1 = await monkeProgram.methods
    .setPeggedMint(PEGGED_MINT)
    .accounts({
      authority: kp.publicKey,
      state: monkeState,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })])
    .signers([kp])
    .rpc();
  console.log("  set_pegged_mint tx:", tx1);

  // Step 2: propose_revenue_dest to bridge_vault
  console.log("\nStep 2: propose_revenue_dest → bridge_vault...");
  console.log("  bridge_vault:", bridgeVault.toBase58());
  console.log("  core_config:", coreConfig.toBase58());
  console.log("  rover_authority:", roverAuthority.toBase58());

  const tx2 = await coreProgram.methods
    .proposeRevenueDest(bridgeVault)
    .accounts({
      authority: kp.publicKey,
      config: coreConfig,
      roverAuthority,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })])
    .signers([kp])
    .rpc();
  console.log("  propose_revenue_dest tx:", tx2);

  console.log("\nDone! revenue_dest redirect proposed.");
  console.log("After 24hr timelock, anyone can call apply_revenue_dest() to finalize.");
}

main().catch(e => { console.error(e); process.exit(1); });
