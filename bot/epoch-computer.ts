/**
 * epoch-computer.ts
 *
 * Daily SOL distribution engine for crank.money.
 * Computes per-user shares, builds Merkle tree, drains epoch-vault,
 * wraps WSOL, funds distributor, auto-claims for all users.
 *
 * Share computation: proportional to fees generated (fee_taken in harvests),
 * weighted per-pool by on-chain PoolGauge.weight_bps when a gauge map is
 * passed in. BANK holders steer the split across pools via /vote (gauge-voter
 * integration live as of 2026-04-17).
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
  createSyncNativeInstruction,
  NATIVE_MINT, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { WalletService } from '../packages/core-sdk/wallet-service';
import { logger } from './logger';
import { alertEntitlementDrift } from './alerter';
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
const BANK_DIST_ID = new PublicKey('9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M');
const BANK_MINT_PK = new PublicKey('BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA');
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

/**
 * Write JSON atomically (tmp + rename). Crash mid-write leaves the old file
 * intact instead of a half-written JSON that fails to parse on restart.
 * Required for every checkpoint file — progress, state, tree snapshots —
 * since parse failure defeats crash recovery and re-runs epoch steps that
 * already committed on-chain (v2-M-09).
 */
function atomicWriteJson(filePath: string, obj: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function saveEpochState(state: EpochState): void {
  if (!fs.existsSync(EPOCH_DATA_DIR)) fs.mkdirSync(EPOCH_DATA_DIR, { recursive: true });
  atomicWriteJson(path.join(EPOCH_DATA_DIR, 'epoch-state.json'), state);
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
  atomicWriteJson(PROGRESS_PATH, progress);
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

/**
 * Load live on-chain `PoolGauge.weight_bps` for every gauge registered in
 * `curator.json`. Returns a map of `lb_pair → weight_bps`.
 *
 * PoolGauge layout (gauge-voter/src/lib.rs:403):
 *   [0..8]   discriminator
 *   [8..40]  lb_pair (Pubkey)
 *   [40..48] weight_bps (u64 LE)    ← we read this
 *   [48]     enabled (bool)         ← zero-weight if disabled
 *   [49]     bump
 *
 * Ungaugeed pools (in harvest records but not in curator.json) implicitly map
 * to 0 weight → their fee contributions are dropped from the BANK pie.
 */
export async function loadGaugeWeights(connection: Connection): Promise<Record<string, bigint>> {
  const { loadGauges } = await import('../packages/core-sdk/pool-config');
  const { getPoolGaugePDA } = await import('../packages/core-sdk/pda');
  const gauges = loadGauges(); // symbol → lb_pair
  const lbPairs = Object.values(gauges);
  if (lbPairs.length === 0) return {};

  const gaugePdas: PublicKey[] = lbPairs.map(lp => getPoolGaugePDA(new PublicKey(lp))[0]);
  const result: Record<string, bigint> = {};

  const BATCH = 100;
  for (let i = 0; i < gaugePdas.length; i += BATCH) {
    const chunk = gaugePdas.slice(i, i + BATCH);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    for (let j = 0; j < infos.length; j++) {
      const info = infos[j];
      const lbPair = lbPairs[i + j];
      if (!info || info.data.length < 49) {
        // Gauge PDA not initialized → treat as 0 weight
        result[lbPair] = 0n;
        continue;
      }
      const enabled = info.data.readUInt8(48) === 1;
      if (!enabled) {
        result[lbPair] = 0n;
        continue;
      }
      result[lbPair] = info.data.readBigUInt64LE(40);
    }
  }
  return result;
}

export function computeShares(
  walletService: WalletService,
  availableLamports: bigint,
  state: EpochState,
  // lb_pair → weight_bps. When present, each harvest's fee is multiplied
  // by weight_bps/10000 before summing. Pools not in the map contribute 0.
  // When absent (or empty), falls back to flat fee-proportional distribution.
  gaugeWeights?: Record<string, bigint>,
): UserShare[] {
  // Read all harvests and compute per-user fee contribution
  const data = (walletService as any).data as any;
  const harvests: any[] = data.harvests || [];
  const hasGaugeMap = !!gaugeWeights && Object.keys(gaugeWeights).length > 0;

  // Sum fees per wallet (only new harvests since last epoch)
  const feesByWallet = new Map<string, bigint>();
  for (let i = state.lastProcessedHarvestIndex; i < harvests.length; i++) {
    const h = harvests[i];
    const rawFee = BigInt(h.fee_taken || '0');
    if (rawFee <= 0n) continue;

    // Apply gauge weight when the caller supplied a map.
    // Harvests from ungaugeed pools (or pools with zero weight) contribute 0 —
    // this is the protocol invariant post gauge-voter integration (2026-04-17).
    let fee = rawFee;
    if (hasGaugeMap) {
      const weightBps = gaugeWeights![h.lb_pair] ?? 0n;
      if (weightBps === 0n) continue;
      fee = (rawFee * weightBps) / 10000n;
      if (fee === 0n) continue;
    }

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

  // 2. Load state + gauge weights + compute shares
  const state = loadEpochState();
  const gaugeWeights = await loadGaugeWeights(connection);
  logger.info(`[epoch] Loaded ${Object.keys(gaugeWeights).length} gauge weight(s)`);
  const shares = computeShares(walletService, available, state, gaugeWeights);

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

  // 3b. Reconcile against on-chain claim_status before tree build (v2-H-04).
  // Guards against DB-rollback → claim lockout via cumulative underflow.
  const [solDistributorPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('distributor')], MERKLE_DIST_ID,
  );
  const reconciledEntitlements = await reconcileEntitlementsAgainstOnChain(
    connection, solDistributorPDA, MERKLE_DIST_ID, updatedEntitlements, 'SOL',
  );

  // 4. Build Merkle tree (sort wallets for deterministic ordering)
  const wallets = Object.keys(reconciledEntitlements).sort();
  const leafHashes: Buffer[] = [];
  const leafData: Leaf[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const cumAmount = BigInt(reconciledEntitlements[wallet]);
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
  atomicWriteJson(treePath, treeJson);
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
    updatedEntitlements: reconciledEntitlements,
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

  // Stage: drain vault directly into distributor WSOL vault (non-custodial).
  // system_program::transfer deposits lamports onto the WSOL ATA; sync_native
  // (next stage) promotes them into the SPL token amount. Nothing touches the
  // bot wallet.
  if (progress.stage === 'tree_built') {
    const distWsolBefore = await connection.getTokenAccountBalance(wsolVault).catch(() => null);
    const distVaultLamportsBefore = await connection.getBalance(wsolVault);
    logger.info(
      `[epoch] Draining ${available} lamports from bridge_vault → distributor WSOL vault (lamports pre=${distVaultLamportsBefore}, wsol=${distWsolBefore?.value.amount ?? 'n/a'})`,
    );
    const drainSig = await epochVaultProgram.methods
      .drainVault(availableBN)
      .accounts({
        authority: bot,
        config: vaultConfig,
        bridgeVault: bridgeVault,
        destination: wsolVault,
      })
      .signers([botKeypair])
      .rpc();
    logger.info(`[epoch] Vault drained to distributor WSOL vault: ${drainSig}`);
    progress.stage = 'drained';
    saveProgress(progress);
  }

  // Stage: sync_native to promote the deposited lamports into the SPL WSOL
  // token balance. After this, distributor.vault.amount reflects the new
  // funding and new_epoch can compute the delta authoritatively.
  if (progress.stage === 'drained') {
    const syncTx = new Transaction();
    syncTx.add(createSyncNativeInstruction(wsolVault, TOKEN_PROGRAM_ID));
    const syncSig = await sendAndConfirmTransaction(connection, syncTx, [botKeypair], { commitment: 'confirmed' });
    logger.info(`[epoch] sync_native on distributor WSOL vault: ${syncSig}`);
    progress.stage = 'wrapped'; // reuse existing stage name for compat
    saveProgress(progress);
  }

  // Stage: publish new_epoch on-chain. Non-custodial — no transfer happens.
  // The on-chain ix reads vault.amount + total_claimed - total_funded.
  if (progress.stage === 'wrapped') {
    logger.info('[epoch] Calling new_epoch (non-custodial)...');
    const newEpochSig = await distributorProgram.methods
      .newEpoch(merkleRoot, ipfsCid)
      .accounts({
        distributor: distPDA,
        authority: bot,
        vault: wsolVault,
      })
      .signers([botKeypair])
      .rpc();
    logger.info(`[epoch] new_epoch TX: ${newEpochSig}`);
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

/**
 * Pre-publish reconciliation against on-chain `claim_status.cumulative_claimed`.
 *
 * Rationale (audit v2-H-04): distribution uses cumulative accounting. If
 * `data/crankbot.json` (or `epoch-state.json`) is restored from a backup
 * taken BEFORE a harvest that produced some entitlement X which later got
 * claimed on-chain (cumulative_claimed = X), the local `cumulativeEntitlements`
 * rewinds. If we publish a tree where `leaf.cumulative_amount < X`, the
 * on-chain distributor's `checked_sub(leaf.cumulative_amount, claim_status.cumulative_claimed)`
 * underflows and reverts `NothingToClaim` — permanently locking the user out
 * of new entitlements until their cumulative naturally grows past X.
 *
 * Fix: before tree build, batch-fetch claim_status for every candidate wallet.
 * If on-chain claimed > local entitlement, bump local to match so the new
 * leaf's cumulative_amount is always ≥ what's already claimed on-chain.
 * Fires an ops alert whenever any bump happens (indicates DB drift worth
 * investigating).
 */
export async function reconcileEntitlementsAgainstOnChain(
  connection: Connection,
  distributorPDA: PublicKey,
  distributorProgramId: PublicKey,
  entitlements: Record<string, string>,
  tree: 'SOL' | 'BANK',
): Promise<Record<string, string>> {
  const wallets = Object.keys(entitlements);
  if (wallets.length === 0) return entitlements;

  // Derive claim_status PDAs for every wallet.
  const claimStatusPdas: PublicKey[] = wallets.map(w => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('claim_status'), distributorPDA.toBuffer(), new PublicKey(w).toBuffer()],
      distributorProgramId,
    );
    return pda;
  });

  // Batch getMultipleAccounts (100 per RPC call).
  const accountInfos: (Awaited<ReturnType<Connection['getAccountInfo']>> | null)[] = [];
  const BATCH = 100;
  for (let i = 0; i < claimStatusPdas.length; i += BATCH) {
    const chunk = claimStatusPdas.slice(i, i + BATCH);
    const infos = await connection.getMultipleAccountsInfo(chunk);
    for (const info of infos) accountInfos.push(info);
  }

  const reconciled: Record<string, string> = { ...entitlements };
  const bumps: Array<{ wallet: string; localWas: bigint; onChain: bigint }> = [];

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const info = accountInfos[i];
    // No claim_status yet = on-chain claimed is 0 → no reconciliation needed
    if (!info || info.data.length < 16) continue;
    const onChainClaimed = info.data.readBigUInt64LE(8); // skip 8-byte discriminator
    const local = BigInt(reconciled[wallet]);
    if (onChainClaimed > local) {
      bumps.push({ wallet, localWas: local, onChain: onChainClaimed });
      reconciled[wallet] = onChainClaimed.toString();
    }
  }

  if (bumps.length > 0) {
    const sample = bumps.slice(0, 3).map(b =>
      `${b.wallet.slice(0, 8)}… local=${b.localWas.toString()} onChain=${b.onChain.toString()}`
    ).join('; ');
    logger.warn(
      `[${tree === 'SOL' ? 'epoch' : 'bank-epoch'}] RECONCILE: ${bumps.length} wallet(s) had local < on-chain claimed — bumped to prevent claim lockout. ${sample}`
    );
    // Fire ops alert (non-fatal — don't block epoch publish)
    alertEntitlementDrift(tree, bumps.length, sample).catch(e =>
      logger.warn(`[epoch] alertEntitlementDrift dispatch failed: ${e.message?.slice(0, 80)}`)
    );
  } else {
    logger.info(`[${tree === 'SOL' ? 'epoch' : 'bank-epoch'}] reconcile: ${wallets.length} wallet(s) checked, no drift`);
  }

  return reconciled;
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

// ─── BANK Epoch ───────────────────────────────────────────────────────────
//
// Mirrors runEpoch() for BANK. Differences from SOL flow:
//   - No drain (BANK lives in bot's BANK ATA via rover_burn_and_mint).
//   - No wrap/unwrap (BANK is a standard SPL token, not native).
//   - Talks to bank-distributor program (separate PDA, same seeds).
//   - Separate state file (epoch-state-bank.json) and tree files.
//
// Trader weights are computed from the same `harvests` table as the SOL tree,
// using the same `computeShares` function. Per-pool gauge weights from
// `loadGaugeWeights` modulate each harvest's fee contribution, so BANK flows
// toward pools that BANK holders have voted for.

const MIN_BANK_EPOCH_UNITS = 1_000n; // 0.001 BANK (6 decimals) min to trigger epoch
const MIN_BANK_CLAIM_UNITS = 100n;   // min claimable per user

function loadBankEpochState(): EpochState {
  const filePath = path.join(EPOCH_DATA_DIR, 'epoch-state-bank.json');
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
}

function saveBankEpochState(state: EpochState): void {
  if (!fs.existsSync(EPOCH_DATA_DIR)) fs.mkdirSync(EPOCH_DATA_DIR, { recursive: true });
  atomicWriteJson(path.join(EPOCH_DATA_DIR, 'epoch-state-bank.json'), state);
}

export interface BankEpochConfig {
  connection: Connection;
  botKeypair: Keypair;
  walletService: WalletService;
  bankDistributorProgram: Program;
}

export async function runBankEpoch(config: BankEpochConfig): Promise<EpochResult> {
  const { connection, botKeypair, walletService, bankDistributorProgram } = config;
  const bot = botKeypair.publicKey;

  // 1. Read bank-distributor vault balance and compute this-epoch delta
  // (mirrors on-chain new_epoch math for logging — on-chain is authoritative).
  const [bankDist] = PublicKey.findProgramAddressSync([Buffer.from('distributor')], BANK_DIST_ID);
  const bankVault = getAssociatedTokenAddressSync(BANK_MINT_PK, bankDist, true, TOKEN_PROGRAM_ID);

  const vaultInfo = await connection.getAccountInfo(bankVault);
  if (!vaultInfo || vaultInfo.data.length < 72) {
    logger.info('[bank-epoch] bank-distributor vault missing — skipping');
    return { ran: false };
  }
  const vaultBalance = vaultInfo.data.readBigUInt64LE(64);

  // Fetch distributor state for total_amount_funded + total_amount_claimed
  const distState = await bankDistributorProgram.account.distributor.fetch(bankDist);
  const totalFunded = BigInt(distState.totalAmountFunded.toString());
  const totalClaimed = BigInt(distState.totalAmountClaimed.toString());
  const amount = vaultBalance + totalClaimed - totalFunded;

  if (amount < MIN_BANK_EPOCH_UNITS) {
    logger.info(
      `[bank-epoch] delta ${amount} (vault=${vaultBalance} funded=${totalFunded} claimed=${totalClaimed}) < ${MIN_BANK_EPOCH_UNITS} — skipping`,
    );
    return { ran: false };
  }

  // 2. Compute shares from harvests (same weighting as SOL tree)
  const state = loadBankEpochState();
  const gaugeWeights = await loadGaugeWeights(connection);
  logger.info(`[bank-epoch] Loaded ${Object.keys(gaugeWeights).length} gauge weight(s)`);
  const shares = computeShares(walletService, amount, state, gaugeWeights);
  if (shares.length === 0) {
    logger.info('[bank-epoch] No eligible users — skipping');
    return { ran: false };
  }

  logger.info(`[bank-epoch] ${shares.length} users, distributing ${amount} BANK units`);

  // 3. Update cumulative entitlements
  const updatedEntitlements = { ...state.cumulativeEntitlements };
  for (const s of shares) {
    const prev = BigInt(updatedEntitlements[s.wallet] || '0');
    updatedEntitlements[s.wallet] = (prev + s.share).toString();
  }

  // 3b. Reconcile against on-chain claim_status before tree build (v2-H-04).
  const reconciledEntitlements = await reconcileEntitlementsAgainstOnChain(
    connection, bankDist, BANK_DIST_ID, updatedEntitlements, 'BANK',
  );

  // 4. Build Merkle tree
  const wallets = Object.keys(reconciledEntitlements).sort();
  const leafHashes: Buffer[] = [];
  const leafData: Leaf[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const cumAmount = BigInt(reconciledEntitlements[wallet]);
    leafHashes.push(hashLeaf(BigInt(i), new PublicKey(wallet), cumAmount));
    leafData.push({ index: i, wallet, cumulative_amount: cumAmount.toString(), proof: [] });
  }
  const { root, proofs } = buildMerkleTree(leafHashes);
  for (let i = 0; i < leafData.length; i++) {
    leafData[i].proof = proofs[i].map(p => Array.from(p));
  }

  const newEpochNum = state.lastEpoch + 1;
  const treeJson = { leaves: leafData, epoch: newEpochNum, amount: Number(amount) };
  const treePath = path.join(EPOCH_DATA_DIR, `epoch-${newEpochNum}-bank.json`);
  if (!fs.existsSync(EPOCH_DATA_DIR)) fs.mkdirSync(EPOCH_DATA_DIR, { recursive: true });
  atomicWriteJson(treePath, treeJson);
  logger.info(`[bank-epoch] Tree saved: ${treePath}`);

  // 5. Pin to IPFS (non-fatal)
  let ipfsCid = `local-bank-epoch-${newEpochNum}`;
  const pinataJwt = process.env.PINATA_JWT;
  if (pinataJwt) {
    try {
      const resp = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${pinataJwt}` },
        body: JSON.stringify({ pinataContent: treeJson, pinataMetadata: { name: `crank-bank-epoch-${newEpochNum}` } }),
      });
      const result = await resp.json() as any;
      ipfsCid = result.IpfsHash || ipfsCid;
      logger.info(`[bank-epoch] Tree pinned: ${ipfsCid}`);
    } catch (e: any) {
      logger.warn(`[bank-epoch] IPFS upload failed (non-fatal): ${e.message}`);
    }
  }

  // 6. Publish merkle root — vault is already funded by rover_burn_and_mint.
  // new_epoch reads vault.amount + total_claimed - total_funded on-chain.
  const merkleRoot = Array.from(root);
  await bankDistributorProgram.methods
    .newEpoch(merkleRoot, ipfsCid)
    .accounts({
      distributor: bankDist,
      authority: bot,
      vault: bankVault,
    })
    .signers([botKeypair])
    .rpc();
  logger.info(`[bank-epoch] new_epoch published (epoch ${newEpochNum})`);

  // 7. Auto-claim BANK for each user. No wrap/unwrap — claims deposit BANK
  //    directly into each claimant's (vault PDA's) BANK ATA.
  let claimCount = 0;
  for (const leaf of leafData) {
    const claimantPubkey = new PublicKey(leaf.wallet);
    const [claimStatus] = PublicKey.findProgramAddressSync(
      [Buffer.from('claim_status'), bankDist.toBuffer(), claimantPubkey.toBuffer()],
      BANK_DIST_ID,
    );

    // Already claimed?
    let prevClaimed = 0n;
    try {
      const csInfo = await connection.getAccountInfo(claimStatus);
      if (csInfo && csInfo.data.length >= 16) {
        prevClaimed = csInfo.data.readBigUInt64LE(8);
      }
    } catch { /* not yet initialized */ }

    const claimable = BigInt(leaf.cumulative_amount) - prevClaimed;
    if (claimable < MIN_BANK_CLAIM_UNITS) continue;

    const claimantBankAta = getAssociatedTokenAddressSync(BANK_MINT_PK, claimantPubkey, true, TOKEN_PROGRAM_ID);

    try {
      // Create claimant BANK ATA + claim in one tx
      const preIx = createAssociatedTokenAccountIdempotentInstruction(
        bot, claimantBankAta, claimantPubkey, BANK_MINT_PK, TOKEN_PROGRAM_ID,
      );
      const proof = leaf.proof.map((p: number[]) => Array.from(Buffer.from(p)));
      await bankDistributorProgram.methods
        .claim(new BN(leaf.index), new BN(leaf.cumulative_amount), proof)
        .accounts({
          payer: bot,
          distributor: bankDist,
          mint: BANK_MINT_PK,
          vault: bankVault,
          claimant: claimantPubkey,
          claimantAta: claimantBankAta,
          claimStatus,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([preIx])
        .signers([botKeypair])
        .rpc();
      claimCount++;
      if (claimCount > 0) await new Promise(r => setTimeout(r, 500));
    } catch (e: any) {
      logger.warn(`[bank-epoch] Claim failed for ${leaf.wallet.slice(0, 8)}…: ${e.message?.slice(0, 80)}`);
    }
  }
  logger.info(`[bank-epoch] Auto-claim: ${claimCount}/${leafData.length} users`);

  // 8. Finalize state
  const wsData = (walletService as any).data as any;
  state.lastEpoch = newEpochNum;
  state.cumulativeEntitlements = reconciledEntitlements;
  state.lastProcessedHarvestIndex = (wsData.harvests || []).length;
  state.lastEpochTimestamp = Date.now();
  saveBankEpochState(state);

  return { ran: true, epoch: newEpochNum, amountSol: Number(amount) / 1e6, userCount: leafData.length };
}

// ─── Epoch-miss detection ─────────────────────────────────────────────────

export interface EpochMissReport {
  /** Hours since last successful SOL epoch, iff bridge_vault has eligible SOL. */
  solStaleHours: number | null;
  solAvailableLamports: bigint;
  /** Hours since last successful BANK epoch, iff bank-distributor vault has eligible delta. */
  bankStaleHours: number | null;
  bankDeltaUnits: bigint;
}

/**
 * A miss is only a miss if there's something to distribute.
 * Post-2026-04-13 amendment, sweep_rover runs full-magnesium and bridge_vault
 * can sit empty for days by design. This gates the alert on actual eligible
 * balance so we only page when a genuine epoch is stuck.
 */
export async function detectEpochMiss(
  connection: Connection,
  bankDistributorProgram: Program | null,
  staleThresholdHours = 26,
): Promise<EpochMissReport> {
  const now = Date.now();
  const report: EpochMissReport = {
    solStaleHours: null,
    solAvailableLamports: 0n,
    bankStaleHours: null,
    bankDeltaUnits: 0n,
  };

  // SOL side — bridge_vault lamports minus rent vs MIN_EPOCH_LAMPORTS
  try {
    const [bridgeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from('bridge_vault')], EPOCH_VAULT_ID,
    );
    const lamports = await connection.getBalance(bridgeVault);
    const rent = await connection.getMinimumBalanceForRentExemption(0);
    const available = BigInt(Math.max(0, lamports - rent));
    report.solAvailableLamports = available;

    if (available >= BigInt(MIN_EPOCH_LAMPORTS)) {
      const state = loadEpochState();
      if (state.lastEpochTimestamp > 0) {
        const h = (now - state.lastEpochTimestamp) / 3_600_000;
        if (h > staleThresholdHours) report.solStaleHours = h;
      } else {
        report.solStaleHours = Infinity;
      }
    }
  } catch (e: any) {
    logger.warn(`[epoch-miss] SOL probe failed: ${e.message}`);
  }

  // BANK side — vault.amount + totalClaimed − totalFunded vs MIN_BANK_EPOCH_UNITS
  if (bankDistributorProgram) {
    try {
      const [bankDist] = PublicKey.findProgramAddressSync(
        [Buffer.from('distributor')], BANK_DIST_ID,
      );
      const bankVault = getAssociatedTokenAddressSync(
        BANK_MINT_PK, bankDist, true, TOKEN_PROGRAM_ID,
      );
      const vaultInfo = await connection.getAccountInfo(bankVault);
      if (vaultInfo && vaultInfo.data.length >= 72) {
        const vaultBalance = vaultInfo.data.readBigUInt64LE(64);
        const distState = await bankDistributorProgram.account.distributor.fetch(bankDist);
        const totalFunded = BigInt((distState as any).totalAmountFunded.toString());
        const totalClaimed = BigInt((distState as any).totalAmountClaimed.toString());
        const delta = vaultBalance + totalClaimed - totalFunded;
        report.bankDeltaUnits = delta;

        if (delta >= MIN_BANK_EPOCH_UNITS) {
          const state = loadBankEpochState();
          if (state.lastEpochTimestamp > 0) {
            const h = (now - state.lastEpochTimestamp) / 3_600_000;
            if (h > staleThresholdHours) report.bankStaleHours = h;
          } else {
            report.bankStaleHours = Infinity;
          }
        }
      }
    } catch (e: any) {
      logger.warn(`[epoch-miss] BANK probe failed: ${e.message}`);
    }
  }

  return report;
}

