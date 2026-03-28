/**
 * fee-dashboard.ts
 *
 * Queries all checkpoints in the crank.money fee pipeline and prints a summary.
 *
 *   1. rover_authority PDA  — accumulated fees (native SOL + WSOL ATA)
 *   2. bridge_vault PDA     — holder 40% pending stake_and_forward
 *   3. distributor vault    — $PEGGED available for Merkle claims
 *   4. distributor state    — epoch, root, funded/claimed totals
 *
 * Also reads bin_farm Config for fee_bps, bot address, and RoverAuthority for trader_dest.
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
const DISTRIBUTOR_PROGRAM_ID = new PublicKey(process.env.DISTRIBUTOR_PROGRAM_ID!);
const BRIDGE_PROGRAM_ID = new PublicKey(process.env.BRIDGE_PROGRAM_ID!);
const PEGGED_MINT = new PublicKey(process.env.PEGGED_MINT!);
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const connection = new Connection(RPC_URL, 'confirmed');

// PDA derivation helpers
const roverAuthorityPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], CORE_PROGRAM_ID);
const coreConfigPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('config')], CORE_PROGRAM_ID);
const distributorPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('distributor')], DISTRIBUTOR_PROGRAM_ID);
const bridgeVaultPDA = () =>
  PublicKey.findProgramAddressSync([Buffer.from('bridge_vault')], BRIDGE_PROGRAM_ID);

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
    return info.data.readBigUInt64LE(64);
  } catch {
    return 0n;
  }
}

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

async function main() {
  console.log('crank.money Fee Dashboard');
  console.log(`RPC: ${RPC_URL!.replace(/api-key=.*/, 'api-key=***')}`);
  console.log(`Time: ${new Date().toISOString()}`);

  const [roverPDA] = roverAuthorityPDA();
  const [configPDA] = coreConfigPDA();
  const [distPDA] = distributorPDA();
  const [bridgePDA] = bridgeVaultPDA();

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
    roverBalance,
    bridgeVaultBalance,
    botBalance,
  ] = await Promise.all([
    connection.getAccountInfo(configPDA),
    connection.getAccountInfo(roverPDA),
    connection.getBalance(roverPDA),
    connection.getBalance(bridgePDA),
    botPubkey ? connection.getBalance(botPubkey) : Promise.resolve(0),
  ]);

  // ─── bin_farm Config ───
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

  // ─── Checkpoint 1: rover_authority ───
  separator('Checkpoint 1: rover_authority (uncollected fees)');
  console.log(`  PDA:              ${roverPDA.toBase58()}`);
  console.log(`  Native SOL:       ${sol(roverBalance)} SOL`);

  const roverWsol = await queryTokenBalance(roverPDA, WSOL_MINT);
  console.log(`  WSOL ATA:         ${(Number(roverWsol) / LAMPORTS_PER_SOL).toFixed(9)} SOL`);

  if (roverInfo) {
    const rover = parseRoverAuthority(roverInfo.data);
    console.log(`  Revenue Dest:     ${rover.revenueDest.toBase58()}`);
    console.log(`  Rover Positions:  ${rover.totalRoverPositions}`);
  } else {
    console.log('  RoverAuthority account not found');
  }

  // ─── Checkpoint 2: bridge_vault ───
  separator('Checkpoint 2: bridge_vault (40% holder share, pending stake)');
  console.log(`  PDA:              ${bridgePDA.toBase58()}`);
  console.log(`  SOL Balance:      ${sol(bridgeVaultBalance)} SOL`);
  const bridgeUsable = Math.max(0, bridgeVaultBalance - 890880);
  console.log(`  Usable (- rent):  ${sol(bridgeUsable)} SOL`);

  // ─── Checkpoint 3: Merkle Distributor ───
  separator('Checkpoint 3: Merkle Distributor ($PEGGED vault)');
  console.log(`  PDA:              ${distPDA.toBase58()}`);

  // Read distributor vault $PEGGED balance
  const distVaultAta = getAssociatedTokenAddressSync(PEGGED_MINT, distPDA, true);
  const vaultPeggedBalance = await queryTokenBalance(distPDA, PEGGED_MINT);
  console.log(`  Vault ATA:        ${distVaultAta.toBase58()}`);
  console.log(`  $PEGGED Balance:  ${(Number(vaultPeggedBalance) / 1e9).toFixed(9)} PEGGED`);

  // Read distributor on-chain state via Anchor IDL
  try {
    const { Program, AnchorProvider, Wallet } = await import('@coral-xyz/anchor');
    const idlPath = path.join(__dirname, '..', 'bot', 'idl', 'merkle_distributor.json');
    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
    const wallet = botPubkey
      ? new Wallet(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.BOT_KEYPAIR_PATH!, 'utf-8')))))
      : new Wallet(Keypair.generate());
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    const program = new Program(idl, provider);
    const dist = await (program.account as any).distributor.fetch(distPDA);

    console.log(`  Current Epoch:    ${dist.currentEpoch}`);
    console.log(`  Total Funded:     ${(Number(dist.totalAmountFunded) / 1e9).toFixed(9)} PEGGED`);
    console.log(`  Total Claimed:    ${(Number(dist.totalAmountClaimed) / 1e9).toFixed(9)} PEGGED`);
    console.log(`  Unclaimed:        ${((Number(dist.totalAmountFunded) - Number(dist.totalAmountClaimed)) / 1e9).toFixed(9)} PEGGED`);
    console.log(`  Paused:           ${dist.paused}`);
    if (dist.ipfsCid) {
      console.log(`  IPFS CID:         ${dist.ipfsCid}`);
    }
  } catch (e: any) {
    console.log(`  (Could not read distributor state: ${e.message})`);
  }

  // ─── BOT WALLET ───
  if (botPubkey) {
    separator('Bot Wallet (20% operations)');
    console.log(`  Address:          ${botPubkey.toBase58()}`);
    console.log(`  SOL Balance:      ${sol(botBalance)} SOL`);
  }

  // ─── SUMMARY ───
  separator('Pipeline Summary');
  const totalSolInPipeline = roverBalance + Number(roverWsol) + bridgeVaultBalance;
  console.log(`  rover_authority:   ${sol(roverBalance + Number(roverWsol))} SOL (native + WSOL)`);
  console.log(`  bridge_vault:      ${sol(bridgeVaultBalance)} SOL (pending stake → $PEGGED)`);
  console.log(`  distributor vault: ${(Number(vaultPeggedBalance) / 1e9).toFixed(9)} $PEGGED`);
  console.log(`  ────────────────────────────────`);
  console.log(`  SOL in pipeline:   ${sol(totalSolInPipeline)} SOL`);

  console.log('');
}

main().catch(err => {
  console.error('Dashboard error:', err.message);
  process.exit(1);
});
