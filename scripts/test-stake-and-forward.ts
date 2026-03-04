import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
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
const POOL = new PublicKey(poolInfo.pool);
const MINT = new PublicKey(poolInfo.mint);
const RESERVE_STAKE = new PublicKey(poolInfo.reserveStake);
const WITHDRAW_AUTHORITY = new PublicKey(poolInfo.withdrawAuthority);
const MANAGER_FEE = new PublicKey(poolInfo.managerFeeAccount);
const SANCTUM_PROGRAM = new PublicKey(poolInfo.program);

const idlDir = new URL("../bot/idl", import.meta.url).pathname;
const bridgeIdl = JSON.parse(fs.readFileSync(idlDir + "/pegged_bridge.json", "utf-8"));
const bridgeProgram = new Program(bridgeIdl, provider);

const BRIDGE_PROGRAM_ID = new PublicKey("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");
const [bridgeConfig] = PublicKey.findProgramAddressSync([Buffer.from("bridge_config")], BRIDGE_PROGRAM_ID);
const [bridgeVault] = PublicKey.findProgramAddressSync([Buffer.from("bridge_vault")], BRIDGE_PROGRAM_ID);

const bridgePeggedAta = getAssociatedTokenAddressSync(MINT, bridgeVault, true);
const distPoolAta = new PublicKey(poolInfo.distPoolAta);

async function main() {
  const vaultBalance = await conn.getBalance(bridgeVault);
  console.log("Bridge vault balance:", vaultBalance / 1e9, "SOL");
  console.log("Bridge pegged ATA:", bridgePeggedAta.toBase58());

  console.log("\nCranking stake_and_forward...");

  const tx = await bridgeProgram.methods
    .stakeAndForward()
    .accounts({
      crank: kp.publicKey,
      config: bridgeConfig,
      bridgeVault,
      bridgePeggedAta,
      distPoolPeggedAta: distPoolAta,
      peggedMint: MINT,
      stakePool: POOL,
      stakePoolWithdrawAuthority: WITHDRAW_AUTHORITY,
      reserveStake: RESERVE_STAKE,
      managerFeeAccount: MANAGER_FEE,
      stakePoolProgram: SANCTUM_PROGRAM,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 })])
    .signers([kp])
    .rpc();

  console.log("stake_and_forward TX:", tx);

  // Check dist pool ATA balance
  const distPoolInfo = await conn.getTokenAccountBalance(distPoolAta);
  console.log("\nDist pool $PEGGED balance:", distPoolInfo.value.uiAmountString);
  console.log("\nTest PASSED - stake_and_forward works with new Sanctum pool!");
}

main().catch(e => { console.error(e); process.exit(1); });
