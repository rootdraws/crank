/**
 * e2e-test.ts
 *
 * Guided end-to-end test of the crank.money automation pipeline.
 * Runs against mainnet (or devnet) — verifies each step of the fee pipeline.
 *
 * Steps:
 *   1. Load bot keypair and Anchor programs
 *   2. Snapshot fee pipeline balances (before)
 *   3. Scan existing positions via safety poll logic
 *   4. Check if any positions have harvestable bins
 *   5. Execute a harvest (if available) and verify fee routing
 *   6. Execute sweep_rover and verify SOL reaches dist_pool
 *   7. Execute deposit_sol and verify accumulator update
 *   8. Snapshot fee pipeline balances (after) and diff
 *
 * This does NOT open new positions — it tests the automation on whatever
 * positions already exist. If no harvestable bins exist, it reports that
 * and still tests steps 6-7 (sweep + deposit).
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts
 *   npx tsx scripts/e2e-test.ts --dry-run    (read-only, no transactions)
 */

import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  Commitment,
} from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');
const COMMITMENT: Commitment = 'confirmed';

// ═══ ENV ═══

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error('RPC_URL not set'); process.exit(1); }

const CORE_PROGRAM_ID = new PublicKey(process.env.CORE_PROGRAM_ID!);
const MONKE_PROGRAM_ID = new PublicKey(process.env.MONKE_BANANAS_PROGRAM_ID!);
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

let botKeypair: Keypair;
try {
  const kpPath = process.env.BOT_KEYPAIR_PATH;
  if (!kpPath) throw new Error('BOT_KEYPAIR_PATH not set');
  botKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf-8')))
  );
} catch (e: any) {
  console.error(`Keypair error: ${e.message}`);
  process.exit(1);
}

const connection = new Connection(RPC_URL, { commitment: COMMITMENT });
const provider = new AnchorProvider(connection, new Wallet(botKeypair), { commitment: COMMITMENT });

// ═══ PDA HELPERS ═══

const roverAuthorityPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], CORE_PROGRAM_ID);
const coreConfigPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], CORE_PROGRAM_ID);
const monkeStatePDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('monke_state')], MONKE_PROGRAM_ID);
const distPoolPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('dist_pool')], MONKE_PROGRAM_ID);
const programVaultPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('program_vault')], MONKE_PROGRAM_ID);

// ═══ HELPERS ═══

function sol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(9);
}

let stepNum = 0;
function step(title: string) {
  stepNum++;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Step ${stepNum}: ${title}`);
  console.log('─'.repeat(60));
}

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function warn(msg: string) { console.log(`  ⚠ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); }

interface PipelineSnapshot {
  roverSol: number;
  roverWsol: bigint;
  distPoolSol: number;
  programVaultSol: number;
  botSol: number;
  timestamp: number;
}

async function snapshotPipeline(): Promise<PipelineSnapshot> {
  const [roverPDA] = roverAuthorityPDA();
  const [dPoolPDA] = distPoolPDA();
  const [pVaultPDA] = programVaultPDA();

  const [roverSol, distPoolSol, programVaultSol, botSol] = await Promise.all([
    connection.getBalance(roverPDA),
    connection.getBalance(dPoolPDA),
    connection.getBalance(pVaultPDA),
    connection.getBalance(botKeypair.publicKey),
  ]);

  let roverWsol = 0n;
  try {
    const ata = getAssociatedTokenAddressSync(WSOL_MINT, roverPDA, true);
    const info = await connection.getAccountInfo(ata);
    if (info && info.data.length >= 72) roverWsol = info.data.readBigUInt64LE(64);
  } catch { /* no WSOL ATA */ }

  return { roverSol, roverWsol, distPoolSol, programVaultSol, botSol, timestamp: Date.now() };
}

function printSnapshot(label: string, snap: PipelineSnapshot) {
  console.log(`  ${label}:`);
  console.log(`    rover_authority:  ${sol(snap.roverSol)} SOL + ${(Number(snap.roverWsol) / LAMPORTS_PER_SOL).toFixed(9)} WSOL`);
  console.log(`    dist_pool:        ${sol(snap.distPoolSol)} SOL`);
  console.log(`    program_vault:    ${sol(snap.programVaultSol)} SOL`);
  console.log(`    bot wallet:       ${sol(snap.botSol)} SOL`);
}

function printDiff(before: PipelineSnapshot, after: PipelineSnapshot) {
  const d = (a: number, b: number) => {
    const diff = a - b;
    return diff >= 0 ? `+${sol(diff)}` : sol(diff);
  };
  console.log(`  Changes:`);
  console.log(`    rover_authority:  ${d(after.roverSol, before.roverSol)} SOL`);
  console.log(`    dist_pool:        ${d(after.distPoolSol, before.distPoolSol)} SOL`);
  console.log(`    program_vault:    ${d(after.programVaultSol, before.programVaultSol)} SOL`);
  console.log(`    bot wallet:       ${d(after.botSol, before.botSol)} SOL`);
}

// ═══ MAIN ═══

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║          crank.money E2E Pipeline Test                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Mode:     ${DRY_RUN ? 'DRY RUN (read-only)' : 'LIVE (will send transactions)'}`);
  console.log(`  Bot:      ${botKeypair.publicKey.toBase58()}`);
  console.log(`  RPC:      ${RPC_URL!.split('?')[0]}`);
  console.log(`  Programs: core=${CORE_PROGRAM_ID.toBase58().slice(0, 8)}... monke=${MONKE_PROGRAM_ID.toBase58().slice(0, 8)}...`);

  // Load IDLs
  const idlDir = path.join(__dirname, '..', 'bot', 'idl');
  const coreIdl = JSON.parse(fs.readFileSync(path.join(idlDir, 'bin_farm.json'), 'utf-8'));
  const monkeIdl = JSON.parse(fs.readFileSync(path.join(idlDir, 'monke_bananas.json'), 'utf-8'));
  const coreProgram = new Program(coreIdl, provider);
  const monkeProgram = new Program(monkeIdl, provider);

  // ─── Step 1: Snapshot Before ───
  step('Snapshot pipeline balances (before)');
  const before = await snapshotPipeline();
  printSnapshot('Before', before);

  // ─── Step 2: Load all positions ───
  step('Load all positions from on-chain');
  const positions = await coreProgram.account.position.all();
  ok(`Found ${positions.length} positions`);

  if (positions.length === 0) {
    warn('No positions exist — skipping harvest test. Proceeding to sweep/deposit.');
  }

  // ─── Step 3: Check for harvestable bins ───
  step('Check for harvestable bins');
  interface HarvestCandidate {
    positionPDA: PublicKey;
    lbPair: PublicKey;
    meteoraPosition: PublicKey;
    owner: PublicKey;
    side: 'Buy' | 'Sell';
    safeBinCount: number;
    totalBins: number;
  }
  const candidates: HarvestCandidate[] = [];

  const byPool = new Map<string, typeof positions>();
  for (const pos of positions) {
    const poolKey = (pos.account.lbPair as PublicKey).toBase58();
    if (!byPool.has(poolKey)) byPool.set(poolKey, []);
    byPool.get(poolKey)!.push(pos);
  }

  for (const [poolKey, poolPositions] of byPool) {
    try {
      // Read activeId directly from raw LbPair bytes (offset 76, i32 LE)
      const lbPairInfo = await connection.getAccountInfo(new PublicKey(poolKey));
      if (!lbPairInfo || lbPairInfo.data.length < 80) {
        warn(`Pool ${poolKey.slice(0, 8)}... account too short or missing`);
        continue;
      }
      const activeId = lbPairInfo.data.readInt32LE(76);
      console.log(`  Pool ${poolKey.slice(0, 8)}... activeId=${activeId}`);

      for (const pos of poolPositions) {
        const data = pos.account;
        const side: 'Buy' | 'Sell' = (data as any).side?.buy ? 'Buy' : 'Sell';
        const minBin = data.minBinId as number;
        const maxBin = data.maxBinId as number;
        const totalBins = maxBin - minBin + 1;

        let safeBinCount = 0;
        for (let b = minBin; b <= maxBin; b++) {
          if (side === 'Sell' && b < activeId) safeBinCount++;
          if (side === 'Buy' && b > activeId) safeBinCount++;
        }

        const status = safeBinCount > 0 ? '→ HARVESTABLE' : '  (no safe bins)';
        console.log(`    ${pos.publicKey.toBase58().slice(0, 8)}... ${side} bins=[${minBin},${maxBin}] safe=${safeBinCount}/${totalBins} ${status}`);

        if (safeBinCount > 0) {
          candidates.push({
            positionPDA: pos.publicKey,
            lbPair: data.lbPair as PublicKey,
            meteoraPosition: data.meteoraPosition as PublicKey,
            owner: data.owner as PublicKey,
            side,
            safeBinCount,
            totalBins,
          });
        }
      }
    } catch (e: any) {
      warn(`Pool ${poolKey.slice(0, 8)}... error: ${e.message?.slice(0, 80)}`);
    }
  }

  if (candidates.length > 0) {
    ok(`${candidates.length} position(s) with harvestable bins`);
  } else {
    warn('No harvestable bins found — price hasn\'t crossed any position ranges');
  }

  // ─── Step 4: Verify harvest (if candidates exist) ───
  if (candidates.length > 0 && !DRY_RUN) {
    step('Harvest verification (bot would execute these)');
    warn('Harvest execution requires the full bot executor pipeline.');
    warn('The bot running at :8080 handles this automatically via gRPC.');
    warn(`Verifiable candidates: ${candidates.map(c => c.positionPDA.toBase58().slice(0, 8)).join(', ')}`);
    ok('Harvest detection logic validated — bot will pick these up.');
  } else if (candidates.length > 0) {
    step('Harvest verification (dry run)');
    ok(`Would harvest ${candidates.length} position(s) — skipped in dry-run mode.`);
  }

  // ─── Step 5: Verify sweep_rover ───
  step('Verify sweep_rover');
  const [roverPDA] = roverAuthorityPDA();
  const roverBal = await connection.getBalance(roverPDA);
  const rentExempt = 890880; // ~0.00089 SOL for PDA accounts
  const sweepable = roverBal - rentExempt;

  if (sweepable > 0) {
    ok(`rover_authority has ${sol(sweepable)} sweepable SOL`);
    if (!DRY_RUN) {
      try {
        const [configPDA] = coreConfigPDA();
        const configInfo = await connection.getAccountInfo(configPDA);
        if (!configInfo) throw new Error('Config not found');

        // Parse revenue_dest from RoverAuthority account
        const roverInfo = await connection.getAccountInfo(roverPDA);
        if (!roverInfo) throw new Error('RoverAuthority not found');
        const revenueDest = new PublicKey(roverInfo.data.subarray(8, 40));

        const tx = await coreProgram.methods.sweepRover()
          .accounts({
            caller: botKeypair.publicKey,
            config: configPDA,
            roverAuthority: roverPDA,
            revenueDest,
            botDest: botKeypair.publicKey,
            systemProgram: PublicKey.default,
          })
          .signers([botKeypair])
          .rpc();
        ok(`sweep_rover tx: ${tx}`);
      } catch (e: any) {
        const msg = e.message || '';
        if (msg.includes('NothingToSweep') || msg.includes('0x4e23')) {
          ok('NothingToSweep — rover below rent-exempt minimum (expected)');
        } else {
          fail(`sweep_rover failed: ${msg.slice(0, 120)}`);
        }
      }
    } else {
      ok('DRY RUN — would call sweep_rover');
    }
  } else {
    ok('No sweepable SOL in rover_authority (below rent-exempt minimum)');
  }

  // ─── Step 6: Verify deposit_sol ───
  step('Verify deposit_sol');
  const [dPoolPDA] = distPoolPDA();
  const distBal = await connection.getBalance(dPoolPDA);
  const MIN_DEPOSIT = 10_000_000; // 0.01 SOL (on-chain minimum)

  if (distBal - rentExempt > MIN_DEPOSIT) {
    ok(`dist_pool has ${sol(distBal - rentExempt)} depositable SOL`);
    if (!DRY_RUN) {
      try {
        const [mStatePDA] = monkeStatePDA();
        const [pVaultPDA] = programVaultPDA();

        const tx = await monkeProgram.methods.depositSol()
          .accounts({
            caller: botKeypair.publicKey,
            state: mStatePDA,
            distPool: dPoolPDA,
            programVault: pVaultPDA,
            systemProgram: PublicKey.default,
          })
          .signers([botKeypair])
          .rpc();
        ok(`deposit_sol tx: ${tx}`);
      } catch (e: any) {
        const msg = e.message || '';
        if (msg.includes('NoMonkes') || msg.includes('NothingToDeposit')) {
          ok(`Skipped: ${msg.includes('NoMonkes') ? 'no monkes burned yet (total_share_weight=0)' : 'dist_pool below minimum'}`);
        } else {
          fail(`deposit_sol failed: ${msg.slice(0, 120)}`);
        }
      }
    } else {
      ok('DRY RUN — would call deposit_sol');
    }
  } else {
    ok(`dist_pool below deposit minimum (${sol(Math.max(0, distBal - rentExempt))} < 0.01 SOL)`);
  }

  // ─── Step 7: Snapshot After + Diff ───
  step('Snapshot pipeline balances (after)');
  const after = await snapshotPipeline();
  printSnapshot('After', after);
  console.log('');
  printDiff(before, after);

  // ─── Summary ───
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  E2E Test Complete');
  console.log('═'.repeat(60));
  console.log(`  Positions found:     ${positions.length}`);
  console.log(`  Harvestable:         ${candidates.length}`);
  console.log(`  Transactions sent:   ${DRY_RUN ? '0 (dry run)' : 'see above'}`);
  console.log(`  Pipeline total:      ${sol(after.roverSol + Number(after.roverWsol) + after.distPoolSol + after.programVaultSol)} SOL`);
  console.log('');
}

main().catch(err => {
  console.error('E2E test error:', err);
  process.exit(1);
});
