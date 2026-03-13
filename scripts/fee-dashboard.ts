/**
 * fee-dashboard.ts
 *
 * Queries all 4 checkpoints in the crank.money fee pipeline and prints a summary.
 *
 *   1. rover_authority PDA — accumulated fees (native SOL + token ATAs)
 *   2. dist_pool PDA       — swept SOL pending deposit into accumulator
 *   3. program_vault PDA   — SOL available for monke holders to claim
 *   4. MonkeState account  — global accumulator, total weight, distribution stats
 *
 * Also reads bin_farm Config for fee_bps and bot address.
 *
 * Usage:
 *   npx tsx scripts/fee-dashboard.ts
 */

import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { console.error('RPC_URL not set in bot/.env'); process.exit(1); }

const CORE_PROGRAM_ID = new PublicKey(process.env.CORE_PROGRAM_ID!);
const MONKE_PROGRAM_ID = new PublicKey(process.env.MONKE_BANANAS_PROGRAM_ID!);
const BANANAS_MINT = new PublicKey(process.env.BANANAS_MINT!);
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const connection = new Connection(RPC_URL, 'confirmed');

// PDA derivation helpers (must match on-chain seeds exactly)
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

function sol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(9);
}

function separator(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function queryTokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
    const info = await connection.getAccountInfo(ata);
    if (!info || info.data.length < 72) return 0n;
    // SPL token account: amount is at offset 64, u64 LE
    return info.data.readBigUInt64LE(64);
  } catch {
    return 0n;
  }
}

// Anchor discriminators (first 8 bytes of sha256("account:<Name>"))
const CONFIG_DISCRIMINATOR = Buffer.from([155, 12, 170, 224, 30, 250, 204, 130]);
const ROVER_DISCRIMINATOR = Buffer.from([65, 247, 130, 146, 26, 34, 182, 71]);
const MONKE_STATE_DISCRIMINATOR = Buffer.from([92, 192, 184, 145, 242, 210, 77, 205]);

interface ConfigData {
  authority: PublicKey;
  bot: PublicKey;
  feeBps: number;
  pendingFeeBps: number;
  totalPositions: bigint;
  totalVolume: bigint;
  paused: boolean;
  botPaused: boolean;
  keeperTipBps: number;
}

function parseConfig(data: Buffer): ConfigData {
  let offset = 8; // skip discriminator
  const authority = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  offset += 32; // pending_authority
  const bot = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const feeBps = data.readUInt16LE(offset); offset += 2;
  const pendingFeeBps = data.readUInt16LE(offset); offset += 2;
  offset += 8; // fee_change_at (i64)
  const totalPositions = data.readBigUInt64LE(offset); offset += 8;
  const totalVolume = data.readBigUInt64LE(offset); offset += 8;
  const paused = data.readUInt8(offset) !== 0; offset += 1;
  const botPaused = data.readUInt8(offset) !== 0; offset += 1;
  offset += 1; // bump
  offset += 8; // last_bot_harvest_slot
  const keeperTipBps = data.readUInt16LE(offset);
  return { authority, bot, feeBps, pendingFeeBps, totalPositions, totalVolume, paused, botPaused, keeperTipBps };
}

interface RoverData {
  revenueDest: PublicKey;
  totalRoverPositions: bigint;
}

function parseRoverAuthority(data: Buffer): RoverData {
  let offset = 8;
  const revenueDest = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const totalRoverPositions = data.readBigUInt64LE(offset);
  return { revenueDest, totalRoverPositions };
}

interface MonkeStateData {
  authority: PublicKey;
  banansMint: PublicKey;
  totalShareWeight: bigint;
  accumulatedSolPerShare: bigint;
  totalSolDistributed: bigint;
  totalBananasBurned: bigint;
  paused: boolean;
}

function parseMonkeState(data: Buffer): MonkeStateData {
  let offset = 8;
  const authority = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  offset += 32; // pending_authority
  const banansMint = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  offset += 32; // smb_collection
  offset += 32; // smb_gen3_collection
  offset += 32; // dist_pool pubkey
  const totalShareWeight = data.readBigUInt64LE(offset); offset += 8;
  // u128 LE
  const lo = data.readBigUInt64LE(offset); offset += 8;
  const hi = data.readBigUInt64LE(offset); offset += 8;
  const accumulatedSolPerShare = (hi << 64n) | lo;
  const totalSolDistributed = data.readBigUInt64LE(offset); offset += 8;
  const totalBananasBurned = data.readBigUInt64LE(offset); offset += 8;
  const paused = data.readUInt8(offset) !== 0;
  return { authority, banansMint, totalShareWeight, accumulatedSolPerShare, totalSolDistributed, totalBananasBurned, paused };
}

async function main() {
  console.log('crank.money Fee Dashboard');
  console.log(`RPC: ${RPC_URL!.replace(/api-key=.*/, 'api-key=***')}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const [roverPDA] = roverAuthorityPDA();
  const [configPDA] = coreConfigPDA();
  const [mStatePDA] = monkeStatePDA();
  const [dPoolPDA] = distPoolPDA();
  const [pVaultPDA] = programVaultPDA();

  // Resolve bot pubkey from keypair file
  let botPubkey: PublicKey | null = null;
  if (process.env.BOT_KEYPAIR_PATH) {
    try {
      const kpData = JSON.parse(fs.readFileSync(process.env.BOT_KEYPAIR_PATH, 'utf-8'));
      botPubkey = Keypair.fromSecretKey(Uint8Array.from(kpData)).publicKey;
    } catch { /* no keypair available */ }
  }

  // Batch fetch all accounts + balances
  const [
    configInfo,
    roverInfo,
    monkeStateInfo,
    roverBalance,
    distPoolBalance,
    programVaultBalance,
    botBalance,
  ] = await Promise.all([
    connection.getAccountInfo(configPDA),
    connection.getAccountInfo(roverPDA),
    connection.getAccountInfo(mStatePDA),
    connection.getBalance(roverPDA),
    connection.getBalance(dPoolPDA),
    connection.getBalance(pVaultPDA),
    botPubkey ? connection.getBalance(botPubkey) : Promise.resolve(0),
  ]);

  // ─── CHECKPOINT 0: bin_farm Config ───
  separator('bin_farm Config');
  if (configInfo) {
    const config = parseConfig(configInfo.data);
    console.log(`  Authority:        ${config.authority.toBase58()}`);
    console.log(`  Bot:              ${config.bot.toBase58()}`);
    console.log(`  Fee:              ${config.feeBps} bps (${(config.feeBps / 100).toFixed(1)}%)`);
    console.log(`  Keeper Tip:       ${config.keeperTipBps} bps`);
    console.log(`  Total Positions:  ${config.totalPositions}`);
    console.log(`  Total Volume:     ${sol(Number(config.totalVolume))} SOL`);
    console.log(`  Paused:           ${config.paused}`);
    console.log(`  Bot Paused:       ${config.botPaused}`);
    if (config.pendingFeeBps > 0) {
      console.log(`  Pending Fee:      ${config.pendingFeeBps} bps (timelocked)`);
    }
  } else {
    console.log('  Config account not found — program not initialized?');
  }

  // ─── CHECKPOINT 1: rover_authority ───
  separator('Checkpoint 1: rover_authority (uncollected fees)');
  console.log(`  PDA:              ${roverPDA.toBase58()}`);
  console.log(`  Native SOL:       ${sol(roverBalance)} SOL`);

  // Check WSOL + BANANAS token accounts on rover
  const roverWsol = await queryTokenBalance(roverPDA, WSOL_MINT);
  const roverBananas = await queryTokenBalance(roverPDA, BANANAS_MINT);
  console.log(`  WSOL ATA:         ${(Number(roverWsol) / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  console.log(`  $BANANAS ATA:     ${(Number(roverBananas) / 1e6).toFixed(2)} BANANAS`);

  if (roverInfo) {
    const rover = parseRoverAuthority(roverInfo.data);
    console.log(`  Revenue Dest:     ${rover.revenueDest.toBase58()}`);
    console.log(`  Rover Positions:  ${rover.totalRoverPositions}`);
  } else {
    console.log('  RoverAuthority account not found');
  }

  // ─── CHECKPOINT 2: dist_pool ───
  separator('Checkpoint 2: dist_pool (pending deposit)');
  console.log(`  PDA:              ${dPoolPDA.toBase58()}`);
  console.log(`  SOL Balance:      ${sol(distPoolBalance)} SOL`);
  // Account rent-exempt minimum is ~0.00089 SOL for a system account
  const distPoolUsable = Math.max(0, distPoolBalance - 890880);
  console.log(`  Usable (- rent):  ${sol(distPoolUsable)} SOL`);

  // ─── CHECKPOINT 3: program_vault ───
  separator('Checkpoint 3: program_vault (claimable by holders)');
  console.log(`  PDA:              ${pVaultPDA.toBase58()}`);
  console.log(`  SOL Balance:      ${sol(programVaultBalance)} SOL`);
  const vaultUsable = Math.max(0, programVaultBalance - 890880);
  console.log(`  Usable (- rent):  ${sol(vaultUsable)} SOL`);

  // ─── CHECKPOINT 4: MonkeState ───
  separator('Checkpoint 4: MonkeState (accumulator)');
  console.log(`  PDA:              ${mStatePDA.toBase58()}`);
  if (monkeStateInfo) {
    const ms = parseMonkeState(monkeStateInfo.data);
    console.log(`  Total Weight:     ${ms.totalShareWeight} shares`);
    console.log(`  Accumulator:      ${ms.accumulatedSolPerShare} (raw u128, /1e12 for per-share)`);
    const perShare = Number(ms.accumulatedSolPerShare) / 1e12;
    console.log(`  Per-Share SOL:    ${perShare.toFixed(12)}`);
    console.log(`  Total Distributed:${sol(Number(ms.totalSolDistributed))} SOL`);
    console.log(`  Total Burned:     ${(Number(ms.totalBananasBurned) / 1e6).toFixed(2)} BANANAS`);
    console.log(`  Paused:           ${ms.paused}`);
  } else {
    console.log('  MonkeState account not found — program not initialized?');
  }

  // ─── BOT WALLET ───
  if (botPubkey) {
    separator('Bot Wallet (operations)');
    console.log(`  Address:          ${botPubkey.toBase58()}`);
    console.log(`  SOL Balance:      ${sol(botBalance)} SOL`);
  }

  // ─── SUMMARY ───
  separator('Pipeline Summary');
  const totalInPipeline = roverBalance + Number(roverWsol) + distPoolBalance + programVaultBalance;
  console.log(`  rover_authority:  ${sol(roverBalance + Number(roverWsol))} SOL (native + WSOL)`);
  console.log(`  dist_pool:        ${sol(distPoolBalance)} SOL`);
  console.log(`  program_vault:    ${sol(programVaultBalance)} SOL`);
  console.log(`  ────────────────────────────────`);
  console.log(`  Total in pipeline: ${sol(totalInPipeline)} SOL`);

  if (monkeStateInfo) {
    const ms = parseMonkeState(monkeStateInfo.data);
    console.log(`  Already claimed:   ${sol(Number(ms.totalSolDistributed))} SOL (lifetime)`);
  }

  console.log('');
}

main().catch(err => {
  console.error('Dashboard error:', err.message);
  process.exit(1);
});
