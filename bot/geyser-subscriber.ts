/**
 * geyser-subscriber.ts
 *
 * Geyser/gRPC stream subscriber for crank.money harvest bot.
 * Replaces polling with event-driven monitoring.
 *
 * Targets Alchemy Yellowstone gRPC (@triton-one/yellowstone-grpc client):
 *   - Auth via x-token header on the gRPC channel (token from GRPC_TOKEN env)
 *   - Server-initiated Ping → reply with ping in SubscribeRequest (else server drops us)
 *   - Replay on reconnect via fromSlot (caller-tracked latestSlot, −32 slot reorg buffer)
 *   - CONFIRMED commitment level
 *   - Caller-managed exponential reconnect backoff (100ms → 60s)
 *
 * Subscribes to:
 *   - lb_pair accounts (active bin changes → trigger harvest checks)
 *   - Position PDAs (new/closed positions → update in-memory registry)
 *
 * Parses full LbPairInfo from raw account bytes — activeId, binStep
 * (sanity check), tokenXMint, tokenYMint, reserves, and token program
 * flags (token program resolution for V2 CPI). Pool metadata flows through
 * HarvestJob to the executor, eliminating redundant DLMM SDK calls.
 */

import {
  Connection,
  PublicKey,
  Commitment,
} from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { logger } from './logger';
import { getDLMM } from './meteora-accounts';

// ═══ TYPES ═══

export interface PositionInfo {
  positionPDA: string;
  owner: PublicKey;
  lbPair: PublicKey;
  meteoraPosition: PublicKey;
  side: 'Buy' | 'Sell';
  minBinId: number;
  maxBinId: number;
  initialAmount?: bigint;
  harvestedAmount?: bigint;
}

export interface ActiveBinChangedEvent {
  lbPair: string;
  newActiveId: number;
  previousActiveId: number | null;
}

export interface PositionChangedEvent {
  positionPDA: string;
  action: 'created' | 'closed';
  position?: PositionInfo;
}

export interface HarvestJob {
  positionPDA: string;
  lbPair: PublicKey;
  meteoraPosition: PublicKey;
  owner: PublicKey;
  side: 'Buy' | 'Sell';
  safeBinIds: number[];
  /** Pool metadata parsed from gRPC raw bytes (available when triggered by stream) */
  poolInfo?: LbPairInfo;
}

// ═══ LB_PAIR RAW BYTE PARSING ═══

/**
 * Parsed LbPair account data from raw gRPC bytes.
 *
 * Verified against Meteora DLMM IDL (LbPair struct) and 3 live mainnet pools.
 * LbPair account size: 904 bytes.
 *
 * Full layout (offsets from IDL):
 *   8   discriminator
 *   8   StaticParameters  (32 bytes)
 *   40  VariableParameters (32 bytes)
 *   72  bump_seed          (1 byte)
 *   73  bin_step_seed      (2 bytes)
 *   75  pair_type          (1 byte)
 *   76  active_id          (i32)   ← primary field
 *   80  bin_step           (u16)   ← sanity check
 *   82  status             (u8)
 *   88  token_x_mint       (32 bytes pubkey)
 *   120 token_y_mint       (32 bytes pubkey)
 *   152 reserve_x          (32 bytes pubkey)
 *   184 reserve_y          (32 bytes pubkey)
 *   880 token_mint_x_program_flag (u8)  ← 0 = SPL Token, 1 = Token-2022
 *   881 token_mint_y_program_flag (u8)
 */

export interface LbPairInfo {
  activeId: number;
  binStep: number;
  status: number;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  /** 0 = standard SPL Token, 1 = Token-2022 */
  tokenXProgramFlag: number;
  /** 0 = standard SPL Token, 1 = Token-2022 */
  tokenYProgramFlag: number;
}

// Anchor discriminator for bin-farm Position account: sha256('account:Position')[0..8]
const BIN_FARM_POSITION_DISCRIMINATOR = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);

// Byte offsets — verified from Meteora DLMM IDL + 3 live mainnet LbPair accounts
const LBPAIR_EXPECTED_SIZE       = 904;
const OFFSET_ACTIVE_ID           = 76;   // i32
const OFFSET_BIN_STEP            = 80;   // u16
const OFFSET_STATUS              = 82;   // u8
const OFFSET_TOKEN_X_MINT        = 88;   // pubkey (32)
const OFFSET_TOKEN_Y_MINT        = 120;  // pubkey (32)
const OFFSET_RESERVE_X           = 152;  // pubkey (32)
const OFFSET_RESERVE_Y           = 184;  // pubkey (32)
const OFFSET_TOKEN_X_PROG_FLAG   = 880;  // u8
const OFFSET_TOKEN_Y_PROG_FLAG   = 881;  // u8

/**
 * Parse all useful fields from raw LbPair account data.
 * Includes a binStep sanity check — if binStep is 0 or > 500,
 * the data is likely corrupt or the offsets are wrong.
 */
export function parseLbPairData(data: Buffer): LbPairInfo {
  if (data.length < LBPAIR_EXPECTED_SIZE) {
    throw new Error(`lb_pair data too short: ${data.length} bytes (expected ${LBPAIR_EXPECTED_SIZE})`);
  }

  const activeId = data.readInt32LE(OFFSET_ACTIVE_ID);
  const binStep  = data.readUInt16LE(OFFSET_BIN_STEP);

  // Sanity check: Meteora bin steps are typically 1-500
  if (binStep === 0 || binStep > 500) {
    throw new Error(`lb_pair binStep=${binStep} is invalid (expected 1-500) — possible offset error`);
  }

  return {
    activeId,
    binStep,
    status:            data.readUInt8(OFFSET_STATUS),
    tokenXMint:        new PublicKey(data.slice(OFFSET_TOKEN_X_MINT, OFFSET_TOKEN_X_MINT + 32)),
    tokenYMint:        new PublicKey(data.slice(OFFSET_TOKEN_Y_MINT, OFFSET_TOKEN_Y_MINT + 32)),
    reserveX:          new PublicKey(data.slice(OFFSET_RESERVE_X, OFFSET_RESERVE_X + 32)),
    reserveY:          new PublicKey(data.slice(OFFSET_RESERVE_Y, OFFSET_RESERVE_Y + 32)),
    tokenXProgramFlag: data.readUInt8(OFFSET_TOKEN_X_PROG_FLAG),
    tokenYProgramFlag: data.readUInt8(OFFSET_TOKEN_Y_PROG_FLAG),
  };
}

/** Backward-compat wrapper — returns just activeId */
export function parseActiveId(data: Buffer): number {
  return parseLbPairData(data).activeId;
}

// ═══ SUBSCRIBER ═══

// ═══ STREAM CONFIG ═══

const SAFETY_POLL_INTERVAL_MS = 5 * 1000; // 5 seconds

// Persistent position cache to avoid full position.all() scan on restart
const CACHE_PATH = process.env.CACHE_PATH || './positions-cache.json';

// Skip dust positions below this bin width to mitigate griefing.
const MIN_POSITION_BINS = parseInt(process.env.MIN_POSITION_BINS || '1');

export class GeyserSubscriber extends EventEmitter {
  private connection: Connection;
  private coreProgram: Program;
  private grpcEndpoint: string;
  private coreProgramId: PublicKey;

  // In-memory position registry
  private positions: Map<string, PositionInfo> = new Map();
  // Positions grouped by lbPair for fast lookup on price changes
  private positionsByPool: Map<string, Set<string>> = new Map();
  // Last known activeId per lb_pair
  private activeIds: Map<string, number> = new Map();
  // Pool metadata parsed from raw gRPC bytes (mints, reserves, token program flags)
  private poolInfo: Map<string, LbPairInfo> = new Map();

  // Stream management
  private connected = false;
  private totalReconnects = 0;
  private shuttingDown = false;
  // Latest slot observed on the stream — used to set fromSlot on resubscribe so we
  // replay anything missed during a disconnect. Cleared back to 0 only on shutdown.
  private latestSlot = 0;
  // Held so the data handler can write Pong replies and shutdown can close cleanly.
  private stream: any = null;
  // Exponential backoff for reconnect: 100ms → 60s, doubles per failed attempt,
  // resets to 100ms once subscribe succeeds.
  private reconnectDelayMs = 100;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Safety-net polling
  private safetyPollTimer: NodeJS.Timeout | null = null;
  // In-flight guard to prevent concurrent registry rebuilds
  private rebuildInFlight = false;

  constructor(
    connection: Connection,
    coreProgram: Program,
    coreProgramId: PublicKey,
    grpcEndpoint: string,
  ) {
    super();
    this.connection = connection;
    this.coreProgram = coreProgram;
    this.coreProgramId = coreProgramId;
    this.grpcEndpoint = grpcEndpoint;
  }

  // ─── POSITION REGISTRY ───

  async buildRegistry(): Promise<void> {
    logger.info('[geyser] Building position registry...');
    const positions = await this.coreProgram.account.position.all();

    this.positions.clear();
    this.positionsByPool.clear();

    let skippedDust = 0;
    for (const pos of positions) {
      const data = pos.account as any;
      const binWidth = (data.maxBinId as number) - (data.minBinId as number) + 1;

      // Skip dust positions to mitigate griefing
      if (binWidth < MIN_POSITION_BINS) {
        skippedDust++;
        continue;
      }

      const info: PositionInfo = {
        positionPDA: pos.publicKey.toBase58(),
        owner: data.userVault ?? data.owner, // userVault (v2 IDL) or owner (legacy)
        lbPair: data.lbPair,
        meteoraPosition: data.meteoraPosition,
        side: data.side.buy ? 'Buy' : 'Sell',
        minBinId: data.minBinId,
        maxBinId: data.maxBinId,
        initialAmount: data.initialAmount ? BigInt(data.initialAmount.toString()) : undefined,
        harvestedAmount: data.harvestedAmount ? BigInt(data.harvestedAmount.toString()) : undefined,
      };
      this.addPosition(info);
    }
    if (skippedDust > 0) {
      logger.info(`[geyser] Skipped ${skippedDust} dust positions (< ${MIN_POSITION_BINS} bins)`);
    }

    logger.info(`[geyser] Registry built: ${this.positions.size} positions across ${this.positionsByPool.size} pools`);

    // Persist registry to disk for faster restarts
    this.saveCache();
  }

  private saveCache(): void {
    try {
      const entries = [...this.positions.values()].map(p => ({
        positionPDA: p.positionPDA,
        owner: p.owner.toBase58(),
        lbPair: p.lbPair.toBase58(),
        meteoraPosition: p.meteoraPosition.toBase58(),
        side: p.side,
        minBinId: p.minBinId,
        maxBinId: p.maxBinId,
        initialAmount: p.initialAmount !== undefined ? p.initialAmount.toString() : undefined,
        harvestedAmount: p.harvestedAmount !== undefined ? p.harvestedAmount.toString() : undefined,
      }));
      // Restrict cache file to owner-only read/write
      fs.writeFileSync(CACHE_PATH, JSON.stringify(entries, null, 2), { mode: 0o600 });
      logger.info(`[geyser] Cache saved: ${entries.length} positions → ${CACHE_PATH}`);
    } catch (e: any) {
      logger.warn(`[geyser] Failed to save cache: ${e.message}`);
    }
  }

  private loadCache(): boolean {
    try {
      if (!fs.existsSync(CACHE_PATH)) return false;
      const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
      const entries = JSON.parse(raw) as Array<{
        positionPDA: string;
        owner: string;
        lbPair: string;
        meteoraPosition: string;
        side: 'Buy' | 'Sell';
        minBinId: number;
        maxBinId: number;
        initialAmount?: string;
        harvestedAmount?: string;
      }>;

      this.positions.clear();
      this.positionsByPool.clear();

      for (const e of entries) {
        this.addPosition({
          positionPDA: e.positionPDA,
          owner: new PublicKey(e.owner),
          lbPair: new PublicKey(e.lbPair),
          meteoraPosition: new PublicKey(e.meteoraPosition),
          side: e.side,
          minBinId: e.minBinId,
          maxBinId: e.maxBinId,
          initialAmount: e.initialAmount ? BigInt(e.initialAmount) : undefined,
          harvestedAmount: e.harvestedAmount ? BigInt(e.harvestedAmount) : undefined,
        });
      }

      logger.info(`[geyser] Cache loaded: ${this.positions.size} positions from ${CACHE_PATH}`);
      return true;
    } catch (e: any) {
      logger.warn(`[geyser] Failed to load cache: ${e.message}`);
      return false;
    }
  }

  private addPosition(info: PositionInfo): void {
    this.positions.set(info.positionPDA, info);

    const poolKey = info.lbPair.toBase58();
    if (!this.positionsByPool.has(poolKey)) {
      this.positionsByPool.set(poolKey, new Set());
    }
    this.positionsByPool.get(poolKey)!.add(info.positionPDA);
  }

  private removePosition(positionPDA: string): void {
    const info = this.positions.get(positionPDA);
    if (!info) return;

    this.positions.delete(positionPDA);

    const poolKey = info.lbPair.toBase58();
    const poolPositions = this.positionsByPool.get(poolKey);
    if (poolPositions) {
      poolPositions.delete(positionPDA);
      if (poolPositions.size === 0) {
        this.positionsByPool.delete(poolKey);
        // Prune dead pool from live gRPC subscription
        this.updateSubscription();
        logger.info(`[geyser] Pool ${poolKey.slice(0, 8)} has no open positions — pruned from subscription`);
      }
    }
  }

  getPositionsForPool(lbPair: string): PositionInfo[] {
    const pdas = this.positionsByPool.get(lbPair);
    if (!pdas) return [];
    return [...pdas]
      .map(pda => this.positions.get(pda))
      .filter((p): p is PositionInfo => p !== undefined);
  }

  getWatchedPools(): string[] {
    return [...this.positionsByPool.keys()];
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  getPositionsForWallet(wallet: string): PositionInfo[] {
    const results: PositionInfo[] = [];
    for (const pos of this.positions.values()) {
      if (pos.owner.toBase58() === wallet) results.push(pos);
    }
    return results;
  }

  /** Get parsed pool metadata (mints, reserves, token program flags) from last gRPC update */
  getPoolInfo(lbPair: string): LbPairInfo | undefined {
    return this.poolInfo.get(lbPair);
  }

  // ─── ACTIVE BIN CHANGE HANDLING ───

  /**
   * Called when an lb_pair account update arrives via gRPC stream.
   * Parses the new activeId, compares against cached value,
   * and emits harvest jobs for affected positions.
   */
  handleLbPairUpdate(lbPairKey: string, data: Buffer): void {
    let info: LbPairInfo;
    try {
      info = parseLbPairData(data);
    } catch (e: any) {
      logger.warn(`[geyser] Failed to parse LbPair for ${lbPairKey.slice(0, 8)}: ${e.message}`);
      return;
    }

    // Store full pool metadata (mints, reserves, token program flags)
    this.poolInfo.set(lbPairKey, info);

    const previousActiveId = this.activeIds.get(lbPairKey) ?? null;

    // NOTE: No activeId jump filtering. Meme tokens on thin liquidity can move
    // 20%+ on a single trade — that's a real fill, not manipulation. The on-chain
    // program is the source of truth: if bins aren't actually converted when the
    // harvest tx lands, removeLiquidity returns zero and nothing happens. Worst
    // case is a wasted tx fee (a few thousand lamports). Flash loans unwind within
    // the same slot — the bot always submits to a future slot, so it reacts to
    // settled state, never mid-transaction snapshots.

    this.activeIds.set(lbPairKey, info.activeId);

    // Skip if activeId hasn't changed
    if (previousActiveId !== null && previousActiveId === info.activeId) {
      return;
    }

    logger.info({ pool: lbPairKey.slice(0, 8), from: previousActiveId, to: info.activeId }, '[geyser] activeId changed');

    this.emit('activeBinChanged', {
      lbPair: lbPairKey,
      newActiveId: info.activeId,
      previousActiveId,
    } as ActiveBinChangedEvent);

    // Check all positions on this pool for harvestable bins
    const positions = this.getPositionsForPool(lbPairKey);
    for (const pos of positions) {
      const safeBins = this.getSafeWithdrawBins(pos, info.activeId);
      if (safeBins.length > 0) {
        this.emit('harvestNeeded', {
          positionPDA: pos.positionPDA,
          lbPair: pos.lbPair,
          meteoraPosition: pos.meteoraPosition,
          owner: pos.owner,
          side: pos.side,
          safeBinIds: safeBins,
          poolInfo: info,
        } as HarvestJob);
      }
    }
  }

  /**
   * Determine which bins are safe to harvest based on price movement.
   * Same logic as the original bot's getSafeWithdrawBins.
   *
   * SELL: harvest bins below activeId (fully converted X→Y)
   * BUY: harvest bins above activeId (fully converted Y→X)
   */
  private getSafeWithdrawBins(pos: PositionInfo, activeId: number): number[] {
    const safeBins: number[] = [];

    for (let binId = pos.minBinId; binId <= pos.maxBinId; binId++) {
      if (pos.side === 'Sell' && binId < activeId) {
        safeBins.push(binId);
      } else if (pos.side === 'Buy' && binId > activeId) {
        safeBins.push(binId);
      }
    }

    return safeBins;
  }

  // ─── POSITION PDA CHANGE HANDLING ───

  /** Check if raw account data has the bin-farm Position discriminator. */
  private isBinFarmPosition(data: Buffer): boolean {
    return data.length >= 8 && data.subarray(0, 8).equals(BIN_FARM_POSITION_DISCRIMINATOR);
  }

  handlePositionUpdate(positionPDA: string, data: Buffer | null): void {
    if (data === null || data.length === 0) {
      // Position closed / account deleted
      const closedPos = this.positions.get(positionPDA);
      if (closedPos) {
        this.removePosition(positionPDA);
        this.emit('positionChanged', {
          positionPDA,
          action: 'closed',
          position: closedPos,
        } as PositionChangedEvent);
        logger.info(`[geyser] Position removed: ${positionPDA.slice(0, 8)}`);
      }
      return;
    }

    // Position created or updated
    if (!this.positions.has(positionPDA)) {
      // New position — parse account data
      // Note: In production, deserialize using the core program's IDL
      // For now, trigger a registry rebuild to pick up the new position
      logger.info(`[geyser] New position detected: ${positionPDA.slice(0, 8)} — rebuilding registry`);
      // In-flight guard prevents concurrent rebuilds from racing.
      // Multiple positions created in the same slot would trigger multiple concurrent
      // buildRegistry() calls; .clear() in one rebuild could wipe another's results.
      if (this.rebuildInFlight) {
        logger.info(`[geyser] Registry rebuild already in progress — skipping`);
        return;
      }
      this.rebuildInFlight = true;
      const poolCountBefore = this.positionsByPool.size;
      this.buildRegistry().then(() => {
        // Emit created event if position now exists after rebuild
        const newPos = this.positions.get(positionPDA);
        if (newPos) {
          this.emit('positionChanged', {
            positionPDA,
            action: 'created',
            position: newPos,
          } as PositionChangedEvent);
        }
        // If new pools appeared, update subscription live — no reconnect needed
        if (this.positionsByPool.size > poolCountBefore) {
          logger.info(`[geyser] New pool(s) detected — updating subscription live`);
          this.updateSubscription();
        }
      }).catch(e =>
        logger.error(`[geyser] Registry rebuild failed: ${e.message}`)
      ).finally(() => {
        this.rebuildInFlight = false;
      });
    }
  }

  // ─── GRPC CONNECTION ───

  /**
   * Connect to Alchemy Yellowstone gRPC via @triton-one/yellowstone-grpc.
   *
   * Reconnect, replay (fromSlot), and Ping reply are all caller-managed —
   * the Triton client is a thin wrapper around a gRPC duplex, unlike the
   * Helius SDK which handled these internally.
   */
  async connect(): Promise<void> {
    if (this.shuttingDown) return;

    const { default: Client, CommitmentLevel } = await import('@triton-one/yellowstone-grpc');

    // Endpoint: plain "host:port" (no scheme) OR "https://host:port" — Triton accepts both.
    // Token: x-token. Prefer GRPC_TOKEN env. Fall back to ?x-token=... in the URL only
    // for backwards-compat with the old Helius-style env value during cutover.
    let endpoint = this.grpcEndpoint;
    let token = process.env.GRPC_TOKEN || '';
    if (!token && endpoint.includes('?')) {
      const url = new URL(endpoint.startsWith('http') ? endpoint : `https://${endpoint}`);
      token = url.searchParams.get('x-token') || url.searchParams.get('api-key') || '';
      endpoint = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
    }

    const client = new Client(endpoint, token, undefined);
    // Triton 5.x: connect() establishes the native gRPC client; subscribe() needs it.
    await client.connect();
    const stream = await client.subscribe();
    this.stream = stream;

    // Watch specific LbPair accounts + all bin-farm program accounts
    const accountAddresses = [...this.getWatchedPools()];
    const lbPairFilters: Record<string, any> = {};
    for (const pool of accountAddresses) {
      lbPairFilters[`lb_${pool}`] = { account: [pool], owner: [], filters: [] };
    }
    // Owner-program filters are rejected by Alchemy ("Unsupported plan type").
    // Position discovery + close detection runs through the 5s safety poll
    // (program.account.position.all() via RPC); gRPC only carries fast LbPair
    // active-bin updates.
    const request: any = {
      accounts: {
        ...lbPairFilters,
      },
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
    };
    if (this.latestSlot > 0) {
      // −32 slots buffers reorgs (Alchemy best-practice guidance).
      request.fromSlot = String(Math.max(0, this.latestSlot - 32));
    }

    const safeEndpoint = endpoint.split('?')[0];
    logger.info(`[geyser] Connecting to Yellowstone gRPC: ${safeEndpoint}`);
    logger.info(`[geyser] x-token present: ${token.length > 0}, length: ${token.length}`);
    logger.info(`[geyser] Subscribing: ${accountAddresses.length} pools, owner=${this.coreProgramId.toBase58().slice(0, 8)}, fromSlot=${request.fromSlot ?? 'none'}`);

    let firstMessage = true;
    stream.on('data', (update: any) => {
      // Track latest slot from any update that carries one — used as fromSlot on
      // the next resubscribe to replay anything we missed during a disconnect.
      const slot = update.account?.slot ?? update.slot?.slot;
      if (slot) {
        const s = typeof slot === 'string' ? Number(slot) : slot;
        if (s > this.latestSlot) this.latestSlot = s;
      }

      // Server-initiated Ping. Must reply with a SubscribeRequest carrying ping or the
      // server drops the connection (Alchemy/Yellowstone heartbeat protocol).
      if (update.ping) {
        try {
          stream.write({
            accounts: {}, slots: {}, transactions: {}, transactionsStatus: {},
            blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
            ping: { id: 1 },
          });
        } catch (e: any) {
          logger.warn(`[geyser] Pong write failed: ${e.message}`);
        }
        return;
      }

      if (firstMessage) {
        firstMessage = false;
        logger.info(`[geyser] First message received — stream delivering data`);
      }

      try {
        // SubscribeUpdate → .account (SubscribeUpdateAccount) → .account (SubscribeUpdateAccountInfo)
        const info = update.account?.account;
        if (!info?.pubkey || !info?.data) return;

        const pubkey = new PublicKey(info.pubkey).toBase58();
        const data = Buffer.from(info.data);

        if (this.positionsByPool.has(pubkey)) {
          this.handleLbPairUpdate(pubkey, data);
        } else if (this.isBinFarmPosition(data)) {
          this.handlePositionUpdate(pubkey, data);
        }
      } catch (e: any) {
        logger.warn(`[geyser] Failed to parse stream message: ${e.message}`);
      }
    });

    let terminalFired = false;
    const onTerminal = (label: string, err?: any) => {
      if (terminalFired) return;
      terminalFired = true;
      // If updateSubscription() already swapped in a new stream, ignore — that path
      // schedules its own connect.
      if (this.stream !== stream) return;
      if (this.shuttingDown) return;
      const msg = err?.message ?? err ?? label;
      logger.error(`[geyser] Stream ${label}: ${msg}`);
      this.connected = false;
      this.totalReconnects++;
      this.stream = null;
      this.emit('disconnected');
      this.scheduleReconnect();
    };
    stream.on('error', (err: any) => onTerminal('error', err));
    stream.on('end', () => onTerminal('end'));
    stream.on('close', () => onTerminal('close'));

    // Send the subscription request to begin streaming.
    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err: any) => err ? reject(err) : resolve());
    });

    this.connected = true;
    this.reconnectDelayMs = 100; // reset backoff on successful subscribe
    logger.info(`[geyser] Connected. Watching ${this.positionsByPool.size} pools, ${this.positions.size} positions`);
  }

  /**
   * Schedule a reconnect after exponential backoff. 100ms → 60s, doubles each failure,
   * resets to 100ms inside connect() once the subscribe write succeeds.
   */
  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    logger.info(`[geyser] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(e => {
        logger.error(`[geyser] Reconnect attempt failed: ${e.message}`);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
  }

  /**
   * On registry changes that add/remove pools, reconnect to refresh the subscription.
   * Yellowstone allows updating an active subscription via stream.write(newRequest),
   * but reconnect is simpler and the pool set changes infrequently.
   */
  private updateSubscription(): void {
    logger.info('[geyser] Pool set changed — reconnecting to update subscription');
    if (this.stream) {
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
    }
    this.connected = false;
    this.connect().catch(e => logger.error(`[geyser] Reconnect failed: ${e.message}`));
  }

  // ─── SAFETY-NET POLLING ───

  /**
   * Belt-and-suspenders: slow-cadence poll every 5 minutes
   * to catch anything the gRPC stream might have missed.
   */
  startSafetyPolling(pollFn: () => Promise<void>): void {
    this.safetyPollTimer = setInterval(async () => {
      if (this.shuttingDown) return;
      try {
        await pollFn();
      } catch (e: any) {
        logger.error(`[geyser] Safety poll error: ${e.message}`);
      }
    }, SAFETY_POLL_INTERVAL_MS);
  }

  // ─── LIFECYCLE ───

  /**
   * Validate hardcoded byte offsets against a live pool parsed by the DLMM SDK.
   * Runs once at startup. If offsets have drifted (Meteora upgrade), log a
   * critical warning — the bot will still start but operator should investigate.
   */
  private async validateByteOffsets(): Promise<void> {
    const poolKeys = [...this.positionsByPool.keys()];
    if (poolKeys.length === 0) return;

    const testPool = poolKeys[0];
    try {
      // Use shared DLMM helper (static import at top of file) — dynamic import
      // of @meteora-ag/dlmm was failing with an ESM interop error on `BN`
      // re-exports at runtime.
      const dlmm = await getDLMM(this.connection, new PublicKey(testPool));
      const sdkActiveId = dlmm.lbPair.activeId;
      const sdkBinStep = dlmm.lbPair.binStep;
      const sdkTokenXMint = dlmm.lbPair.tokenXMint.toBase58();
      const sdkTokenYMint = dlmm.lbPair.tokenYMint.toBase58();

      const accountInfo = await this.connection.getAccountInfo(new PublicKey(testPool));
      if (!accountInfo) return;
      const parsed = parseLbPairData(accountInfo.data as Buffer);

      const mismatches: string[] = [];
      if (parsed.activeId !== sdkActiveId) mismatches.push(`activeId: byte=${parsed.activeId} sdk=${sdkActiveId}`);
      if (parsed.binStep !== sdkBinStep) mismatches.push(`binStep: byte=${parsed.binStep} sdk=${sdkBinStep}`);
      if (parsed.tokenXMint.toBase58() !== sdkTokenXMint) mismatches.push(`tokenXMint mismatch`);
      if (parsed.tokenYMint.toBase58() !== sdkTokenYMint) mismatches.push(`tokenYMint mismatch`);

      if (mismatches.length > 0) {
        logger.error(`[geyser] BYTE OFFSET MISMATCH on ${testPool.slice(0, 8)}: ${mismatches.join(', ')}. Meteora layout may have changed!`);
      } else {
        logger.info(`[geyser] Byte offset validation passed (pool ${testPool.slice(0, 8)}, activeId=${sdkActiveId}, binStep=${sdkBinStep})`);
      }
    } catch (e: any) {
      logger.warn(`[geyser] Byte offset validation skipped: ${e.message?.slice(0, 80)}`);
    }
  }

  async start(): Promise<void> {
    // Try loading from cache first for faster startup, then full sync
    const cached = this.loadCache();
    if (cached) {
      logger.info('[geyser] Starting with cached registry, will sync in background...');
    } else {
      await this.buildRegistry();
    }

    // Validate hardcoded byte offsets against SDK on first startup
    await this.validateByteOffsets();

    await this.connect();

    if (cached) {
      // Delta sync in background: rebuild full registry and save updated cache
      this.buildRegistry().catch(e =>
        logger.error(`[geyser] Background registry sync failed: ${e.message}`)
      );
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.safetyPollTimer) {
      clearInterval(this.safetyPollTimer);
      this.safetyPollTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.stream) {
      try { this.stream.end(); } catch { /* ignore */ }
      this.stream = null;
    }

    this.connected = false;
    logger.info('[geyser] Subscriber shut down');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Expose reconnect count for health endpoint
  getReconnectCount(): number {
    return this.totalReconnects;
  }
}
