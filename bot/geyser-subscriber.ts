/**
 * geyser-subscriber.ts
 *
 * Geyser/gRPC stream subscriber for crank.money harvest bot.
 * Replaces polling with event-driven monitoring.
 *
 * Optimized for Helius LaserStream gRPC (Yellowstone-compatible):
 *   - Auth via x-token extracted from endpoint URL query param
 *   - Built-in ping/pong for connection health (replaces DIY heartbeat)
 *   - CONFIRMED commitment level (1)
 *   - datasize filter on LbPair subscriptions (904 bytes)
 *
 * Subscribes to:
 *   - lb_pair accounts (active bin changes → trigger harvest checks)
 *   - Position PDAs (new/closed positions → update in-memory registry)
 *
 * Parses full LbPairInfo from raw account bytes — activeId, binStep
 * (sanity check), tokenXMint, tokenYMint, reserves, and token program
 * flags (token program resolution for V2 CPI). Pool metadata flows through
 * HarvestJob to the executor, eliminating redundant DLMM SDK calls.
 *
 * Reliability:
 *   - Auto-reconnect with exponential backoff
 *   - Ping/pong monitoring (stale stream detection)
 *   - Persistent position cache for fast restarts
 *   - Full position re-sync on reconnect
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

// ═══ TYPES ═══

export interface PositionInfo {
  positionPDA: string;
  owner: PublicKey;
  lbPair: PublicKey;
  meteoraPosition: PublicKey;
  side: 'Buy' | 'Sell';
  minBinId: number;
  maxBinId: number;
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

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const SAFETY_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PING_INTERVAL_MS = 10_000;       // Send ping every 10s
const PING_TIMEOUT_MS  = 30_000;       // Reconnect if no pong for 30s

// Persistent position cache to avoid full position.all() scan on restart
const CACHE_PATH = process.env.CACHE_PATH || './positions-cache.json';

// Skip dust positions below this bin width to mitigate griefing.
// Attacker creating thousands of 1-bin positions bloats registry and safety poll.
// Minimum 2 bins required for a position to be monitored (default).
const MIN_POSITION_BINS = parseInt(process.env.MIN_POSITION_BINS || '2');
// Validate parsed lamport values are within safe integer range
const MIN_POSITION_VALUE_LAMPORTS = (() => {
  const val = parseInt(process.env.MIN_POSITION_VALUE_LAMPORTS || '100000000');
  if (!Number.isSafeInteger(val)) { logger.warn(`MIN_POSITION_VALUE_LAMPORTS exceeds safe integer range: ${val}`); }
  return val;
})(); // 0.1 SOL default

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
  private stream: any = null;
  private connected = false;
  private reconnectAttempts = 0;
  // Track total reconnects for health endpoint
  private totalReconnects = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPongTime = 0;
  private pingId = 0;
  private shuttingDown = false;

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

      const initialAmount = (data.initialAmount as any)?.toNumber?.() ?? Number(data.initialAmount ?? 0);
      if (initialAmount > 0 && initialAmount < MIN_POSITION_VALUE_LAMPORTS) {
        skippedDust++;
        continue;
      }

      const info: PositionInfo = {
        positionPDA: pos.publicKey.toBase58(),
        owner: data.owner,
        lbPair: data.lbPair,
        meteoraPosition: data.meteoraPosition,
        side: data.side.buy ? 'Buy' : 'Sell',
        minBinId: data.minBinId,
        maxBinId: data.maxBinId,
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
        // If new pools appeared, reconnect to update gRPC subscription
        if (this.positionsByPool.size > poolCountBefore) {
          logger.info(`[geyser] New pool(s) detected — reconnecting to update subscription`);
          this.handleDisconnect();
        }
      }).catch(e =>
        logger.error(`[geyser] Registry rebuild failed: ${e.message}`)
      ).finally(() => {
        this.rebuildInFlight = false;
      });
    }
  }

  // ─── GRPC CONNECTION ───

  async connect(): Promise<void> {
    if (this.shuttingDown) return;

    try {
      // Strip query params (may contain API keys) before logging
      const safeEndpoint = this.grpcEndpoint.split('?')[0];
      logger.info(`[geyser] Connecting to gRPC: ${safeEndpoint}`);

      // Import Yellowstone gRPC client dynamically
      const { default: Client } = await import('@triton-one/yellowstone-grpc');

      // Helius LaserStream auth: API key via x-token metadata header.
      // The key is extracted from the endpoint URL query param if present,
      // or from GRPC_TOKEN env var.
      const url = new URL(this.grpcEndpoint);
      const token = url.searchParams.get('api-key')
        || url.searchParams.get('x-token')
        || process.env.GRPC_TOKEN
        || undefined;

      // Strip query params from endpoint URL for the gRPC client
      const cleanEndpoint = `${url.protocol}//${url.host}${url.pathname}`;

      const client = new Client(cleanEndpoint, token, undefined);
      await client.connect();
      this.stream = await client.subscribe();

      // ── Build subscription request ──

      // LbPair accounts: subscribe by specific address + datasize filter
      // to ensure we only receive LbPair updates (904 bytes), not other
      // Meteora account types that might share an address pattern.
      const lbPairFilters: Record<string, any> = {};
      for (const pool of this.getWatchedPools()) {
        lbPairFilters[`lb_${pool.slice(0, 8)}`] = {
          account: [pool],
          filters: [
            { datasize: LBPAIR_EXPECTED_SIZE },
          ],
        };
      }

      // Position PDAs: subscribe by program owner (all core program accounts)
      const positionFilter = {
        positions: {
          owner: [this.coreProgramId.toBase58()],
        },
      };

      const request = {
        accounts: {
          ...lbPairFilters,
          ...positionFilter,
        },
        slots: {},
        transactions: {},
        blocks: {},
        blocksMeta: {},
        // Note: accounts_data_slice applies globally. We can't slice differently
        // for LbPair vs Position PDAs, so we request full data for both.
        // Future optimization: dual connections with targeted slices.
        accountsDataSlice: [],
        // Helius LaserStream commitment: 1 = CONFIRMED
        commitment: 1,
        // Built-in ping for connection health (Helius LaserStream feature)
        ping: { id: ++this.pingId },
      };

      // Send subscription request
      await new Promise<void>((resolve, reject) => {
        this.stream.write(request, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // ── Handle incoming messages ──
      this.stream.on('data', (message: any) => {
        // Handle pong responses (Helius LaserStream ping/pong)
        if (message.pong) {
          this.lastPongTime = Date.now();
          return;
        }

        if (message.account) {
          const account = message.account;
          const pubkey = new PublicKey(account.account.pubkey).toBase58();
          const data = Buffer.from(account.account.data);

          // Route to appropriate handler
          if (this.positionsByPool.has(pubkey)) {
            // This is an lb_pair account update
            this.handleLbPairUpdate(pubkey, data);
          } else {
            // Could be a Position PDA
            this.handlePositionUpdate(pubkey, data);
          }
        }
      });

      this.stream.on('error', (err: any) => {
        logger.error(`[geyser] Stream error: ${err.message}`);
        this.handleDisconnect();
      });

      this.stream.on('end', () => {
        logger.info('[geyser] Stream ended');
        this.handleDisconnect();
      });

      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastPongTime = Date.now();
      this.startPingLoop();

      logger.info(`[geyser] Connected. Watching ${this.positionsByPool.size} pools, ${this.positions.size} positions`);
    } catch (e: any) {
      logger.error(`[geyser] Connection failed: ${e.message}`);
      throw e;
    }
  }

  private handleDisconnect(): void {
    if (this.shuttingDown) return;

    this.connected = false;
    this.stopPingLoop();

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY_MS
    );
    this.reconnectAttempts++;
    this.totalReconnects++;

    logger.info(`[geyser] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      if (this.shuttingDown) return;

      // Full re-sync on reconnect to catch anything missed
      // Check rebuildInFlight guard to prevent concurrent buildRegistry() calls.
      // Without this, handleDisconnect and handlePositionUpdate can race, with .clear() in one
      // wiping the other's in-progress results.
      try {
        if (!this.rebuildInFlight) {
          this.rebuildInFlight = true;
          try {
            await this.buildRegistry();
          } finally {
            this.rebuildInFlight = false;
          }
        } else {
          logger.info('[geyser] Registry rebuild already in progress — skipping reconnect rebuild');
        }
        await this.connect();
      } catch (e: any) {
        logger.error(`[geyser] Reconnect failed: ${e.message}`);
        this.handleDisconnect();
      }
    }, delay);
  }

  // ─── PING/PONG (Helius LaserStream) ───

  /**
   * Periodic ping loop using Helius LaserStream's built-in ping/pong.
   * Sends {"ping": {"id": N}} every PING_INTERVAL_MS.
   * If no pong received within PING_TIMEOUT_MS, reconnects.
   */
  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = setInterval(() => {
      if (!this.connected || !this.stream) return;

      // Check if last pong is stale
      const timeSincePong = Date.now() - this.lastPongTime;
      if (timeSincePong > PING_TIMEOUT_MS) {
        logger.warn(`[geyser] No pong for ${Math.round(timeSincePong / 1000)}s — reconnecting`);
        this.handleDisconnect();
        return;
      }

      // Send ping
      try {
        this.stream.write({ ping: { id: ++this.pingId } }, (err: any) => {
          if (err && this.connected) {
            logger.warn(`[geyser] Ping write failed: ${err.message}`);
          }
        });
      } catch {
        // Stream may be closed, disconnect handler will fire
      }
    }, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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

  async start(): Promise<void> {
    // Try loading from cache first for faster startup, then full sync
    const cached = this.loadCache();
    if (cached) {
      logger.info('[geyser] Starting with cached registry, will sync in background...');
    } else {
      await this.buildRegistry();
    }

    // Retry initial gRPC connection instead of crashing on transient failure.
    // Post-connect disconnects already use handleDisconnect() with exponential backoff.
    let attempts = 0;
    while (!this.connected && !this.shuttingDown) {
      try {
        await this.connect();
      } catch (e: any) {
        attempts++;
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, attempts),
          RECONNECT_MAX_DELAY_MS
        );
        logger.warn(`[geyser] Initial connect failed (attempt ${attempts}): ${e.message} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    if (cached) {
      // Delta sync in background: rebuild full registry and save updated cache
      this.buildRegistry().catch(e =>
        logger.error(`[geyser] Background registry sync failed: ${e.message}`)
      );
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopPingLoop();

    if (this.safetyPollTimer) {
      clearInterval(this.safetyPollTimer);
      this.safetyPollTimer = null;
    }

    if (this.stream) {
      try { this.stream.cancel(); } catch (_) {}
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
