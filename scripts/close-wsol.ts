/**
 * close-wsol.ts — Close a user's WSOL ATA and return SOL to their wallet.
 * Usage: WALLET=<pubkey> npx tsx scripts/close-wsol.ts
 */

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { WalletService } from '../packages/core-sdk/wallet-service';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

async function main() {
  const walletAddr = process.env.WALLET;
  if (!walletAddr) { console.error('Usage: WALLET=<pubkey> npx tsx scripts/close-wsol.ts'); process.exit(1); }

  const rpc = process.env.HELIUS_RPC_URL || process.env.RPC_URL;
  if (!rpc) { console.error('RPC_URL not set'); process.exit(1); }

  const c = new Connection(rpc);
  const ws = new WalletService();

  const userId = ws.getUserIdForOwner(walletAddr);
  if (!userId) { console.error('Wallet not found in DB'); process.exit(1); }

  const keypair = ws.getOrCreate(userId);
  const wallet = keypair.publicKey;
  const wsolAta = getAssociatedTokenAddressSync(WSOL, wallet, false, TOKEN_PROGRAM);

  const info = await c.getAccountInfo(wsolAta);
  if (!info) { console.log('No WSOL ATA — nothing to close.'); ws.close(); return; }

  const balance = Buffer.from(info.data).readBigUInt64LE(64);
  console.log(`WSOL ATA: ${wsolAta.toBase58()}`);
  console.log(`WSOL balance: ${Number(balance) / 1e9} SOL`);

  const tx = new Transaction().add(
    createCloseAccountInstruction(wsolAta, wallet, wallet, [], TOKEN_PROGRAM)
  );
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = wallet;
  tx.sign(keypair);

  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

  console.log(`Closed. TX: ${sig}`);
  const newBal = await c.getBalance(wallet);
  console.log(`New SOL balance: ${newBal / 1e9}`);
  ws.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
