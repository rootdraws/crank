/**
 * preflight-check.ts
 *
 * Verifies all programs, PDAs, and ATAs are properly initialized on-chain.
 *
 * Usage:
 *   npx tsx scripts/preflight-check.ts
 */

import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const conn = new Connection(rpc, "confirmed");

const CORE = new PublicKey("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia");
const BANK_MINT_PROG = new PublicKey("FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk");
const GAUGE_VOTER = new PublicKey("DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA");
const DISTRIBUTOR_PROG = new PublicKey("DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV");
const BRIDGE = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");

const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE);
const [distributor] = PublicKey.findProgramAddressSync([Buffer.from("distributor")], DISTRIBUTOR_PROG);
const [bankConfig] = PublicKey.findProgramAddressSync([Buffer.from("bank_config")], BANK_MINT_PROG);
const [gaugeConfig] = PublicKey.findProgramAddressSync([Buffer.from("gauge_config")], GAUGE_VOTER);

async function check(label: string, fn: () => Promise<string>) {
  const result = await fn();
  console.log(`  ${label}: ${result}`);
}

async function main() {
  console.log("=== PRE-FLIGHT CHECK ===\n");

  // Programs
  for (const [name, id] of [
    ["bin_farm", CORE],
    ["bank_mint", BANK_MINT_PROG],
    ["gauge_voter", GAUGE_VOTER],
    ["merkle_distributor", DISTRIBUTOR_PROG],
    ["pegged_bridge", BRIDGE],
  ] as const) {
    await check(`${name} program`, async () => {
      const info = await conn.getAccountInfo(id);
      return info ? "OK" : "MISSING";
    });
  }

  // PDAs
  for (const [name, pda] of [
    ["bridge_config", bridgeConfig],
    ["distributor", distributor],
    ["bank_config", bankConfig],
    ["gauge_config", gaugeConfig],
  ] as const) {
    await check(`${name} PDA`, async () => {
      const info = await conn.getAccountInfo(pda);
      return info ? `OK (${info.data.length} bytes)` : "NOT INITIALIZED";
    });
  }

  // Key ATAs
  await check("distributor vault $PEGGED ATA", async () => {
    const info = await conn.getAccountInfo(new PublicKey("52MUiETNoF6YmBGA6LNfrAdTdkJDmCR95arg7wntZzwB"));
    return info ? "OK" : "MISSING";
  });

  await check("bridge_vault $PEGGED ATA", async () => {
    const info = await conn.getAccountInfo(new PublicKey("Ft1TzupfeAKMvYXg9GfcotK1VFTq2nqvJsq2XCYXpqKB"));
    return info ? "OK" : "MISSING";
  });

  // Infrastructure
  await check("SPL stake pool", async () => {
    const info = await conn.getAccountInfo(new PublicKey("9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg"));
    return info ? `OK (${info.data.length} bytes)` : "MISSING";
  });

  await check("$PEGGED mint", async () => {
    const info = await conn.getAccountInfo(new PublicKey("GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1"));
    return info ? "OK" : "MISSING";
  });

  await check("$BANK mint", async () => {
    const info = await conn.getAccountInfo(new PublicKey("BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA"));
    return info ? "OK" : "MISSING";
  });

  console.log("\n=== ALL CHECKS COMPLETE ===");
}

main().catch(e => { console.error(e); process.exit(1); });
