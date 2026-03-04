import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const conn = new Connection(rpc, "confirmed");

const BRIDGE = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");
const MONKE = new PublicKey("myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH");

const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE);
const [monkeState] = PublicKey.findProgramAddressSync([Buffer.from("monke_state")], MONKE);

async function check(label: string, fn: () => Promise<string>) {
  const result = await fn();
  console.log(`  ${label}: ${result}`);
}

async function main() {
  console.log("=== PRE-FLIGHT CHECK ===\n");

  await check("bin_farm program", async () => {
    const info = await conn.getAccountInfo(new PublicKey("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia"));
    return info ? "OK" : "MISSING";
  });

  await check("monke_bananas program", async () => {
    const info = await conn.getAccountInfo(new PublicKey("myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH"));
    return info ? "OK" : "MISSING";
  });

  await check("pegged_bridge program", async () => {
    const info = await conn.getAccountInfo(BRIDGE);
    return info ? "OK" : "MISSING";
  });

  await check("bridge_config PDA", async () => {
    const info = await conn.getAccountInfo(bridgeConfig);
    return info ? `OK (${info.data.length} bytes)` : "NOT INITIALIZED";
  });

  await check("bridge_vault $PEGGED ATA", async () => {
    const info = await conn.getAccountInfo(new PublicKey("Ft1TzupfeAKMvYXg9GfcotK1VFTq2nqvJsq2XCYXpqKB"));
    return info ? "OK" : "MISSING";
  });

  await check("dist_pool $PEGGED ATA", async () => {
    const info = await conn.getAccountInfo(new PublicKey("3NBqb4nRadQqe3wwffmwCwP4SLWA19jhxdm85ZhAjTMB"));
    return info ? "OK" : "MISSING";
  });

  await check("program_vault $PEGGED ATA", async () => {
    const info = await conn.getAccountInfo(new PublicKey("9ZsSHkbzziVwRLuR4uT9KAR6CVu1WoL23xk8rNvpyiXM"));
    return info ? "OK" : "MISSING";
  });

  await check("SPL stake pool", async () => {
    const info = await conn.getAccountInfo(new PublicKey("9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg"));
    return info ? `OK (${info.data.length} bytes)` : "MISSING";
  });

  await check("$PEGGED mint", async () => {
    const info = await conn.getAccountInfo(new PublicKey("GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1"));
    return info ? "OK" : "MISSING";
  });

  await check("monke_state pegged_mint field", async () => {
    const info = await conn.getAccountInfo(monkeState);
    if (!info) return "MONKE STATE MISSING";
    const peggedMint = new PublicKey(info.data.subarray(244, 276));
    return peggedMint.equals(PublicKey.default)
      ? "NOT SET YET (ready for set_pegged_mint)"
      : `SET: ${peggedMint.toBase58()}`;
  });

  console.log("\n=== ALL CHECKS COMPLETE ===");
}

main().catch(e => { console.error(e); process.exit(1); });
