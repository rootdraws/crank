/**
 * preflight-check.ts
 *
 * Verifies all programs, PDAs, mints, and key ATAs are live on-chain.
 * Run before a deploy or after a migration to sanity-check state.
 *
 * Usage:
 *   npx tsx scripts/preflight-check.ts
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const conn = new Connection(rpc, "confirmed");

// ── Programs ────────────────────────────────────────────────────────
const BIN_FARM     = new PublicKey("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia");
const BANK_MINT    = new PublicKey("FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk");
const GAUGE_VOTER  = new PublicKey("DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA");
const DISTRIBUTOR  = new PublicKey("DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV");
const EPOCH_VAULT  = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");

// ── Mints ───────────────────────────────────────────────────────────
const CRANK_MINT = new PublicKey("Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump");
const BANK_TOKEN = new PublicKey("BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA");
const WSOL_MINT  = new PublicKey("So11111111111111111111111111111111111111112");

// ── PDAs (derived, not hardcoded — derivation is the source of truth) ──
const [coreConfig]   = PublicKey.findProgramAddressSync([Buffer.from("config")],          BIN_FARM);
const [roverAuth]    = PublicKey.findProgramAddressSync([Buffer.from("rover_authority")], BIN_FARM);
const [distributorP] = PublicKey.findProgramAddressSync([Buffer.from("distributor")],     DISTRIBUTOR);
const [bankConfig]   = PublicKey.findProgramAddressSync([Buffer.from("bank_config")],     BANK_MINT);
const [gaugeConfig]  = PublicKey.findProgramAddressSync([Buffer.from("gauge_config")],    GAUGE_VOTER);
const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")],   EPOCH_VAULT);
const [bridgeVault]  = PublicKey.findProgramAddressSync([Buffer.from("bridge_vault")],    EPOCH_VAULT);
const distWsolAta    = getAssociatedTokenAddressSync(WSOL_MINT, distributorP, true);

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

async function checkWsolAta(label: string, ata: PublicKey): Promise<void> {
  const info = await conn.getAccountInfo(ata);
  if (!info)                    return fail(label, "MISSING");
  if (info.data.length < 72)    return fail(label, `malformed (${info.data.length} bytes)`);
  const amount = Number(info.data.readBigUInt64LE(64));
  ok(label, `${(amount / LAMPORTS_PER_SOL).toFixed(6)} WSOL`);
}

async function main(): Promise<void> {
  console.log("\n=== PRE-FLIGHT CHECK ===\n");

  console.log("Programs:");
  await checkProgram("bin_farm",           BIN_FARM);
  await checkProgram("bank_mint",          BANK_MINT);
  await checkProgram("gauge_voter",        GAUGE_VOTER);
  await checkProgram("merkle_distributor", DISTRIBUTOR);
  await checkProgram("epoch_vault",        EPOCH_VAULT);

  console.log("\nPDAs:");
  await checkAccount("bin_farm Config",          coreConfig);
  await checkAccount("bin_farm RoverAuthority",  roverAuth);
  await checkAccount("bank_mint BankConfig",     bankConfig);
  await checkAccount("gauge_voter GaugeConfig",  gaugeConfig);
  await checkAccount("merkle_distributor state", distributorP);
  await checkAccount("epoch_vault BridgeConfig", bridgeConfig);

  console.log("\nMints:");
  await checkAccount("$CRANK mint", CRANK_MINT);
  await checkAccount("$BANK mint",  BANK_TOKEN);

  console.log("\nLive balances (sanity):");
  await checkSolBalance("rover_authority",        roverAuth);
  await checkSolBalance("bridge_vault",           bridgeVault);
  await checkWsolAta   ("distributor WSOL ATA",   distWsolAta);

  if (fails === 0) {
    console.log("\n=== ALL CHECKS PASSED ===\n");
    process.exit(0);
  } else {
    console.log(`\n=== ${fails} CHECK(S) FAILED ===\n`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
