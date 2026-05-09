/**
 * core-sdk/wallet-service.ts
 *
 * User vault mapping + position/vote/harvest tracking for CrankBot.
 * Platform-agnostic — works with Discord, Telegram, or any chat platform.
 *
 * PDA VAULT ARCHITECTURE:
 * - No custodial keypairs. User funds live on-chain in UserVault PDAs.
 * - This service maps user_id → owner_wallet → vault_pda.
 * - DB loss = inconvenience (re-link), NOT fund loss.
 * - The bot is a stateless operator that reads on-chain state.
 */

import { PublicKey } from '@solana/web3.js';
import * as path from 'path';
import * as fs from 'fs';
import { getUserVaultPDA } from './pda';

export class WalletAlreadyClaimedError extends Error {
  constructor(public readonly ownerWallet: string, public readonly existingUserId: string) {
    super(`wallet ${ownerWallet} is already bound to a different account`);
    this.name = 'WalletAlreadyClaimedError';
  }
}

// ─── JSON File Store ───────────────────────────────────────────────────────

interface UserRecord {
  user_id: string;
  owner_wallet: string;      // User's real Solana wallet (PDA seed)
  vault_pda: string;         // Derived: getUserVaultPDA(owner_wallet)
  created_at: number;
}

/**
 * Treasury-matched position: created when bot wraps a user's open in a Path B
 * governance proposal. Linked to the user's Path A position by user_position_pda.
 */
export interface TreasuryPositionRecord {
  treasury_position_pda: string;
  user_position_pda: string;
  proposer_user_id: string;
  proposer_wallet: string;             // Real wallet pubkey — for ATA derivation at close
  meteora_position: string;
  treasury_vault: string;              // bin-farm UserVault owned by Native Treasury PDA
  lb_pair: string;
  side: 'Buy' | 'Sell';
  min_bin_id: number;
  max_bin_id: number;
  matched_amount: string;              // raw u64 as string
  output_mint: string;                 // SOL=NATIVE_MINT for sells, CRANK for buys
  payout_bps: number;                  // snapshot from Config at open
  status: 'open' | 'closed';
  opened_at: number;
  closed_at?: number;
  proposer_payout_amount?: string;     // raw amount paid at close (settled)
  open_proposal_pda?: string;
  close_proposal_pda?: string;
}

/**
 * Lifecycle state for an in-flight treasury proposal. Keyed by proposal_pda
 * once known, by deterministic payload hash before that.
 */
export type ProposalKind = 'open' | 'close' | 'bootstrap';
export type ProposalStatus = 'pending' | 'inserted' | 'voted' | 'executed' | 'failed' | 'cancelled';

export interface OpenProposalRecord {
  proposal_pda: string;
  kind: ProposalKind;
  status: ProposalStatus;
  user_position_pda?: string;
  treasury_position_pda?: string;
  insert_tx_sig?: string;
  execute_tx_sig?: string;
  retry_count: number;
  last_error?: string;
  created_at: number;
  updated_at: number;
  /** sha256 of inner ix payload — replay/idempotency detection */
  payload_hash: string;
}

interface StoreData {
  users: Record<string, UserRecord>;
  /** Reverse lookup: vault_pda → user_id (for harvest routing) */
  vaultIndex: Record<string, string>;
  /** Reverse lookup: owner_wallet → user_id */
  ownerIndex: Record<string, string>;
  positions: Record<string, {
    position_pda: string; user_id: string; vault_pda: string;
    lb_pair: string; meteora_position: string; side: string;
    min_bin_id: number; max_bin_id: number; initial_amount: string;
    status: string; created_at: number;
    /** JUP market-quote output for the deposit at open time (raw bigint string). */
    baseline_out?: string;
    /** Mint of the baseline output (= converted side — X on Buy, Y on Sell). */
    baseline_mint?: string;
    /** Decimals of the baseline mint (for display without re-looking up). */
    baseline_decimals?: number;
    /** USD value of the deposit at open time (frozen, for aggregate volume metrics). */
    initial_usd?: number | null;
    /** Set when a Path B treasury match has been opened against this position. */
    treasury_position_pda?: string;
  }>;
  votes: Record<string, { vault_pda: string; pool_address: string; allocation_pct: number; updated_at: number }>;
  harvests: Array<{
    position_pda: string; vault_pda: string; lb_pair: string;
    amount_out: string; fee_taken: string; tx_sig: string;
    epoch: number; slot: number; created_at: number;
    /** USD value of the converted output, frozen at event time. null = uncomputable. */
    usd_value?: number | null;
    /** 'harvest' (partial) or 'close' (terminal). Default 'harvest' for legacy rows. */
    kind?: 'harvest' | 'close';
  }>;
  /** Treasury-matched positions (Path B). Keyed by treasury_position_pda. */
  treasury_positions?: Record<string, TreasuryPositionRecord>;
  /** Reverse lookup: user_position_pda → treasury_position_pda (1:1 link). */
  treasury_by_user_position?: Record<string, string>;
  /** In-flight + completed governance proposals. Keyed by proposal_pda once known. */
  open_proposals?: Record<string, OpenProposalRecord>;
}

function emptyStore(): StoreData {
  return {
    users: {},
    vaultIndex: {},
    ownerIndex: {},
    positions: {},
    votes: {},
    harvests: [],
    treasury_positions: {},
    treasury_by_user_position: {},
    open_proposals: {},
  };
}

// ─── WalletService ─────────────────────────────────────────────────────────

export class WalletService {
  private data: StoreData;
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.DB_PATH || './data/crankbot.json';
    const finalPath = resolvedPath.endsWith('.db')
      ? resolvedPath.replace('.db', '.json')
      : resolvedPath;
    this.filePath = finalPath;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    if (fs.existsSync(this.filePath)) {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      // Migration: ensure new index fields exist
      if (!this.data.vaultIndex) this.data.vaultIndex = {};
      if (!this.data.ownerIndex) this.data.ownerIndex = {};
      if (!this.data.harvests) this.data.harvests = [];
      // Treasury-match additions (2026-05): backfill if missing
      if (!this.data.treasury_positions) this.data.treasury_positions = {};
      if (!this.data.treasury_by_user_position) this.data.treasury_by_user_position = {};
      if (!this.data.open_proposals) this.data.open_proposals = {};
      // Backfill indexes from users (migration from old format)
      if (!this.data.users) this.data.users = {};
      for (const u of Object.values(this.data.users)) {
        if (u.vault_pda) this.data.vaultIndex[u.vault_pda] = u.user_id;
        if (u.owner_wallet) this.data.ownerIndex[u.owner_wallet] = u.user_id;
      }
    } else {
      this.data = emptyStore();
    }

    this.saveTimer = setInterval(() => this.flush(), 5_000);
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  // ─── User / Vault Registration ──────────────────────────────────────────

  /**
   * Register a user with their real Solana wallet. Derives and stores
   * the vault PDA. Returns the vault PDA address (deposit target).
   * Idempotent — returns existing vault if already registered.
   */
  registerUser(userId: string, ownerWallet: PublicKey): { vaultPda: PublicKey; isNew: boolean } {
    const existing = this.data.users[userId];
    if (existing) {
      return { vaultPda: new PublicKey(existing.vault_pda), isNew: false };
    }

    const [vaultPda] = getUserVaultPDA(ownerWallet);
    const vaultStr = vaultPda.toBase58();
    const ownerStr = ownerWallet.toBase58();

    const priorOwnerBinding = this.data.ownerIndex[ownerStr];
    if (priorOwnerBinding && priorOwnerBinding !== userId) {
      throw new WalletAlreadyClaimedError(ownerStr, priorOwnerBinding);
    }

    this.data.users[userId] = {
      user_id: userId,
      owner_wallet: ownerStr,
      vault_pda: vaultStr,
      created_at: Date.now(),
    };
    this.data.vaultIndex[vaultStr] = userId;
    this.data.ownerIndex[ownerStr] = userId;
    this.markDirty();
    // Flush immediately on registration (like old keypair creation sync flush)
    this.dirty = false;
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });

    return { vaultPda, isNew: true };
  }

  /**
   * Remove a user registration. Used when on-chain vault creation fails
   * after local registration, to prevent orphaned DB entries.
   */
  removeUser(userId: string): void {
    const user = this.data.users[userId];
    if (!user) return;
    delete this.data.vaultIndex[user.vault_pda];
    delete this.data.ownerIndex[user.owner_wallet];
    delete this.data.users[userId];
    this.dirty = false;
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  /**
   * Get vault PDA for a user. Returns undefined if not registered.
   */
  getVaultPda(userId: string): PublicKey | undefined {
    const user = this.data.users[userId];
    return user ? new PublicKey(user.vault_pda) : undefined;
  }

  /**
   * Get the user's real wallet (owner). Used for display and event routing.
   */
  getOwnerWallet(userId: string): PublicKey | undefined {
    const user = this.data.users[userId];
    return user ? new PublicKey(user.owner_wallet) : undefined;
  }

  /**
   * Get the deposit address (= vault PDA). User sends SOL/tokens here.
   */
  getDepositAddress(userId: string): string | undefined {
    return this.data.users[userId]?.vault_pda;
  }

  /**
   * Reverse lookup: vault PDA → user_id (for harvest event routing)
   */
  getUserIdForVault(vaultPda: string): string | undefined {
    return this.data.vaultIndex[vaultPda];
  }

  /**
   * Reverse lookup: owner wallet → user_id
   * Also checks old pubkeyIndex for migration compatibility.
   */
  getUserIdForOwner(ownerPubkey: string): string | undefined {
    return this.data.ownerIndex[ownerPubkey]
      || (this.data as any).pubkeyIndex?.[ownerPubkey];
  }

  /**
   * Check if user is registered
   */
  isRegistered(userId: string): boolean {
    return !!this.data.users[userId];
  }

  /**
   * Get all registered users. Used by epoch-computer for Merkle tree.
   */
  getAllUsers(): UserRecord[] {
    return Object.values(this.data.users);
  }

  // ─── Withdraw Address ──────────────────────────────────────────────────
  // In PDA vault architecture, the withdraw address is the owner wallet
  // (baked into the PDA seed, immutable). These methods exist for
  // compatibility but just return the owner wallet.

  getWithdrawAddress(userId: string): string | undefined {
    return this.data.users[userId]?.owner_wallet;
  }

  // ─── Position Tracking ───────────────────────────────────────────────────

  savePosition(params: {
    positionPda: string;
    userId: string;
    vaultPda: string;
    lbPair: string;
    meteoraPosition: string;
    side: 'Buy' | 'Sell';
    minBinId: number;
    maxBinId: number;
    initialAmount: bigint;
    initialUsd?: number | null;
  }): void {
    this.data.positions[params.positionPda] = {
      position_pda: params.positionPda,
      user_id: params.userId,
      vault_pda: params.vaultPda,
      lb_pair: params.lbPair,
      meteora_position: params.meteoraPosition,
      side: params.side,
      min_bin_id: params.minBinId,
      max_bin_id: params.maxBinId,
      initial_amount: params.initialAmount.toString(),
      status: 'open',
      created_at: Date.now(),
      initial_usd: params.initialUsd ?? null,
    };
    this.markDirty();
  }

  /** Sum of `initial_usd` across positions opened within the window. */
  getTotalDepositedUsd(sinceMs: number = 0): number {
    let total = 0;
    for (const p of Object.values(this.data.positions)) {
      if (p.created_at < sinceMs) continue;
      if (p.initial_usd != null) total += p.initial_usd;
    }
    return total;
  }

  closePosition(positionPda: string): void {
    const pos = this.data.positions[positionPda];
    if (pos) {
      pos.status = 'closed';
      this.markDirty();
    }
  }

  getOpenPositions(userId: string): any[] {
    return Object.values(this.data.positions)
      .filter(p => p.user_id === userId && p.status === 'open')
      .sort((a, b) => b.created_at - a.created_at);
  }

  getPositionByPda(positionPda: string): any {
    return this.data.positions[positionPda] || null;
  }

  /**
   * Attach a JUP market-quote baseline to an open position. Called from /buy
   * and /sell right after the open tx confirms. Stored so that on 100%
   * conversion we can compute "delta vs market" as a shareable flex.
   */
  setPositionBaseline(
    positionPda: string,
    baselineOut: bigint,
    baselineMint: string,
    baselineDecimals: number,
  ): void {
    const pos = this.data.positions[positionPda];
    if (!pos) return;
    pos.baseline_out = baselineOut.toString();
    pos.baseline_mint = baselineMint;
    pos.baseline_decimals = baselineDecimals;
    this.markDirty();
  }

  /** Sum of actual converted output across all harvest rows for one position. */
  getActualHarvestedForPosition(positionPda: string): bigint {
    let total = 0n;
    for (const h of this.data.harvests) {
      if (h.position_pda === positionPda) total += BigInt(h.amount_out);
    }
    return total;
  }

  findPositionByIdPrefix(userId: string, prefix: string): any {
    const positions = this.getOpenPositions(userId);
    return positions.find(p => p.position_pda.startsWith(prefix));
  }

  // ─── Vote Storage ────────────────────────────────────────────────────────

  setVotes(vaultPda: string, allocations: Record<string, number>): void {
    const total = Object.values(allocations).reduce((sum, pct) => sum + pct, 0);
    if (Math.abs(total - 100) > 1) {
      throw new Error(`Vote allocations must sum to 100, got ${total}`);
    }

    // Remove old votes for this vault
    for (const key of Object.keys(this.data.votes)) {
      if (key.startsWith(vaultPda + ':')) {
        delete this.data.votes[key];
      }
    }

    const now = Date.now();
    for (const [pool, pct] of Object.entries(allocations)) {
      this.data.votes[`${vaultPda}:${pool}`] = {
        vault_pda: vaultPda,
        pool_address: pool,
        allocation_pct: pct,
        updated_at: now,
      };
    }
    this.markDirty();
  }

  getVotes(vaultPda: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const v of Object.values(this.data.votes)) {
      if (v.vault_pda === vaultPda) {
        result[v.pool_address] = v.allocation_pct;
      }
    }
    return result;
  }

  getAllVotes(): { vault_pda: string; pool_address: string; allocation_pct: number }[] {
    return Object.values(this.data.votes);
  }

  // ─── Harvest Tracking ────────────────────────────────────────────────────

  getHarvestedTotal(positionPda: string): bigint {
    let total = 0n;
    for (const h of this.data.harvests) {
      if (h.position_pda === positionPda) {
        total += BigInt(h.amount_out);
      }
    }
    return total;
  }

  saveHarvest(params: {
    positionPda: string;
    vaultPda: string;
    lbPair: string;
    amountOut: bigint;
    feeTaken: bigint;
    txSig: string;
    epoch?: number;
    slot?: number;
    usdValue?: number | null;
    kind?: 'harvest' | 'close';
  }): void {
    this.data.harvests.push({
      position_pda: params.positionPda,
      vault_pda: params.vaultPda,
      lb_pair: params.lbPair,
      amount_out: params.amountOut.toString(),
      fee_taken: params.feeTaken.toString(),
      tx_sig: params.txSig,
      epoch: params.epoch ?? 0,
      slot: params.slot ?? 0,
      created_at: Date.now(),
      usd_value: params.usdValue ?? null,
      kind: params.kind ?? 'harvest',
    });
    this.markDirty();
  }

  /** Sum of `usd_value` across all harvest rows (skips nulls). */
  getTotalVolumeUsd(sinceMs: number = 0): number {
    let total = 0;
    for (const h of this.data.harvests) {
      if (h.created_at < sinceMs) continue;
      if (h.usd_value != null) total += h.usd_value;
    }
    return total;
  }

  /** Sum of `usd_value` for a specific user's vault. */
  getUserVolumeUsd(vaultPda: string, sinceMs: number = 0): number {
    let total = 0;
    for (const h of this.data.harvests) {
      if (h.vault_pda !== vaultPda) continue;
      if (h.created_at < sinceMs) continue;
      if (h.usd_value != null) total += h.usd_value;
    }
    return total;
  }

  /** Distinct users with at least one harvest row. */
  getActiveUserCount(): number {
    const seen = new Set<string>();
    for (const h of this.data.harvests) seen.add(h.vault_pda);
    return seen.size;
  }

  getTotalRegisteredUsers(): number {
    return Object.keys(this.data.users).length;
  }

  getTotalHarvestCount(): number {
    return this.data.harvests.length;
  }

  getTotalOpenPositions(): number {
    let n = 0;
    for (const p of Object.values(this.data.positions)) {
      if (p.status === 'open') n++;
    }
    return n;
  }

  /**
   * Get total fees by vault PDA (for epoch-computer Merkle share computation)
   */
  getFeeTotalByVault(vaultPda: string): bigint {
    let total = 0n;
    for (const h of this.data.harvests) {
      if (h.vault_pda === vaultPda) {
        total += BigInt(h.fee_taken);
      }
    }
    return total;
  }

  // ─── Activity Queries (leaderboard) ─────────────────────────────────────

  /**
   * Aggregated per-user activity since `sinceMs`. Sorted by harvest volume desc.
   * Pass `lbPairFilter` to restrict to a set of pool addresses (e.g. all
   * CRANK/* pools for `/leaderboard CRANK`).
   */
  getLeaderboard(sinceMs: number, lbPairFilter?: Set<string>): Array<{
    userId: string;
    vaultPda: string;
    lastActiveMs: number;
    harvestCount: number;
    harvestVolume: bigint;
    openPositions: number;
  }> {
    const byVault = new Map<string, { count: number; volume: bigint; lastMs: number; open: number }>();
    const ensure = (vaultPda: string) =>
      byVault.get(vaultPda) ?? { count: 0, volume: 0n, lastMs: 0, open: 0 };

    for (const h of this.data.harvests) {
      if (h.created_at < sinceMs) continue;
      if (lbPairFilter && !lbPairFilter.has(h.lb_pair)) continue;
      const e = ensure(h.vault_pda);
      e.count += 1;
      e.volume += BigInt(h.amount_out);
      if (h.created_at > e.lastMs) e.lastMs = h.created_at;
      byVault.set(h.vault_pda, e);
    }
    for (const p of Object.values(this.data.positions)) {
      if (p.status !== 'open') continue;
      if (lbPairFilter && !lbPairFilter.has(p.lb_pair)) continue;
      const e = ensure(p.vault_pda);
      e.open += 1;
      if (p.created_at > e.lastMs) e.lastMs = p.created_at;
      byVault.set(p.vault_pda, e);
    }

    const results: Array<{ userId: string; vaultPda: string; lastActiveMs: number; harvestCount: number; harvestVolume: bigint; openPositions: number }> = [];
    for (const [vaultPda, s] of byVault) {
      const userId = this.data.vaultIndex[vaultPda];
      if (!userId) continue;
      results.push({ userId, vaultPda, lastActiveMs: s.lastMs, harvestCount: s.count, harvestVolume: s.volume, openPositions: s.open });
    }
    results.sort((a, b) => (b.harvestVolume > a.harvestVolume ? 1 : b.harvestVolume < a.harvestVolume ? -1 : 0));
    return results;
  }

  close(): void {
    this.flush();
    if (this.saveTimer) clearInterval(this.saveTimer);
  }

  // ─── Treasury-match Tracking (Path B) ──────────────────────────────────

  saveTreasuryPosition(rec: TreasuryPositionRecord): void {
    this.data.treasury_positions ??= {};
    this.data.treasury_by_user_position ??= {};
    this.data.treasury_positions[rec.treasury_position_pda] = rec;
    this.data.treasury_by_user_position[rec.user_position_pda] = rec.treasury_position_pda;
    // Cross-link the user position too, so /close can detect treasury match
    const userPos = this.data.positions[rec.user_position_pda];
    if (userPos) userPos.treasury_position_pda = rec.treasury_position_pda;
    this.markDirty();
  }

  getTreasuryPositionByUserPosition(userPositionPda: string): TreasuryPositionRecord | undefined {
    const tp = this.data.treasury_by_user_position?.[userPositionPda];
    if (!tp) return undefined;
    return this.data.treasury_positions?.[tp];
  }

  getTreasuryPosition(treasuryPositionPda: string): TreasuryPositionRecord | undefined {
    return this.data.treasury_positions?.[treasuryPositionPda];
  }

  listOpenTreasuryPositions(): TreasuryPositionRecord[] {
    return Object.values(this.data.treasury_positions ?? {})
      .filter(r => r.status === 'open')
      .sort((a, b) => b.opened_at - a.opened_at);
  }

  closeTreasuryPosition(
    treasuryPositionPda: string,
    closeProposalPda: string,
    proposerPayoutAmount: bigint,
  ): void {
    const rec = this.data.treasury_positions?.[treasuryPositionPda];
    if (!rec) return;
    rec.status = 'closed';
    rec.closed_at = Date.now();
    rec.close_proposal_pda = closeProposalPda;
    rec.proposer_payout_amount = proposerPayoutAmount.toString();
    this.markDirty();
  }

  // ─── Treasury Proposal Lifecycle ────────────────────────────────────────

  /**
   * Record or update a proposal's lifecycle state. The orchestrator calls this
   * at every state transition (pending → inserted → voted → executed / failed
   * / cancelled). Idempotent on payload_hash if proposal_pda is unknown yet.
   */
  recordProposalLifecycle(rec: Partial<OpenProposalRecord> & {
    proposal_pda: string;
    payload_hash: string;
    kind: ProposalKind;
    status: ProposalStatus;
  }): void {
    this.data.open_proposals ??= {};
    const now = Date.now();
    const existing = this.data.open_proposals[rec.proposal_pda];
    if (existing) {
      Object.assign(existing, rec, { updated_at: now });
    } else {
      this.data.open_proposals[rec.proposal_pda] = {
        proposal_pda: rec.proposal_pda,
        kind: rec.kind,
        status: rec.status,
        user_position_pda: rec.user_position_pda,
        treasury_position_pda: rec.treasury_position_pda,
        insert_tx_sig: rec.insert_tx_sig,
        execute_tx_sig: rec.execute_tx_sig,
        retry_count: rec.retry_count ?? 0,
        last_error: rec.last_error,
        created_at: rec.created_at ?? now,
        updated_at: now,
        payload_hash: rec.payload_hash,
      };
    }
    this.markDirty();
  }

  getProposal(proposalPda: string): OpenProposalRecord | undefined {
    return this.data.open_proposals?.[proposalPda];
  }

  /** Find any unfinished proposal matching a payload hash — replay-detection. */
  findProposalByPayloadHash(payloadHash: string): OpenProposalRecord | undefined {
    return Object.values(this.data.open_proposals ?? {}).find(p => p.payload_hash === payloadHash);
  }

  listProposalsByStatus(...statuses: ProposalStatus[]): OpenProposalRecord[] {
    return Object.values(this.data.open_proposals ?? {})
      .filter(p => statuses.includes(p.status))
      .sort((a, b) => a.created_at - b.created_at);
  }
}

// ─── Per-User Mutex ────────────────────────────────────────────────────────

const userLocks = new Map<string, Promise<void>>();

export async function withUserLock<T>(
  lockKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = userLocks.get(lockKey) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>(r => (resolve = r));
  userLocks.set(lockKey, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
  }
}
