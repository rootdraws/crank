/**
 * test-epoch.ts
 *
 * Standalone script to trigger runEpoch() outside the keeper's 20-hour cooldown.
 * Supports --dry-run (compute shares + build tree, no on-chain action) and
 * --min-lamports to override the vault threshold.
 *
 * Usage:
 *   npx tsx scripts/test-epoch.ts --dry-run --min-lamports 1000000
 *   npx tsx scripts/test-epoch.ts --min-lamports 1000000
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { WalletService } from '../packages/core-sdk/wallet-service';
import {
  runEpoch, computeShares, buildMerkleTree, hashLeaf,
  loadEpochState,
  type EpochComputerConfig,
} from '../bot/epoch-computer';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

// ─── CLI Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const minLamportsIdx = args.indexOf('--min-lamports');
const MIN_LAMPORTS = minLamportsIdx >= 0 ? parseInt(args[minLamportsIdx + 1]) : 10_000_000;

// ─── Env Validation ──────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error('RPC_URL not set in bot/.env'); process.exit(1); }

let botKeypair: Keypair;
try {
  const keypairPath = process.env.BOT_KEYPAIR_PATH;
  if (keypairPath) {
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    botKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  } else {
    console.error('BOT_KEYPAIR_PATH must be set in bot/.env');
    process.exit(1);
  }
} catch (e: any) {
  console.error(`Failed to load bot keypair: ${e.message}`);
  process.exit(1);
}

const EPOCH_VAULT_ID = new PublicKey(process.env.BRIDGE_PROGRAM_ID || '7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN');
const MERKLE_DIST_ID = new PublicKey(process.env.DISTRIBUTOR_PROGRAM_ID || 'DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV');

// ─── Setup ───────────────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, 'confirmed');
const wallet = new Wallet(botKeypair);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

const idlDir = process.env.IDL_DIR || path.join(__dirname, '..', 'bot', 'idl');
function loadIdl(name: string): any {
  const filePath = path.join(idlDir, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`IDL file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

const distributorProgram = new Program(loadIdl('merkle_distributor'), provider);
const epochVaultProgram = new Program(loadIdl('epoch_vault'), provider);

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crankbot.json');
const walletService = new WalletService(dbPath);

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60));
  console.log('  crank.money — Epoch Test');
  console.log('═'.repeat(60));
  console.log(`  Mode:          ${DRY_RUN ? 'DRY RUN (no on-chain action)' : 'LIVE'}`);
  console.log(`  Min lamports:  ${MIN_LAMPORTS} (${MIN_LAMPORTS / LAMPORTS_PER_SOL} SOL)`);
  console.log(`  Bot:           ${botKeypair.publicKey.toBase58()}`);

  // Check vault balance
  const [bridgeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_vault')], EPOCH_VAULT_ID
  );
  const vaultBalance = await connection.getBalance(bridgeVault);
  const rent = await connection.getMinimumBalanceForRentExemption(0);
  const available = BigInt(vaultBalance - rent);
  console.log(`  Vault:         ${bridgeVault.toBase58()}`);
  console.log(`  Vault balance: ${Number(available) / LAMPORTS_PER_SOL} SOL (${available} lamports)`);

  // Check bot balance
  const botBalance = await connection.getBalance(botKeypair.publicKey);
  console.log(`  Bot balance:   ${botBalance / LAMPORTS_PER_SOL} SOL`);

  // Load wallet DB stats
  const data = (walletService as any).data as any;
  const userCount = Object.keys(data.users || {}).length;
  const harvestCount = (data.harvests || []).length;
  const harvestsWithFees = (data.harvests || []).filter((h: any) => BigInt(h.fee_taken || '0') > 0n).length;
  console.log(`  Users:         ${userCount}`);
  console.log(`  Harvests:      ${harvestCount} total, ${harvestsWithFees} with fees`);

  // Load epoch state
  const state = loadEpochState();
  console.log(`  Last epoch:    ${state.lastEpoch}`);
  console.log(`  Harvest index: ${state.lastProcessedHarvestIndex}`);
  console.log('═'.repeat(60));

  if (available < BigInt(MIN_LAMPORTS)) {
    console.log(`\nVault below threshold (${MIN_LAMPORTS} lamports). Nothing to distribute.`);
    walletService.close();
    return;
  }

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: Computing shares ---\n');

    const shares = computeShares(walletService, available, state);

    if (shares.length === 0) {
      console.log('No eligible users (no harvests with fees since last epoch).');
      walletService.close();
      return;
    }

    console.log(`${shares.length} user(s) eligible:\n`);
    let totalShare = 0n;
    for (const s of shares) {
      console.log(`  ${s.wallet.slice(0, 12)}...  fees: ${Number(s.feesGenerated)} lamports  →  share: ${Number(s.share) / LAMPORTS_PER_SOL} SOL`);
      totalShare += s.share;
    }
    console.log(`\n  Total allocated: ${Number(totalShare) / LAMPORTS_PER_SOL} SOL (${totalShare} lamports)`);

    // Build cumulative entitlements
    const updatedEntitlements = { ...state.cumulativeEntitlements };
    for (const s of shares) {
      const prev = BigInt(updatedEntitlements[s.wallet] || '0');
      updatedEntitlements[s.wallet] = (prev + s.share).toString();
    }

    // Build Merkle tree
    const wallets = Object.keys(updatedEntitlements).sort();
    const leafHashes: Buffer[] = [];
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      leafHashes.push(hashLeaf(BigInt(i), new PublicKey(w), BigInt(updatedEntitlements[w])));
    }
    const { root } = buildMerkleTree(leafHashes);

    console.log(`\n  Merkle root:   ${Buffer.from(root).toString('hex')}`);
    console.log(`  Leaf count:    ${wallets.length}`);
    console.log(`  Next epoch:    ${state.lastEpoch + 1}`);
    console.log('\nDry run complete. No on-chain actions taken.');

  } else {
    console.log('\n--- LIVE: Running epoch pipeline ---\n');

    const config: EpochComputerConfig = {
      connection,
      botKeypair,
      walletService,
      epochVaultProgram,
      distributorProgram,
      minEpochLamports: MIN_LAMPORTS,
    };

    const result = await runEpoch(config);

    console.log('\n' + '═'.repeat(60));
    if (result.ran) {
      console.log(`  Epoch ${result.epoch} complete!`);
      console.log(`  Distributed: ${result.amountSol?.toFixed(9)} SOL`);
      console.log(`  Users:       ${result.userCount}`);
    } else {
      console.log('  Epoch did not run (vault below threshold or no eligible users).');
    }
    console.log('═'.repeat(60));
  }

  walletService.close();
}

main().catch((e) => {
  console.error('Epoch test failed:', e);
  walletService.close();
  process.exit(1);
});
