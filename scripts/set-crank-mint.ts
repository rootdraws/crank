/**
 * set-crank-mint.ts — Call set_bananas_mint to point the burn system at $CRANK.
 *
 * Usage:
 *   npx tsx scripts/set-crank-mint.ts
 *
 * Reads RPC + keypair from bot/.env (same as all other scripts).
 */

import { Connection, Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
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
const monkeProgram = new Program(monkeIdl, provider);

const CRANK_MINT = new PublicKey("Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump");
const MONKE_PROGRAM_ID = new PublicKey("myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH");
const [monkeState] = PublicKey.findProgramAddressSync([Buffer.from("monke_state")], MONKE_PROGRAM_ID);

async function main() {
  console.log("set_bananas_mint → $CRANK");
  console.log("  authority:", kp.publicKey.toBase58());
  console.log("  monke_state:", monkeState.toBase58());
  console.log("  new mint:", CRANK_MINT.toBase58());

  const currentState = await monkeProgram.account.monkeState.fetch(monkeState);
  console.log("  current mint:", currentState.bananasMint.toBase58());

  if (currentState.bananasMint.toBase58() === CRANK_MINT.toBase58()) {
    console.log("\n  Already set to $CRANK — nothing to do.");
    return;
  }

  const tx = await (monkeProgram.methods as any)
    .setBananasMint(CRANK_MINT)
    .accounts({
      authority: kp.publicKey,
      state: monkeState,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })])
    .signers([kp])
    .rpc();

  console.log("\n  set_bananas_mint tx:", tx);
  console.log("  https://solscan.io/tx/" + tx);

  const updated = await monkeProgram.account.monkeState.fetch(monkeState);
  console.log("\n  Verified — burn mint is now:", updated.bananasMint.toBase58());
}

main().catch(e => { console.error(e); process.exit(1); });
