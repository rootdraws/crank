/**
 * close-wsol.ts — Show vault WSOL balance and instructions for withdrawal.
 * PDA vault architecture: WSOL in vault ATAs is handled by on-chain withdraw_sol.
 * Usage: npx tsx scripts/close-wsol.ts <discord_user_id>
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { WalletService } from '../packages/core-sdk/wallet-service';
import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname2, '../bot/.env') });

async function main() {
  const userId = process.argv[2];
  if (!userId) { console.error('Usage: npx tsx scripts/close-wsol.ts <discord_user_id>'); process.exit(1); }

  const conn = new Connection(process.env.RPC_URL!, 'confirmed');
  const ws = new WalletService(path.join(__dirname2, '../data/crankbot.json'));

  const vaultPda = ws.getVaultPda(userId);
  if (!vaultPda) { console.error(`No vault found for user ${userId}`); process.exit(1); }

  const vaultBalance = await conn.getBalance(vaultPda);
  console.log(`Vault: ${vaultPda.toBase58()}`);
  console.log(`SOL balance: ${(vaultBalance / 1e9).toFixed(4)} SOL`);

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vaultPda, true, TOKEN_PROGRAM_ID);
  const wsolInfo = await conn.getAccountInfo(wsolAta);
  if (wsolInfo) {
    const wsolBalance = Buffer.from(wsolInfo.data).readBigUInt64LE(64);
    console.log(`WSOL ATA: ${wsolAta.toBase58()}`);
    console.log(`WSOL balance: ${Number(wsolBalance) / 1e9} SOL`);
    console.log(`\nTo withdraw: use /withdraw SOL <amount> in Discord.`);
    console.log(`On-chain withdraw_sol handles native SOL from vault PDA.`);
  } else {
    console.log(`No WSOL ATA found.`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
