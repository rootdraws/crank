/**
 * core-sdk/wallet-service.ts
 *
 * Custodial keypair management for CrankBot.
 * Platform-agnostic — works with Discord, Telegram, or any chat platform.
 *
 * Uses a JSON file store instead of SQLite to avoid native compilation deps.
 * Adequate for bot-scale usage (<10k users). Swap to SQLite on Linux for production.
 *
 * SECURITY REQUIREMENTS:
 * - WALLET_ENCRYPTION_KEY must be 32 bytes (64 hex chars), stored in secrets manager
 * - Never log the encryption key or raw secret keys
 * - In production: key should come from KMS, not env var directly
 * - The bidirectional lookup (owner_pubkey -> user_id) is CRITICAL
 *   for routing harvest notifications back to users
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

// ─── Encryption ────────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN  = 12;
const TAG_LEN = 16;

function getEncryptionKey(): Buffer {
  const raw = process.env.WALLET_ENCRYPTION_KEY;
  if (!raw) throw new Error('WALLET_ENCRYPTION_KEY not set');
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_LEN) {
    throw new Error(`WALLET_ENCRYPTION_KEY must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes)`);
  }
  return key;
}

function encrypt(plaintext: Buffer): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('hex');
}

function decrypt(ciphertext: string): Buffer {
  const key = getEncryptionKey();
  const data = Buffer.from(ciphertext, 'hex');
  const iv  = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// ─── JSON File Store ───────────────────────────────────────────────────────

interface StoreData {
  users: Record<string, { user_id: string; wallet_pubkey: string; encrypted_keypair: string; created_at: number; withdraw_address?: string }>;
  pubkeyIndex: Record<string, string>;
  positions: Record<string, {
    position_pda: string; user_id: string; wallet_pubkey: string;
    lb_pair: string; meteora_position: string; side: string;
    min_bin_id: number; max_bin_id: number; initial_amount: string;
    status: string; created_at: number;
  }>;
  votes: Record<string, { wallet_pubkey: string; pool_address: string; allocation_pct: number; updated_at: number }>;
  harvests: Array<{
    position_pda: string; wallet_pubkey: string; lb_pair: string;
    amount_out: string; fee_taken: string; tx_sig: string;
    epoch: number; slot: number; created_at: number;
  }>;
}

function emptyStore(): StoreData {
  return { users: {}, pubkeyIndex: {}, positions: {}, votes: {}, harvests: [] };
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
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(this.filePath)) {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!this.data.pubkeyIndex) this.data.pubkeyIndex = {};
      if (!this.data.harvests) this.data.harvests = [];
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
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  // ─── User / Keypair Management ───────────────────────────────────────────

  getOrCreate(userId: string): Keypair {
    const existing = this.data.users[userId];
    if (existing) {
      return this.decryptKeypair(existing.encrypted_keypair);
    }

    const keypair = Keypair.generate();
    const encryptedKeypair = this.encryptKeypair(keypair);
    const pubkey = keypair.publicKey.toBase58();

    this.data.users[userId] = {
      user_id: userId,
      wallet_pubkey: pubkey,
      encrypted_keypair: encryptedKeypair,
      created_at: Date.now(),
    };
    this.data.pubkeyIndex[pubkey] = userId;
    this.markDirty();

    return keypair;
  }

  getDepositAddress(userId: string): string {
    return this.getOrCreate(userId).publicKey.toBase58();
  }

  getUserIdForOwner(ownerPubkey: string): string | undefined {
    return this.data.pubkeyIndex[ownerPubkey];
  }

  getUserPublicKey(userId: string): PublicKey | undefined {
    const user = this.data.users[userId];
    return user ? new PublicKey(user.wallet_pubkey) : undefined;
  }

  // ─── Withdraw Address Lock ──────────────────────────────────────────────

  setWithdrawAddress(userId: string, address: string): { ok: boolean; error?: string } {
    const user = this.data.users[userId];
    if (!user) return { ok: false, error: 'no wallet found — run /start first' };
    if (user.withdraw_address) return { ok: false, error: 'withdraw address already set — cannot be changed' };
    user.withdraw_address = address;
    this.markDirty();
    return { ok: true };
  }

  getWithdrawAddress(userId: string): string | undefined {
    return this.data.users[userId]?.withdraw_address;
  }

  // ─── Position Tracking ───────────────────────────────────────────────────

  savePosition(params: {
    positionPda: string;
    userId: string;
    walletPubkey: string;
    lbPair: string;
    meteoraPosition: string;
    side: 'Buy' | 'Sell';
    minBinId: number;
    maxBinId: number;
    initialAmount: bigint;
  }): void {
    this.data.positions[params.positionPda] = {
      position_pda: params.positionPda,
      user_id: params.userId,
      wallet_pubkey: params.walletPubkey,
      lb_pair: params.lbPair,
      meteora_position: params.meteoraPosition,
      side: params.side,
      min_bin_id: params.minBinId,
      max_bin_id: params.maxBinId,
      initial_amount: params.initialAmount.toString(),
      status: 'open',
      created_at: Date.now(),
    };
    this.markDirty();
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

  findPositionByIdPrefix(userId: string, prefix: string): any {
    const positions = this.getOpenPositions(userId);
    return positions.find(p => p.position_pda.startsWith(prefix));
  }

  // ─── Vote Storage ────────────────────────────────────────────────────────

  setVotes(walletPubkey: string, allocations: Record<string, number>): void {
    const total = Object.values(allocations).reduce((sum, pct) => sum + pct, 0);
    if (Math.abs(total - 100) > 1) {
      throw new Error(`Vote allocations must sum to 100, got ${total}`);
    }

    // Remove old votes for this wallet
    for (const key of Object.keys(this.data.votes)) {
      if (key.startsWith(walletPubkey + ':')) {
        delete this.data.votes[key];
      }
    }

    const now = Date.now();
    for (const [pool, pct] of Object.entries(allocations)) {
      this.data.votes[`${walletPubkey}:${pool}`] = {
        wallet_pubkey: walletPubkey,
        pool_address: pool,
        allocation_pct: pct,
        updated_at: now,
      };
    }
    this.markDirty();
  }

  getVotes(walletPubkey: string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const v of Object.values(this.data.votes)) {
      if (v.wallet_pubkey === walletPubkey) {
        result[v.pool_address] = v.allocation_pct;
      }
    }
    return result;
  }

  getAllVotes(): { wallet_pubkey: string; pool_address: string; allocation_pct: number }[] {
    return Object.values(this.data.votes);
  }

  // ─── Harvest Tracking ────────────────────────────────────────────────────

  saveHarvest(params: {
    positionPda: string;
    walletPubkey: string;
    lbPair: string;
    amountOut: bigint;
    feeTaken: bigint;
    txSig: string;
    epoch?: number;
    slot?: number;
  }): void {
    this.data.harvests.push({
      position_pda: params.positionPda,
      wallet_pubkey: params.walletPubkey,
      lb_pair: params.lbPair,
      amount_out: params.amountOut.toString(),
      fee_taken: params.feeTaken.toString(),
      tx_sig: params.txSig,
      epoch: params.epoch ?? 0,
      slot: params.slot ?? 0,
      created_at: Date.now(),
    });
    this.markDirty();
  }

  // ─── Encryption Helpers ──────────────────────────────────────────────────

  private encryptKeypair(keypair: Keypair): string {
    return encrypt(Buffer.from(keypair.secretKey));
  }

  private decryptKeypair(encrypted: string): Keypair {
    const secretKey = decrypt(encrypted);
    return Keypair.fromSecretKey(secretKey);
  }

  close(): void {
    this.flush();
    if (this.saveTimer) clearInterval(this.saveTimer);
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
