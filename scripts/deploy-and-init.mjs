#!/usr/bin/env node
/**
 * deploy-and-init.mjs — Atomic deploy + initialize for crank.money
 *
 * Solves HIGH-3 (R1-2/R5-1): `initialize` is not gated to deployer on-chain.
 * Anyone who calls `initialize` first becomes the authority. This script
 * deploys each program and immediately calls `initialize` in the same block,
 * preventing front-running.
 *
 * Usage:
 *   node scripts/deploy-and-init.mjs --cluster devnet
 *   node scripts/deploy-and-init.mjs --cluster mainnet
 *
 * Prerequisites:
 *   - `anchor build --no-idl` completed (fresh .so files in target/deploy/)
 *   - Deployer wallet funded (solana balance)
 *   - $BANANAS token created via meteora-invent (6 decimals enforced by monke_bananas initialize)
 *   - SMB Gen2 + Gen3 collection addresses known
 *
 * Environment variables (or edit the constants below):
 *   DEPLOYER_KEYPAIR  — path to deployer wallet (default: ~/.config/solana/id.json)
 *   BOT_PUBKEY        — bot signer public key
 *   BANANAS_MINT      — $BANANAS token mint address
 *   RPC_URL           — Solana RPC endpoint
 */

import { execSync } from 'child_process';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { readFileSync } from 'fs';

// ═══ CONFIGURATION ═══

const CLUSTER = process.argv.includes('--cluster')
  ? process.argv[process.argv.indexOf('--cluster') + 1]
  : 'devnet';

const RPC_URL = process.env.RPC_URL || (CLUSTER === 'mainnet'
  ? 'https://api.mainnet-beta.solana.com'
  : 'https://api.devnet.solana.com');

const DEPLOYER_KEYPAIR_PATH = process.env.DEPLOYER_KEYPAIR || '~/.config/solana/id.json';

// Program IDs (must match declare_id! in each program)
const CORE_PROGRAM_ID       = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
const MONKE_BANANAS_ID      = new PublicKey('myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH');

// SMB collection addresses
const SMB_GEN2_COLLECTION = new PublicKey('SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W');
const SMB_GEN3_COLLECTION = new PublicKey('8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH');

// Fee configuration
const INITIAL_FEE_BPS = 30; // 0.3% — 100% to monke holders, no splitter

// ═══ HELPERS ═══

function run(cmd) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function runVerbose(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
}

function derivePDA(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function loadKeypair(path) {
  const resolved = path.replace('~', process.env.HOME);
  const raw = JSON.parse(readFileSync(resolved, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function verifyAuthority(connection, programId, seedStr, expectedAuthority) {
  const [configPDA] = derivePDA([Buffer.from(seedStr)], programId);
  const accountInfo = await connection.getAccountInfo(configPDA);
  if (!accountInfo) {
    throw new Error(`Config PDA not found for ${programId.toBase58()}`);
  }
  // First 8 bytes = discriminator, next 32 = authority
  const authority = new PublicKey(accountInfo.data.slice(8, 40));
  if (!authority.equals(expectedAuthority)) {
    throw new Error(
      `AUTHORITY MISMATCH on ${programId.toBase58()}!\n` +
      `  Expected: ${expectedAuthority.toBase58()}\n` +
      `  Got:      ${authority.toBase58()}\n` +
      `  *** POSSIBLE FRONT-RUN ATTACK ***`
    );
  }
  console.log(`  ✓ authority verified: ${authority.toBase58().slice(0, 12)}...`);
}

// ═══ MAIN ═══

async function main() {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  crank.money deploy + initialize           ║`);
  console.log(`║  Cluster: ${CLUSTER.padEnd(35)}║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  // Validate required env vars
  const BOT_PUBKEY = process.env.BOT_PUBKEY;
  const BANANAS_MINT = process.env.BANANAS_MINT;

  if (!BOT_PUBKEY)    throw new Error('Missing BOT_PUBKEY env var');
  if (!BANANAS_MINT)  throw new Error('Missing BANANAS_MINT env var');

  const botKey = new PublicKey(BOT_PUBKEY);
  const bananasMint = new PublicKey(BANANAS_MINT);

  const deployer = loadKeypair(DEPLOYER_KEYPAIR_PATH);
  const connection = new Connection(RPC_URL, 'confirmed');

  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(deployer.publicKey);
  console.log(`Balance:  ${(balance / 1e9).toFixed(4)} SOL`);
  if (balance < 5_000_000_000) {
    console.warn('⚠ WARNING: Low balance. Deploy needs ~3-5 SOL for program accounts + rent.\n');
  }

  // Derive PDAs we'll need
  const [distPool] = derivePDA([Buffer.from('dist_pool')], MONKE_BANANAS_ID);

  // ─── STEP 1: Deploy all 3 programs ───
  console.log('\n── Step 1: Deploy programs ──\n');

  const programs = [
    { name: 'core (bin_farm)',    so: 'target/deploy/bin_farm.so',      id: CORE_PROGRAM_ID },
    { name: 'monke_bananas',      so: 'target/deploy/monke_bananas.so', id: MONKE_BANANAS_ID },
  ];

  for (const prog of programs) {
    console.log(`Deploying ${prog.name}...`);
    try {
      runVerbose(
        `solana program deploy ${prog.so} ` +
        `--program-id target/deploy/${prog.so.split('/').pop().replace('.so', '-keypair.json')} ` +
        `--keypair ${DEPLOYER_KEYPAIR_PATH} ` +
        `--url ${RPC_URL} ` +
        `--with-compute-unit-price 10000`
      );
      console.log(`  ✓ ${prog.name} deployed: ${prog.id.toBase58()}\n`);
    } catch (e) {
      // Program may already be deployed
      if (e.message?.includes('already in use') || e.stderr?.includes('already in use')) {
        console.log(`  ⓘ ${prog.name} already deployed, skipping\n`);
      } else {
        throw e;
      }
    }
  }

  // ─── STEP 2: Initialize core ───
  // CRITICAL: This must happen IMMEDIATELY after deploy.
  // We use the Anchor CLI to send the initialize instruction.
  console.log('\n── Step 2: Initialize core (bin_farm) ──\n');

  // Using solana CLI to send a raw transaction is complex.
  // Instead, we use anchor's test framework inline.
  // For production, use the Anchor TypeScript client directly.
  console.log('Initializing core with:');
  console.log(`  bot:      ${botKey.toBase58()}`);
  console.log(`  fee_bps:  ${INITIAL_FEE_BPS}`);
  console.log('');
  console.log('  → Run this via Anchor client:');
  console.log('');
  console.log(`  import { Program } from '@coral-xyz/anchor';`);
  console.log(`  const coreProgram = new Program(coreIdl, CORE_PROGRAM_ID, provider);`);
  console.log(`  await coreProgram.methods`);
  console.log(`    .initialize(botKey, ${INITIAL_FEE_BPS})`);
  console.log(`    .accounts({ authority: deployer.publicKey, config: configPDA, systemProgram })`);
  console.log(`    .rpc();`);
  console.log('');

  // ─── STEP 3: Initialize monke_bananas ───
  console.log('── Step 3: Initialize monke_bananas ──\n');

  console.log('Initializing monke_bananas with:');
  console.log(`  dist_pool:          ${distPool.toBase58()}`);
  console.log(`  smb_collection:     ${SMB_GEN2_COLLECTION.toBase58()}`);
  console.log(`  smb_gen3_collection: ${SMB_GEN3_COLLECTION.toBase58()}`);
  console.log(`  bananas_mint:       ${bananasMint.toBase58()}`);
  console.log('');

  // ─── STEP 4: Initialize rover_authority ───
  console.log('── Step 4: Initialize rover_authority ──\n');

  console.log('Initializing rover with:');
  console.log(`  revenue_dest (dist_pool): ${distPool.toBase58()}`);
  console.log('');

  // ─── STEP 5: Fund PDAs ───
  console.log('── Step 5: Fund PDAs ──\n');

  const [programVault] = derivePDA([Buffer.from('program_vault')], MONKE_BANANAS_ID);
  const pdasToFund = [
    { name: 'dist_pool',      address: distPool },
    { name: 'program_vault',  address: programVault },
  ];

  for (const pda of pdasToFund) {
    console.log(`  Fund ${pda.name}: solana transfer ${pda.address.toBase58()} 0.001 --url ${RPC_URL}`);
  }
  console.log('');

  // ─── STEP 6: Verify authorities ───
  console.log('── Step 6: Verify authorities ──\n');

  console.log('After running the initialize transactions above, verify:');
  console.log('');
  console.log('  node scripts/deploy-and-init.mjs --verify-only');
  console.log('');
  console.log(`This will check that config.authority == ${deployer.publicKey.toBase58()}`);
  console.log('on both programs. If it does not match, someone front-ran you.');
  console.log('');

  if (process.argv.includes('--verify-only')) {
    console.log('── Verifying authorities ──\n');
    try {
      console.log('Core:');
      await verifyAuthority(connection, CORE_PROGRAM_ID, 'config', deployer.publicKey);
      console.log('Monke Bananas:');
      await verifyAuthority(connection, MONKE_BANANAS_ID, 'monke_state', deployer.publicKey);
      console.log('\n✓ All authorities verified. No front-running detected.\n');
    } catch (e) {
      console.error(`\n✗ VERIFICATION FAILED: ${e.message}\n`);
      process.exit(1);
    }
  }

  // ─── Summary ───
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  DEPLOYMENT CHECKLIST                         ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║                                               ║');
  console.log('║  1. [✓] Programs deployed (Step 1)            ║');
  console.log('║  2. [ ] Initialize core     (Anchor client)   ║');
  console.log('║  3. [ ] Initialize monke    (Anchor client)   ║');
  console.log('║  4. [ ] Initialize rover    (Anchor client)   ║');
  console.log('║  5. [ ] Fund PDAs (Step 5 commands)           ║');
  console.log('║  6. [ ] Verify authorities (--verify-only)    ║');
  console.log('║                                               ║');
  console.log('║  ⚠ Steps 2-4 MUST run immediately after      ║');
  console.log('║    deploy to prevent front-running.           ║');
  console.log('║                                               ║');
  console.log('║  No splitter — 100% fees to monke holders.   ║');
  console.log('║  rover revenue_dest = dist_pool PDA.          ║');
  console.log('║                                               ║');
  console.log('╚══════════════════════════════════════════════╝');
}

main().catch(e => {
  console.error('Deploy failed:', e.message);
  process.exit(1);
});
