import { PublicKey, Keypair } from "@solana/web3.js";
import * as dotenv from "dotenv";
import bs58 from "bs58";

dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const CONFIG = {
  rpcUrl: requireEnv("RPC_URL"),
  grpcUrl: process.env["GRPC_URL"] || "",
  grpcToken: process.env["GRPC_TOKEN"] || "",

  keeperKeypair: Keypair.fromSecretKey(
    bs58.decode(requireEnv("KEEPER_SECRET_KEY"))
  ),

  crankLendProgramId: new PublicKey(
    optionalEnv(
      "CRANK_LEND_PROGRAM_ID",
      "GAWPC7CS46St5BxsuicijpzSG4GRWf6csaPvKRdZb314"
    )
  ),
  liquidatorVaultProgramId: new PublicKey(
    optionalEnv(
      "LIQUIDATOR_VAULT_PROGRAM_ID",
      "ANSWdD2DCkAgfBATyVsGc25oiAapqBKBZUSUHcpNj2ZS"
    )
  ),

  keeperOracleAccount: process.env["KEEPER_ORACLE_ACCOUNT"]
    ? new PublicKey(process.env["KEEPER_ORACLE_ACCOUNT"])
    : null,
  crankLendGroup: process.env["CRANK_LEND_GROUP"]
    ? new PublicKey(process.env["CRANK_LEND_GROUP"])
    : null,
  pumpswapPool: process.env["PUMPSWAP_POOL"]
    ? new PublicKey(process.env["PUMPSWAP_POOL"])
    : null,
  meteoraDlmmPool: process.env["METEORA_DLMM_POOL"]
    ? new PublicKey(process.env["METEORA_DLMM_POOL"])
    : null,

  pollIntervalMs: parseInt(optionalEnv("POLL_INTERVAL_MS", "5000"), 10),
  liquidationThreshold: parseFloat(
    optionalEnv("LIQUIDATION_THRESHOLD", "1.0")
  ),
};
