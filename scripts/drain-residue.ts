/**
 * drain-residue.ts
 *
 * Sweep residual SOL from bridge_vault back to the bot wallet (= Config.bot).
 * Use when bridge_vault is holding leftover lamports from a retired flow
 * (pre-2026-04-13 pre-amendment sweeps) that `runEpoch` can't distribute
 * because no harvests have been recorded against them.
 *
 * Dry-run by default. Pass --execute to actually drain.
 *
 *   npx tsx scripts/drain-residue.ts
 *   npx tsx scripts/drain-residue.ts --execute
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

const EXECUTE = process.argv.includes('--execute');

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error('RPC_URL not set in bot/.env'); process.exit(1); }

const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) { console.error('BOT_KEYPAIR_PATH not set in bot/.env'); process.exit(1); }
const botKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8'))),
);

const EPOCH_VAULT_ID = new PublicKey(
  process.env.BRIDGE_PROGRAM_ID || '7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN',
);

const connection = new Connection(RPC_URL, 'confirmed');
const provider = new AnchorProvider(connection, new Wallet(botKeypair), { commitment: 'confirmed' });

const idlDir = process.env.IDL_DIR || path.join(__dirname, '..', 'bot', 'idl');
const epochVaultIdl = JSON.parse(fs.readFileSync(path.join(idlDir, 'epoch_vault.json'), 'utf-8'));
const epochVaultProgram = new Program(epochVaultIdl, provider);

async function main() {
  const [bridgeVault] = PublicKey.findProgramAddressSync([Buffer.from('bridge_vault')], EPOCH_VAULT_ID);
  const [vaultConfig] = PublicKey.findProgramAddressSync([Buffer.from('bridge_config')], EPOCH_VAULT_ID);

  const lamports = await connection.getBalance(bridgeVault);
  const rent = await connection.getMinimumBalanceForRentExemption(0);
  const available = Math.max(0, lamports - rent);

  console.log('═'.repeat(60));
  console.log('  crank.money — bridge_vault residue drain');
  console.log('═'.repeat(60));
  console.log(`  Mode:         ${EXECUTE ? 'EXECUTE' : 'DRY RUN (pass --execute to drain)'}`);
  console.log(`  bridge_vault: ${bridgeVault.toBase58()}`);
  console.log(`  balance:      ${(lamports / LAMPORTS_PER_SOL).toFixed(9)} SOL (${lamports} lamports)`);
  console.log(`  rent floor:   ${(rent / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  console.log(`  drainable:    ${(available / LAMPORTS_PER_SOL).toFixed(9)} SOL (${available} lamports)`);
  console.log(`  destination:  ${botKeypair.publicKey.toBase58()} (bot wallet = Config.bot)`);
  console.log('═'.repeat(60));

  if (available <= 0) {
    console.log('Nothing to drain. Exiting.');
    return;
  }

  if (!EXECUTE) {
    console.log('\nDry run — no tx sent. Re-run with --execute to drain.');
    return;
  }

  const sig = await epochVaultProgram.methods
    .drainVault(new BN(0))
    .accounts({
      authority: botKeypair.publicKey,
      config: vaultConfig,
      bridgeVault,
      destination: botKeypair.publicKey,
    })
    .signers([botKeypair])
    .rpc();

  console.log(`\nDrained. tx: ${sig}`);
  const post = await connection.getBalance(bridgeVault);
  console.log(`bridge_vault now: ${(post / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
}

main().catch((e) => { console.error(e); process.exit(1); });
