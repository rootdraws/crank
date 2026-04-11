/**
 * epoch-computer.ts
 *
 * Daily SOL distribution engine for crank.money.
 * Computes per-user shares, builds Merkle tree, drains epoch-vault,
 * wraps WSOL, funds distributor, auto-claims for all users.
 *
 * Share computation (v1): proportional to fees generated (fee_taken in harvests).
 * BANK holder weighting deferred to v2 (gauge-voter integration).
 *
 * Called by the keeper as part of the daily sequence.
 */

import {
  Connection, PublicKey, Keypair, Transaction, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Program, BN } from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction,
  NATIVE_MINT, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { WalletService } from '../packages/core-sdk/wallet-service';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import { keccak_256 } from '@noble/hashes/sha3';

// ─── Keccak Self-Test ────────────────────────────────────────────────────
// Verify at import time that we have real keccak-256 (not sha3-256).
// On-chain uses solana_program::keccak::hashv which is Keccak-256 (pre-NIST).
const KECCAK_TEST_HASH = '9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658';
const selfTest = Buffer.from(keccak_256(Buffer.from('test'))).toString('hex');
if (selfTest !== KECCAK_TEST_HASH) {
  throw new Error(`[epoch] FATAL: keccak256 self-test failed. Got ${selfTest}, expected ${KECCAK_TEST_HASH}. Merkle proofs would be invalid.`);
}

// ─── Config ───────────────────────────────────────────────────────────────

const EPOCH_VAULT_ID = new PublicKey('7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN');
const MERKLE_DIST_ID = new PublicKey('DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV');
const BIN_FARM_ID = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
const UNWRAP_WSOL_DISC = Buffer.from([0xbe, 0xf1, 0xf6, 0x3b, 0x58, 0xff, 0xd3, 0x35]);

/** Minimum SOL in vault to trigger an epoch (0.01 SOL) */
const MIN_EPOCH_LAMPORTS = 10_000_000;
/** Minimum claimable per user to trigger auto-claim (0.001 SOL) */
const MIN_CLAIM_LAMPORTS = 1_000_000;
/** Where to store epoch state + tree files */
const EPOCH_DATA_DIR = process.env.EPOCH_DATA_DIR || path.join(__dirname, 'data');

// ─── Merkle Tree ──────────────────────────────────────────────────────────

export interface Leaf {
  index: number;
  wallet: string;
  cumulative_amount: string;
  proof: number[][];
}

export function solanaKeccak256(...buffers: Buffer[]): Buffer {
  return Buffer.from(keccak_256(Buffer.concat(buffers)));
}

export function hashLeaf(index: bigint, wallet: PublicKey, cumulativeAmount: bigint): Buffer {
  const indexBuf = Buffer.alloc(8);
  indexBuf.writeBigUInt64LE(index);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(cumulativeAmount);
  return solanaKeccak256(indexBuf, wallet.toBuffer(), amountBuf);
}

export function hashPair(a: Buffer, b: Buffer): Buffer {
  if (Buffer.compare(a, b) <= 0) {
    return solanaKeccak256(a, b);
  }
  return solanaKeccak256(b, a);
}

export function buildMerkleTree(leaves: Buffer[]): { root: Buffer; proofs: Buffer[][] } {
  if (leaves.length === 0) return { root: Buffer.alloc(32), proofs: [] };
  if (leaves.length === 1) return { root: leaves[0], proofs: [[]] };

  // Pad to power of 2
  const size = Math.pow(2, Math.ceil(Math.log2(leaves.length)));
  const padded = [...leaves];
  while (padded.length < size) padded.push(Buffer.alloc(32));

  // Build tree bottom-up
  const tree: Buffer[][] = [padded];
  let level = padded;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hashPair(level[i], level[i + 1]));
    }
    tree.push(next);
    level = next;
  }

  // Extract proofs
  const proofs: Buffer[][] = [];
  for (let i = 0; i < leaves.length; i++) {
    const proof: Buffer[] = [];
    let idx = i;
    for (let lvl = 0; lvl < tree.length - 1; lvl++) {
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sibling < tree[lvl].length) {
        proof.push(tree[lvl][sibling]);
      }
      idx = Math.floor(idx / 2);
    }
    proofs.push(proof);
  }

  return { root: tree[tree.length - 1][0], proofs };
}

// ─── Epoch State ──────────────────────────────────────────────────────────

export interface EpochState {
  lastEpoch: number;
  cumulativeEntitlements: Record<string, string>; // wallet → cumulative lamports
  lastProcessedHarvestIndex: number;
  lastEpochTimestamp: number;
}

export function loadEpochState(): EpochState {
  const filePath = path.join(EPOCH_DATA_DIR, 'epoch-state.json');
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
}

function saveEpochState(state: EpochState): void {
  if (!fs.existsSync(EPOCH_DATA_DIR)) fs.mkdirSync(EPOCH_DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EPOCH_DATA_DIR, 'epoch-state.json'),
    JSON.stringify(state, null, 2)
  );
}

// ─── Epoch Progress (crash recovery) ─────────────────────────────────────

type EpochStage = 'tree_built' | 'drained' | 'wrapped' | 'published' | 'claimed' | 'complete';

interface EpochProgress {
  epoch: number;
  stage: EpochStage;
  drainAmount: string;
  merkleRoot: number[];
  ipfsCid: string;
  treePath: string;
  updatedEntitlements: Record<string, string>;
  lastProcessedHarvestIndex: number;
}

const PROGRESS_PATH = path.join(EPOCH_DATA_DIR, 'epoch-progress.json');

function loadProgress(): EpochProgress | null {
  try {
    if (fs.existsSync(PROGRESS_PATH)) {
      return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    }
  } catch (e: any) {
    logger.warn(`[epoch] Failed to load progress file: ${e.message}`);
  }
  return null;
}

function saveProgress(progress: EpochProgress): void {
  if (!fs.existsSync(EPOCH_DATA_DIR)) fs.mkdirSync(EPOCH_DATA_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

function clearProgress(): void {
  try { fs.unlinkSync(PROGRESS_PATH); } catch { /* already gone */ }
}

// ─── Share Computation ────────────────────────────────────────────────────

export interface UserShare {
  wallet: string;
  feesGenerated: bigint;
  share: bigint; // lamports for this epoch
}

export function computeShares(
  walletService: WalletService,
  availableLamports: bigint,
  state: EpochState,
): UserShare[] {
  // Read all harvests and compute per-user fee contribution
  const data = (walletService as any).data as any;
  const harvests: any[] = data.harvests || [];

  // Sum fees per wallet (only new harvests since last epoch)
  const feesByWallet = new Map<string, bigint>();
  for (let i = state.lastProcessedHarvestIndex; i < harvests.length; i++) {
    const h = harvests[i];
    const fee = BigInt(h.fee_taken || '0');
    if (fee <= 0n) continue;

    // Map vault_pda (or legacy wallet_pubkey) to user's vault PDA for Merkle tree
    const vaultKey = h.vault_pda || h.wallet_pubkey; // migration: old harvests use wallet_pubkey
    const userId = data.vaultIndex?.[vaultKey] || data.pubkeyIndex?.[vaultKey];
    if (!userId) {
      logger.warn(`[epoch] Harvest ${i}: unknown vault key ${vaultKey.slice(0, 8)}… — skipped`);
      continue;
    }
    const user = data.users[userId];
    if (!user) continue;

    // Merkle claimant = vault PDA address (on-chain claims go to vault)
    const wallet = user.vault_pda || user.wallet_pubkey;
    feesByWallet.set(wallet, (feesByWallet.get(wallet) || 0n) + fee);
  }

  // If no fees generated, skip distribution entirely.
  // Previous behavior distributed equally to ALL registered users, which enabled
  // sybil attacks: an attacker registers 100 wallets via /start and dilutes payouts.
  if (feesByWallet.size === 0) {
    return [];
  }

  // Proportional to fees generated
  const totalFees = Array.from(feesByWallet.values()).reduce((a, b) => a + b, 0n);
  if (totalFees === 0n) return [];

  const shares: UserShare[] = [];
  let allocated = 0n;
  const entries = Array.from(feesByWallet.entries());

  for (let i = 0; i < entries.length; i++) {
    const [wallet, fees] = entries[i];
    let share: bigint;
    if (i === entries.length - 1) {
      // Last user gets remainder to avoid rounding loss
      share = availableLamports - allocated;
    } else {
      share = (availableLamports * fees) / totalFees;
    }
    allocated += share;
    if (share > 0n) {
      shares.push({ wallet, feesGenerated: fees, share });
    }
  }

  return shares;
}

// ─── Main Epoch Flow ──────────────────────────────────────────────────────

export interface EpochResult {
  ran: boolean;
  epoch?: number;
  amountSol?: number;
  userCount?: number;
}

export interface EpochComputerConfig {
  connection: Connection;
  botKeypair: Keypair;
  walletService: WalletService;
  epochVaultProgram: Program;
  distributorProgram: Program;
  minEpochLamports?: number;
}

export async function runEpoch(config: EpochComputerConfig): Promise<EpochResult> {
  const { connection, botKeypair, walletService, epochVaultProgram, distributorProgram } = config;
  const bot = botKeypair.publicKey;
  const threshold = config.minEpochLamports ?? MIN_EPOCH_LAMPORTS;

  // ── Check for in-progress epoch (crash recovery) ──
  const existing = loadProgress();
  if (existing && existing.stage !== 'complete') {
    logger.info(`[epoch] Resuming interrupted epoch ${existing.epoch} from stage '${existing.stage}'`);
    return resumeEpoch(config, existing);
  }

  // 1. Check vault balance
  const [bridgeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_vault')], EPOCH_VAULT_ID
  );
  const vaultBalance = await connection.getBalance(bridgeVault);
  const rent = await connection.getMinimumBalanceForRentExemption(0);
  const available = BigInt(vaultBalance - rent);

  if (available < BigInt(threshold)) {
    logger.info(`[epoch] Vault has ${Number(available) / 1e9} SOL — below ${threshold / 1e9} threshold, skipping`);
    return { ran: false };
  }

  logger.info(`[epoch] Vault has ${Number(available) / 1e9} SOL — computing epoch`);

  // 2. Load state + compute shares
  const state = loadEpochState();
  const shares = computeShares(walletService, available, state);

  if (shares.length === 0) {
    logger.info('[epoch] No eligible users — skipping');
    return { ran: false };
  }

  logger.info(`[epoch] ${shares.length} users, distributing ${Number(available) / 1e9} SOL`);
  for (const s of shares) {
    logger.info(`  ${s.wallet.slice(0, 8)}... → ${Number(s.share) / 1e9} SOL`);
  }

  // 3. Update cumulative entitlements
  const updatedEntitlements = { ...state.cumulativeEntitlements };
  for (const s of shares) {
    const prev = BigInt(updatedEntitlements[s.wallet] || '0');
    updatedEntitlements[s.wallet] = (prev + s.share).toString();
  }

  // 4. Build Merkle tree (sort wallets for deterministic ordering)
  const wallets = Object.keys(updatedEntitlements).sort();
  const leafHashes: Buffer[] = [];
  const leafData: Leaf[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const cumAmount = BigInt(updatedEntitlements[wallet]);
    const leafHash = hashLeaf(BigInt(i), new PublicKey(wallet), cumAmount);
    leafHashes.push(leafHash);
    leafData.push({
      index: i,
      wallet,
      cumulative_amount: cumAmount.toString(),
      proof: [], // filled below
    });
  }

  const { root, proofs } = buildMerkleTree(leafHashes);
  for (let i = 0; i < leafData.length; i++) {
    leafData[i].proof = proofs[i].map(p => Array.from(p));
  }

  const merkleRoot = Array.from(root);
  const newEpochNum = state.lastEpoch + 1;

  // 5. Save tree locally
  const treeJson = { leaves: leafData, epoch: newEpochNum, amount: Number(available) };
  const treePath = path.join(EPOCH_DATA_DIR, `epoch-${newEpochNum}.json`);
  if (!fs.existsSync(EPOCH_DATA_DIR)) fs.mkdirSync(EPOCH_DATA_DIR, { recursive: true });
  fs.writeFileSync(treePath, JSON.stringify(treeJson, null, 2));
  logger.info(`[epoch] Tree saved: ${treePath}`);

  // 6. Upload to IPFS (if Pinata credentials available)
  let ipfsCid = '';
  const pinataJwt = process.env.PINATA_JWT;
  if (pinataJwt) {
    try {
      const resp = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${pinataJwt}`,
        },
        body: JSON.stringify({
          pinataContent: treeJson,
          pinataMetadata: { name: `crank-epoch-${newEpochNum}` },
        }),
      });
      const result = await resp.json() as any;
      ipfsCid = result.IpfsHash || '';
      logger.info(`[epoch] Tree pinned to IPFS: ${ipfsCid}`);
    } catch (e: any) {
      logger.warn(`[epoch] IPFS upload failed (non-fatal): ${e.message}`);
    }
  } else {
    logger.info('[epoch] No PINATA_JWT — skipping IPFS upload');
    ipfsCid = `local-epoch-${newEpochNum}`;
  }

  // ── CHECKPOINT: Save progress BEFORE draining vault ──
  // This is the critical invariant: tree + entitlements are on disk before
  // any SOL leaves the vault. If we crash after drain, we can resume.
  const wsData = (walletService as any).data as any;
  const progress: EpochProgress = {
    epoch: newEpochNum,
    stage: 'tree_built',
    drainAmount: available.toString(),
    merkleRoot,
    ipfsCid,
    treePath,
    updatedEntitlements,
    lastProcessedHarvestIndex: (wsData.harvests || []).length,
  };
  saveProgress(progress);
  logger.info('[epoch] Progress saved (tree_built) — safe to drain');

  // 7–11: Execute the on-chain pipeline with checkpoints
  return executeOnChainPipeline(config, progress);
}

/** Resume an interrupted epoch from the last completed stage. */
async function resumeEpoch(config: EpochComputerConfig, progress: EpochProgress): Promise<EpochResult> {
  // Load the tree from disk (saved before drain)
  if (!fs.existsSync(progress.treePath)) {
    logger.error(`[epoch] Cannot resume — tree file missing: ${progress.treePath}`);
    clearProgress();
    return { ran: false };
  }
  return executeOnChainPipeline(config, progress);
}

/** Execute (or resume) the on-chain pipeline from the current progress stage. */
async function executeOnChainPipeline(config: EpochComputerConfig, progress: EpochProgress): Promise<EpochResult> {
  const { connection, botKeypair, walletService, epochVaultProgram, distributorProgram } = config;
  const bot = botKeypair.publicKey;
  const available = BigInt(progress.drainAmount);
  const availableBN = new BN(progress.drainAmount);
  const merkleRoot = progress.merkleRoot;
  const ipfsCid = progress.ipfsCid;

  const [bridgeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_vault')], EPOCH_VAULT_ID
  );
  const [vaultConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')], EPOCH_VAULT_ID
  );
  const [distPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('distributor')], MERKLE_DIST_ID
  );
  const wsolVault = getAssociatedTokenAddressSync(NATIVE_MINT, distPDA, true, TOKEN_PROGRAM_ID);
  const botWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, bot, false, TOKEN_PROGRAM_ID);

  // Stage: drain vault
  if (progress.stage === 'tree_built') {
    // Check vault balance before draining — if a prior attempt drained but crashed
    // before saving progress, the vault is already empty. Skip to next stage.
    const vaultBalance = await connection.getBalance(bridgeVault);
    if (vaultBalance < Number(available)) {
      logger.info(`[epoch] Vault already drained (balance ${vaultBalance}), skipping drain`);
    } else {
      logger.info('[epoch] Draining vault...');
      const drainSig = await epochVaultProgram.methods
        .drainVault(availableBN)
        .accounts({
          authority: bot,
          config: vaultConfig,
          bridgeVault: bridgeVault,
          destination: bot,
        })
        .signers([botKeypair])
        .rpc();
      logger.info(`[epoch] Vault drained: ${drainSig}`);
    }
    progress.stage = 'drained';
    saveProgress(progress);
  }

  // Stage: wrap SOL → WSOL
  if (progress.stage === 'drained') {
    const wrapTx = new Transaction();
    wrapTx.add(createAssociatedTokenAccountIdempotentInstruction(bot, botWsolAta, bot, NATIVE_MINT, TOKEN_PROGRAM_ID));
    wrapTx.add(SystemProgram.transfer({ fromPubkey: bot, toPubkey: botWsolAta, lamports: available }));
    wrapTx.add(createSyncNativeInstruction(botWsolAta, TOKEN_PROGRAM_ID));

    const wrapSig = await sendAndConfirmTransaction(connection, wrapTx, [botKeypair], { commitment: 'confirmed' });
    logger.info(`[epoch] SOL wrapped to WSOL: ${wrapSig}`);
    progress.stage = 'wrapped';
    saveProgress(progress);
  }

  // Stage: publish new_epoch on-chain
  if (progress.stage === 'wrapped') {
    logger.info('[epoch] Calling new_epoch...');
    const newEpochSig = await distributorProgram.methods
      .newEpoch(merkleRoot, availableBN, ipfsCid)
      .accounts({
        distributor: distPDA,
        authority: bot,
        mint: NATIVE_MINT,
        vault: wsolVault,
        funderAta: botWsolAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([botKeypair])
      .rpc();
    logger.info(`[epoch] new_epoch TX: ${newEpochSig}`);

    // Close bot WSOL ATA (return remaining dust as SOL)
    try {
      const closeTx = new Transaction().add(
        createCloseAccountInstruction(botWsolAta, bot, bot, [], TOKEN_PROGRAM_ID)
      );
      await sendAndConfirmTransaction(connection, closeTx, [botKeypair], { commitment: 'confirmed' });
    } catch (e: any) {
      logger.warn(`[epoch] Bot WSOL ATA close failed (non-fatal): ${e.message?.slice(0, 80)}`);
    }
    progress.stage = 'published';
    saveProgress(progress);
  }

  // Stage: auto-claim for all users
  if (progress.stage === 'published') {
    const treeJson = JSON.parse(fs.readFileSync(progress.treePath, 'utf-8'));
    const leafData: Leaf[] = treeJson.leaves;

    logger.info('[epoch] Auto-claiming for users...');
    let claimCount = 0;
    for (const leaf of leafData) {
      const prevClaimed = await getAlreadyClaimed(connection, distPDA, new PublicKey(leaf.wallet));
      const cumAmount = BigInt(leaf.cumulative_amount);
      const claimable = cumAmount - prevClaimed;

      if (claimable < BigInt(MIN_CLAIM_LAMPORTS)) continue;

      try {
        await claimForUser(
          connection, distributorProgram, walletService, botKeypair,
          distPDA, leaf, claimable
        );
        claimCount++;
        logger.info(`  Claimed ${Number(claimable) / 1e9} SOL for ${leaf.wallet.slice(0, 8)}...`);
        // Throttle to avoid RPC rate limiting
        if (claimCount > 0) await new Promise(r => setTimeout(r, 500));
      } catch (e: any) {
        logger.warn(`  Claim failed for ${leaf.wallet.slice(0, 8)}...: ${e.message?.slice(0, 80)}`);
      }
    }
    logger.info(`[epoch] Auto-claim: ${claimCount}/${leafData.length} users`);
    progress.stage = 'claimed';
    saveProgress(progress);
  }

  // Stage: finalize epoch state
  if (progress.stage === 'claimed') {
    const state = loadEpochState();
    state.lastEpoch = progress.epoch;
    state.cumulativeEntitlements = progress.updatedEntitlements;
    state.lastProcessedHarvestIndex = progress.lastProcessedHarvestIndex;
    state.lastEpochTimestamp = Date.now();
    saveEpochState(state);

    progress.stage = 'complete';
    saveProgress(progress);
    clearProgress();

    const amountSol = Number(available) / 1e9;
    const userCount = Object.keys(progress.updatedEntitlements).length;
    logger.info(`[epoch] Epoch ${progress.epoch} complete — ${amountSol} SOL distributed to ${userCount} users`);
    return { ran: true, epoch: progress.epoch, amountSol, userCount };
  }

  return { ran: true, epoch: progress.epoch, amountSol: Number(available) / 1e9 };
}

// ─── Auto-Claim Helpers ───────────────────────────────────────────────────

async function getAlreadyClaimed(
  connection: Connection,
  distributorPDA: PublicKey,
  wallet: PublicKey,
): Promise<bigint> {
  const MERKLE_DIST_PROGRAM = MERKLE_DIST_ID;
  const [claimStatus] = PublicKey.findProgramAddressSync(
    [Buffer.from('claim_status'), distributorPDA.toBuffer(), wallet.toBuffer()],
    MERKLE_DIST_PROGRAM
  );
  try {
    const info = await connection.getAccountInfo(claimStatus);
    if (info && info.data.length >= 16) {
      return info.data.readBigUInt64LE(8); // skip discriminator
    }
  } catch (e: any) {
    logger.warn(`[epoch] Failed to read claim status for ${wallet.toBase58().slice(0, 8)}: ${e.message?.slice(0, 80)}`);
  }
  return 0n;
}

async function claimForUser(
  connection: Connection,
  distributorProgram: Program,
  walletService: WalletService,
  botKeypair: Keypair,
  distributorPDA: PublicKey,
  leaf: Leaf,
  claimable: bigint,
): Promise<void> {
  // leaf.wallet = vault PDA address (claimant in Merkle tree)
  const claimantPubkey = new PublicKey(leaf.wallet);
  const wsolVault = getAssociatedTokenAddressSync(NATIVE_MINT, distributorPDA, true, TOKEN_PROGRAM_ID);
  // Claimant ATA: WSOL ATA owned by the vault PDA (allowOwnerOffCurve=true for PDAs)
  const claimantWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, claimantPubkey, true, TOKEN_PROGRAM_ID);

  const [claimStatusPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('claim_status'), distributorPDA.toBuffer(), claimantPubkey.toBuffer()],
    MERKLE_DIST_ID
  );

  // Bot pays for everything. Ensure claimant (vault PDA) WSOL ATA exists.
  const createAtaTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(botKeypair.publicKey, claimantWsolAta, claimantPubkey, NATIVE_MINT, TOKEN_PROGRAM_ID)
  );
  await sendAndConfirmTransaction(connection, createAtaTx, [botKeypair], { commitment: 'confirmed' });

  // Build claim instruction (merkle-distributor)
  const proof = leaf.proof.map((p: number[]) => Array.from(Buffer.from(p)));
  const claimIx = await distributorProgram.methods
    .claim(
      new BN(leaf.index),
      new BN(leaf.cumulative_amount),
      proof,
    )
    .accounts({
      payer: botKeypair.publicKey,
      distributor: distributorPDA,
      mint: NATIVE_MINT,
      vault: wsolVault,
      claimant: claimantPubkey,
      claimantAta: claimantWsolAta,
      claimStatus: claimStatusPDA,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Build unwrap_wsol_in_vault instruction (bin-farm)
  // Closes vault WSOL ATA → lamports to vault PDA → deduct_gas reimburses bot
  const [binFarmConfigPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], BIN_FARM_ID);
  const unwrapIx = new TransactionInstruction({
    programId: BIN_FARM_ID,
    keys: [
      { pubkey: botKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: binFarmConfigPDA, isSigner: false, isWritable: false },
      { pubkey: claimantPubkey, isSigner: false, isWritable: true },
      { pubkey: claimantWsolAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: UNWRAP_WSOL_DISC,
  });

  // Bundle claim + unwrap in single tx: one tx fee, vault reimburses via deduct_gas
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: botKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [claimIx, unwrapIx],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([botKeypair]);
  const claimSig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({ signature: claimSig, blockhash, lastValidBlockHeight }, 'confirmed');
}
