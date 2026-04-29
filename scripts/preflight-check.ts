/**
 * preflight-check.ts
 *
 * Verifies bin-farm, mints, and key PDAs are live on-chain.
 * Run before a deploy or after a migration to sanity-check state.
 *
 * Usage:
 *   npx tsx scripts/preflight-check.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.RPC_URL;
if (!rpc) throw new Error("Set RPC_URL in bot/.env");
const conn = new Connection(rpc, "confirmed");

// ── Programs ────────────────────────────────────────────────────────
const BIN_FARM = new PublicKey("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia");

// ── Mints ───────────────────────────────────────────────────────────
const CRANK_MINT = new PublicKey("Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump");

// ── PDAs (derived, not hardcoded — derivation is the source of truth) ──
const [coreConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], BIN_FARM);

// ── Check harness ───────────────────────────────────────────────────
let fails = 0;
const ok   = (label: string, note: string) => console.log(`  [OK]   ${label.padEnd(38)} ${note}`);
const fail = (label: string, note: string) => { console.log(`  [FAIL] ${label.padEnd(38)} ${note}`); fails++; };

async function checkProgram(label: string, addr: PublicKey): Promise<void> {
  const info = await conn.getAccountInfo(addr);
  if (!info)             return fail(label, "MISSING");
  if (!info.executable)  return fail(label, "NOT EXECUTABLE");
  ok(label, `${info.data.length} bytes`);
}

async function checkAccount(label: string, addr: PublicKey): Promise<void> {
  const info = await conn.getAccountInfo(addr);
  if (!info) return fail(label, "NOT INITIALIZED");
  ok(label, `${info.data.length} bytes`);
}

async function checkSolBalance(label: string, addr: PublicKey): Promise<void> {
  const lamports = await conn.getBalance(addr);
  ok(label, `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

async function main(): Promise<void> {
  console.log("\n=== PRE-FLIGHT CHECK ===\n");

  console.log("Programs:");
  await checkProgram("bin_farm", BIN_FARM);

  console.log("\nPDAs:");
  await checkAccount("bin_farm Config", coreConfig);

  console.log("\nMints:");
  await checkAccount("$CRANK mint", CRANK_MINT);

  if (fails === 0) {
    console.log("\n=== ALL CHECKS PASSED ===\n");
    process.exit(0);
  } else {
    console.log(`\n=== ${fails} CHECK(S) FAILED ===\n`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
