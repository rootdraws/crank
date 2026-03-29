/**
 * reclaim-atas.ts — Close empty token accounts for a user's custody wallet and reclaim rent.
 * Usage: WALLET=<pubkey> npx tsx scripts/reclaim-atas.ts
 */

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import { WalletService } from '../packages/core-sdk/wallet-service';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

async function main() {
  const walletAddr = process.env.WALLET;
  if (!walletAddr) { console.error('Usage: WALLET=<pubkey> npx tsx scripts/reclaim-atas.ts'); process.exit(1); }

  const rpc = process.env.HELIUS_RPC_URL || process.env.RPC_URL;
  if (!rpc) { console.error('RPC_URL not set'); process.exit(1); }

  const c = new Connection(rpc);
  const ws = new WalletService();

  const userId = ws.getUserIdForOwner(walletAddr);
  if (!userId) { console.error('Wallet not found in DB'); process.exit(1); }

  const keypair = ws.getOrCreate(userId);
  const wallet = keypair.publicKey;

  // Find all empty token accounts
  const [splAccounts, t22Accounts] = await Promise.all([
    c.getTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM }),
    c.getTokenAccountsByOwner(wallet, { programId: TOKEN_2022 }),
  ]);

  const emptyAccounts: { pubkey: PublicKey; program: PublicKey; mint: string }[] = [];

  for (const ta of [...splAccounts.value, ...t22Accounts.value]) {
    const data = Buffer.from(ta.account.data);
    const mint = new PublicKey(data.subarray(0, 32)).toBase58();
    const amount = data.readBigUInt64LE(64);
    const program = ta.account.owner;

    if (amount === 0n) {
      emptyAccounts.push({ pubkey: ta.pubkey, program, mint: mint.slice(0, 8) });
    } else {
      console.log(`KEEP ${ta.pubkey.toBase58().slice(0, 8)}... mint=${mint.slice(0, 8)}... balance=${Number(amount)}`);
    }
  }

  if (emptyAccounts.length === 0) {
    console.log('No empty token accounts to close.');
    ws.close();
    return;
  }

  console.log(`\nFound ${emptyAccounts.length} empty account(s) to close:`);
  for (const a of emptyAccounts) {
    console.log(`  ${a.pubkey.toBase58().slice(0, 8)}... mint=${a.mint}... (${a.program.equals(TOKEN_2022) ? 'Token-2022' : 'SPL Token'})`);
  }

  const tx = new Transaction();
  for (const a of emptyAccounts) {
    tx.add(createCloseAccountInstruction(a.pubkey, wallet, wallet, [], a.program));
  }

  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = wallet;
  tx.sign(keypair);

  const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

  console.log(`\nClosed ${emptyAccounts.length} account(s). TX: ${sig}`);
  const bal = await c.getBalance(wallet);
  console.log(`New SOL balance: ${bal / 1e9}`);
  ws.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
