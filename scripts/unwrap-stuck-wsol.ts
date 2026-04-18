/**
 * unwrap-stuck-wsol.ts — Scan every registered vault, unwrap any non-zero WSOL
 * balance back to native SOL via `unwrap_wsol_in_vault`. One-shot recovery for
 * the /close path that shipped without auto-unwrap.
 *
 * Usage:
 *   npx tsx scripts/unwrap-stuck-wsol.ts            # dry-run (lists candidates)
 *   npx tsx scripts/unwrap-stuck-wsol.ts --execute  # send txs
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { WalletService } from '../packages/core-sdk/wallet-service';
import { getConfigPDA } from '../packages/core-sdk/pda';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname2, '../bot/.env') });

const DRY_RUN = !process.argv.includes('--execute');
const DUST_LAMPORTS = 1_000n; // skip dust (<0.000001 SOL)

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error('RPC_URL not set');

  const keypairPath = process.env.BOT_KEYPAIR_PATH;
  if (!keypairPath) throw new Error('BOT_KEYPAIR_PATH not set');
  const bot = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8'))));

  const conn = new Connection(rpc, 'confirmed');
  const provider = new AnchorProvider(conn, new Wallet(bot), { commitment: 'confirmed' });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname2, '../bot/idl/bin_farm.json'), 'utf-8'));
  const coreProgram = new Program(idl, provider);

  const [configPDA] = getConfigPDA();
  const ws = new WalletService(path.join(__dirname2, '../data/crankbot.json'));
  const users = ws.getAllUsers();

  console.log(`Scanning ${users.length} vaults for stuck WSOL…`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
  console.log('');

  const candidates: { userId: string; vault: PublicKey; wsolAta: PublicKey; amount: bigint }[] = [];

  for (const u of users) {
    if (!u.vault_pda) continue;
    const vault = new PublicKey(u.vault_pda);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID);
    const info = await conn.getAccountInfo(wsolAta);
    if (!info) continue;
    const amount = Buffer.from(info.data).readBigUInt64LE(64);
    if (amount <= DUST_LAMPORTS) continue;
    candidates.push({ userId: u.user_id, vault, wsolAta, amount });
    console.log(`  ${u.user_id.padEnd(30)} ${vault.toBase58().slice(0, 8)}…  ${(Number(amount) / 1e9).toFixed(4)} WSOL`);
  }

  console.log('');
  console.log(`Found ${candidates.length} vault(s) with stuck WSOL.`);

  if (DRY_RUN) {
    console.log('Dry-run complete. Re-run with --execute to unwrap.');
    return;
  }

  if (candidates.length === 0) return;

  console.log('Executing unwrap_wsol_in_vault…');
  for (const c of candidates) {
    try {
      const sig = await coreProgram.methods
        .unwrapWsolInVault()
        .accounts({
          caller: bot.publicKey,
          config: configPDA,
          userVault: c.vault,
          vaultWsolAta: c.wsolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bot])
        .rpc();
      console.log(`  ✓ ${c.userId}  ${(Number(c.amount) / 1e9).toFixed(4)} SOL  https://solscan.io/tx/${sig}`);
    } catch (e: any) {
      console.log(`  ✗ ${c.userId}  failed: ${e.message?.slice(0, 120)}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
