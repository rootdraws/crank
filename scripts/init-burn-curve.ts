/**
 * init-burn-curve.ts
 *
 * One-shot bootstrap for the Capture the Bag amendment. Runs four things:
 *   1. initialize_burn_curve — snapshots CRANK supply, enables burn, creates
 *      the burn_sol_vault PDA on bin-farm.
 *   2. set_fee_bps(50) — atomic fee bump from 30 → 50 bps.
 *   3. bank_distributor.initialize — creates the BANK Merkle distributor PDA
 *      and its vault ATA (first creating the ATA off-chain).
 *   4. Create rover_authority's BANK ATA + bot's BANK ATA (funder for
 *      bank_distributor.new_epoch).
 *
 * Each step is idempotent-ish — initialize_burn_curve errors cleanly with
 * BurnCurveAlreadyInitialized, and ATA creation instructions use idempotent.
 *
 * Usage:
 *   npx tsx scripts/init-burn-curve.ts                    # dry-run
 *   npx tsx scripts/init-burn-curve.ts --execute          # mainnet
 *   npx tsx scripts/init-burn-curve.ts --execute --cluster devnet
 *
 * Requires:
 *   bot/.env with RPC_URL (or HELIUS_RPC_URL) + ANCHOR_WALLET path to the
 *   bin-farm + bank-distributor upgrade authority keypair.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../bot/.env') });

// ── Config ──────────────────────────────────────────────────────────
const BIN_FARM            = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
const BANK_DISTRIBUTOR    = new PublicKey('9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M');
const CRANK_MINT          = new PublicKey('Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump');
const BANK_MINT           = new PublicKey('BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA');

const [CORE_CONFIG]       = PublicKey.findProgramAddressSync([Buffer.from('config')],          BIN_FARM);
const [ROVER_AUTHORITY]   = PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], BIN_FARM);
const [BURN_SOL_VAULT]    = PublicKey.findProgramAddressSync([Buffer.from('burn_sol_vault')],  BIN_FARM);
const [BANK_DIST_PDA]     = PublicKey.findProgramAddressSync([Buffer.from('distributor')],     BANK_DISTRIBUTOR);

// ── Args ────────────────────────────────────────────────────────────
const execute = process.argv.includes('--execute');
const clusterIdx = process.argv.indexOf('--cluster');
const cluster = clusterIdx >= 0 ? process.argv[clusterIdx + 1] : 'mainnet';

// ── Setup ───────────────────────────────────────────────────────────
const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error('Set RPC_URL in bot/.env');

const walletPath = process.env.ANCHOR_WALLET ?? path.resolve(process.env.HOME || '', '.config/solana/id.json');
if (!fs.existsSync(walletPath)) throw new Error(`Wallet not found at ${walletPath}`);
const walletKey = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
const authority = Keypair.fromSecretKey(Uint8Array.from(walletKey));

const connection = new Connection(rpc, 'confirmed');
const wallet = new Wallet(authority);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

async function loadProgram(programId: PublicKey, idlFile: string): Promise<Program> {
  const idlPath = path.resolve(__dirname, '../bot/idl', idlFile);
  if (!fs.existsSync(idlPath)) throw new Error(`IDL not found: ${idlPath}. Run \`anchor build\` first.`);
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
  return new Program(idl, provider);
}

async function main() {
  console.log(`\n── init-burn-curve  cluster=${cluster}  execute=${execute}`);
  console.log(`── authority:   ${authority.publicKey.toBase58()}`);
  console.log(`── burn vault:  ${BURN_SOL_VAULT.toBase58()}`);
  console.log(`── bank dist:   ${BANK_DIST_PDA.toBase58()}`);

  const binFarm         = await loadProgram(BIN_FARM,         'bin_farm.json');
  const bankDistributor = await loadProgram(BANK_DISTRIBUTOR, 'bank_distributor.json');

  // Derive ATAs
  const roverBankAta     = getAssociatedTokenAddressSync(BANK_MINT, ROVER_AUTHORITY, true, TOKEN_PROGRAM_ID);
  const botBankAta       = getAssociatedTokenAddressSync(BANK_MINT, authority.publicKey, false, TOKEN_PROGRAM_ID);
  const bankDistVaultAta = getAssociatedTokenAddressSync(BANK_MINT, BANK_DIST_PDA, true, TOKEN_PROGRAM_ID);

  // ── Pre-flight checks ───────────────────────────────────────────
  const crankInfo = await connection.getAccountInfo(CRANK_MINT);
  if (!crankInfo) throw new Error('CRANK mint not found on-chain');
  const currentCrankSupply = crankInfo.data.readBigUInt64LE(36);
  console.log(`── CRANK supply snapshot target: ${currentCrankSupply.toString()} (raw units, 6 decimals)`);

  const roverExisting = await binFarm.account.roverAuthority.fetch(ROVER_AUTHORITY).catch(() => null);
  if (roverExisting && BigInt(roverExisting.initialCrankSupply?.toString() || '0') > 0n) {
    console.log(`⚠  Burn curve already initialized at ${roverExisting.initialCrankSupply.toString()} — will skip step 1`);
  }

  const bankDistExisting = await connection.getAccountInfo(BANK_DIST_PDA);
  if (bankDistExisting) {
    console.log(`⚠  bank-distributor already initialized — will skip step 3`);
  }

  if (!execute) {
    console.log('\n── DRY RUN. Add --execute to send transactions.');
    return;
  }

  // ── Step 1: initialize_burn_curve (creates burn_sol_vault PDA) ──
  if (!roverExisting || BigInt(roverExisting.initialCrankSupply?.toString() || '0') === 0n) {
    console.log('\n── Step 1: initialize_burn_curve');
    const sig1 = await binFarm.methods
      .initializeBurnCurve()
      .accounts({
        authority: authority.publicKey,
        config: CORE_CONFIG,
        roverAuthority: ROVER_AUTHORITY,
        crankMint: CRANK_MINT,
        burnSolVault: BURN_SOL_VAULT,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    console.log(`   ✓ tx: ${sig1}`);
  }

  // ── Step 2: set_fee_bps(50) ────────────────────────────────────
  console.log('\n── Step 2: set_fee_bps(50)');
  const sig2 = await binFarm.methods
    .setFeeBps(50)
    .accounts({
      authority: authority.publicKey,
      config: CORE_CONFIG,
    })
    .signers([authority])
    .rpc();
  console.log(`   ✓ tx: ${sig2}`);

  // ── Step 3: bank_distributor.initialize ────────────────────────
  if (!bankDistExisting) {
    console.log('\n── Step 3: bank_distributor.initialize (first: create vault ATA)');
    // Create the distributor's vault ATA off-chain (bank-distributor's init
    // expects the ATA to already exist and be owned by the distributor PDA).
    const createVaultTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, bankDistVaultAta, BANK_DIST_PDA, BANK_MINT, TOKEN_PROGRAM_ID,
      ),
    );
    await sendAndConfirmTransaction(connection, createVaultTx, [authority]);
    console.log(`   ✓ vault ATA created: ${bankDistVaultAta.toBase58()}`);

    const sig3 = await bankDistributor.methods
      .initialize()
      .accounts({
        authority: authority.publicKey,
        distributor: BANK_DIST_PDA,
        mint: BANK_MINT,
        vault: bankDistVaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    console.log(`   ✓ tx: ${sig3}`);
  }

  // ── Step 4: Create rover + bot BANK ATAs ───────────────────────
  console.log('\n── Step 4: create rover + bot BANK ATAs');
  const ataTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, roverBankAta, ROVER_AUTHORITY, BANK_MINT, TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, botBankAta, authority.publicKey, BANK_MINT, TOKEN_PROGRAM_ID,
    ),
  );
  const sig4 = await sendAndConfirmTransaction(connection, ataTx, [authority]);
  console.log(`   ✓ rover BANK ATA: ${roverBankAta.toBase58()}`);
  console.log(`   ✓ bot BANK ATA:   ${botBankAta.toBase58()}`);
  console.log(`   ✓ tx: ${sig4}`);

  console.log('\n✓ All done. Verify with: npx tsx scripts/preflight-check.ts');
}

main().catch((e) => {
  console.error('\n✗ init-burn-curve failed:', e);
  process.exit(1);
});
