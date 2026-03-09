/**
 * relay-server.ts
 *
 * WebSocket + REST relay for crank.money frontend.
 * Exposes the bot's LaserStream-powered in-memory state to the browser.
 *
 * Plugs into the existing HTTP health server (anchor-harvest-bot.ts).
 * No new ports — extends the same :8080 server with:
 *   - WebSocket upgrade at /ws
 *   - REST endpoints at /api/*
 *
 * All data is read-only from the bot's perspective — the relay never
 * modifies subscriber, executor, or keeper state.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { Connection, PublicKey } from '@solana/web3.js';
import WebSocket from 'ws';
const WebSocketServer = WebSocket.Server;
import type { Server as HttpServer } from 'http';
import type { GeyserSubscriber, ActiveBinChangedEvent, HarvestJob, PositionChangedEvent } from './geyser-subscriber';
import type { HarvestExecutor } from './harvest-executor';
import type { MonkeKeeper } from './keeper';
import { getDLMM } from './meteora-accounts';
import { logger } from './logger';
import type { AddressBookStore } from './anchor-harvest-bot';

// ═══ TYPES ═══

/** Event broadcast to all connected WebSocket clients */
interface RelayEvent {
  type: string;
  data: any;
  timestamp: number;
}

/** Rover TVL entry for the Recon leaderboard */
export interface RoverTvlEntry {
  pool: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tvl: number;
  positionCount: number;
  status: 'active' | 'converting' | 'exhausted';
  /** Top-5 only: enriched analytics */
  analytics?: {
    priceChangesPerHour: number;
    conversionProgress: number;
    estimatedTtcHours: number;
    solGenerated: number;
  };
}

// ═══ RELAY SERVER ═══

/** Fee pipeline state returned by the /api/fees endpoint */
export interface FeePipelineState {
  roverAuthority: { address: string; solBalance: number; wsolBalance: number };
  distPool: { address: string; solBalance: number; peggedBalance?: number };
  programVault: { address: string; solBalance: number; peggedBalance?: number };
  monkeState: {
    totalShareWeight: string;
    accumulatedSolPerShare: string;
    totalSolDistributed: number;
    totalBananasBurned: string;
    peggedMint?: string | null;
  } | null;
  totalInPipeline: number;
  timestamp: number;
}

export class RelayServer {
  private wss: InstanceType<typeof WebSocketServer> | null = null;
  private clients: Set<WebSocket> = new Set();
  private subscriber: GeyserSubscriber;
  private executor: HarvestExecutor;
  private keeper: MonkeKeeper;
  private connection: Connection;
  private coreProgramId: PublicKey;
  private botWalletProvider: (() => any) | null;
  private feeProvider: (() => Promise<FeePipelineState>) | null;

  // Rover TVL cache (computed by keeper, exposed via REST)
  private roverTvl: Map<string, RoverTvlEntry> = new Map();

  // Activity feed ring buffer (last 200 events)
  private feedEvents: RelayEvent[] = [];
  private static MAX_FEED_EVENTS = 200;

  // Address book
  private addressBookStore: AddressBookStore | null = null;
  private meteoraCache: Map<string, { data: any; ts: number }> = new Map();
  private static METEORA_CACHE_TTL = 5 * 60 * 1000;
  private static METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';

  constructor(
    subscriber: GeyserSubscriber,
    executor: HarvestExecutor,
    keeper: MonkeKeeper,
    connection: Connection,
    coreProgramId: PublicKey,
    botWalletProvider?: () => any,
    feeProvider?: () => Promise<FeePipelineState>,
  ) {
    this.subscriber = subscriber;
    this.executor = executor;
    this.keeper = keeper;
    this.connection = connection;
    this.coreProgramId = coreProgramId;
    this.botWalletProvider = botWalletProvider ?? null;
    this.feeProvider = feeProvider ?? null;
  }

  setAddressBookStore(store: AddressBookStore): void {
    this.addressBookStore = store;
  }

  /**
   * Attach to an existing HTTP server.
   * Adds WebSocket upgrade handling + REST route handling.
   */
  attach(server: HttpServer): void {
    // WebSocket server — upgrade at /ws path
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket: any, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      if (url.pathname === '/ws') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info(`[relay] WebSocket client connected (${this.clients.size} total)`);

      // Send recent feed events on connect (catch-up)
      ws.send(JSON.stringify({
        type: 'feedHistory',
        data: this.feedEvents.slice(-50),
        timestamp: Date.now(),
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info(`[relay] WebSocket client disconnected (${this.clients.size} total)`);
      });

      ws.on('error', (err) => {
        logger.warn(`[relay] WebSocket error: ${err.message}`);
        this.clients.delete(ws);
      });
    });

    // Wire subscriber events → WebSocket broadcast
    this.subscriber.on('activeBinChanged', (event: ActiveBinChangedEvent) => {
      this.broadcast('activeBinChanged', event);
    });

    this.subscriber.on('harvestNeeded', (job: HarvestJob) => {
      this.broadcast('harvestNeeded', {
        positionPDA: job.positionPDA,
        lbPair: job.lbPair.toBase58(),
        owner: job.owner.toBase58(),
        side: job.side,
        safeBinCount: job.safeBinIds.length,
      });
    });

    this.subscriber.on('positionChanged', (event: PositionChangedEvent) => {
      this.broadcast('positionChanged', event);
    });

    logger.info('[relay] WebSocket relay attached to HTTP server');
  }

  /**
   * Handle REST API requests. Called from the HTTP server's request handler.
   * Returns true if the request was handled, false if it should fall through.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // CORS — nginx handles Access-Control-Allow-Origin; app sets methods/headers only
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    if (!path.startsWith('/api/')) return false;

    try {
      switch (path) {
        case '/api/pools':
          return this.handlePools(res);
        case '/api/positions':
          return this.handlePositions(res);
        case '/api/pending-harvests':
          return this.handlePendingHarvests(res);
        case '/api/rovers':
          return this.handleRovers(res);
        case '/api/rovers/top5':
          return this.handleRoversTop5(res);
        case '/api/stats':
          return this.handleStats(res);
        case '/api/bot-wallet':
          return this.handleBotWallet(res);
        case '/api/fees':
          this.handleFees(res);
          return true;
        case '/api/user-bins':
          this.handleUserBins(url, res);
          return true;
        case '/api/addressbook':
          this.handleAddressBook(url, res);
          return true;
        default:
          // Check for /api/pools/{address}
          if (path.startsWith('/api/pools/')) {
            const address = path.slice('/api/pools/'.length);
            return this.handlePoolByAddress(res, address);
          }
          this.json(res, 404, { error: 'Not found' });
          return true;
      }
    } catch (e: any) {
      logger.error(`[relay] REST error: ${e.message}`);
      this.json(res, 500, { error: 'Internal server error' });
      return true;
    }
  }

  // ─── REST HANDLERS ───

  private handlePools(res: ServerResponse): boolean {
    const pools: any[] = [];
    for (const poolKey of this.subscriber.getWatchedPools()) {
      const info = this.subscriber.getPoolInfo(poolKey);
      if (info) {
        pools.push({
          address: poolKey,
          activeId: info.activeId,
          binStep: info.binStep,
          status: info.status,
          tokenXMint: info.tokenXMint.toBase58(),
          tokenYMint: info.tokenYMint.toBase58(),
          reserveX: info.reserveX.toBase58(),
          reserveY: info.reserveY.toBase58(),
          tokenXProgram: info.tokenXProgramFlag === 1 ? 'Token-2022' : 'SPL',
          tokenYProgram: info.tokenYProgramFlag === 1 ? 'Token-2022' : 'SPL',
        });
      }
    }
    this.json(res, 200, { pools, count: pools.length });
    return true;
  }

  private handlePoolByAddress(res: ServerResponse, address: string): boolean {
    const info = this.subscriber.getPoolInfo(address);
    if (!info) {
      this.json(res, 404, { error: 'Pool not watched or not found' });
      return true;
    }
    this.json(res, 200, {
      address,
      activeId: info.activeId,
      binStep: info.binStep,
      status: info.status,
      tokenXMint: info.tokenXMint.toBase58(),
      tokenYMint: info.tokenYMint.toBase58(),
      reserveX: info.reserveX.toBase58(),
      reserveY: info.reserveY.toBase58(),
      tokenXProgram: info.tokenXProgramFlag === 1 ? 'Token-2022' : 'SPL',
      tokenYProgram: info.tokenYProgramFlag === 1 ? 'Token-2022' : 'SPL',
    });
    return true;
  }

  private handlePositions(res: ServerResponse): boolean {
    const positions: any[] = [];
    for (const poolKey of this.subscriber.getWatchedPools()) {
      const poolPositions = this.subscriber.getPositionsForPool(poolKey);
      for (const pos of poolPositions) {
        const info = this.subscriber.getPoolInfo(poolKey);
        const activeId = info?.activeId ?? 0;
        // Compute fill: how many bins have been crossed
        let filledBins = 0;
        const totalBins = pos.maxBinId - pos.minBinId + 1;
        for (let b = pos.minBinId; b <= pos.maxBinId; b++) {
          if (pos.side === 'Sell' && b < activeId) filledBins++;
          if (pos.side === 'Buy' && b > activeId) filledBins++;
        }

        positions.push({
          positionPDA: pos.positionPDA,
          owner: pos.owner.toBase58(),
          lbPair: pos.lbPair.toBase58(),
          side: pos.side,
          minBinId: pos.minBinId,
          maxBinId: pos.maxBinId,
          totalBins,
          filledBins,
          fillPercent: totalBins > 0 ? Math.round((filledBins / totalBins) * 100) : 0,
        });
      }
    }
    this.json(res, 200, { positions, count: positions.length });
    return true;
  }

  private handlePendingHarvests(res: ServerResponse): boolean {
    const pending: any[] = [];
    for (const poolKey of this.subscriber.getWatchedPools()) {
      const info = this.subscriber.getPoolInfo(poolKey);
      if (!info) continue;
      const activeId = info.activeId;
      const poolPositions = this.subscriber.getPositionsForPool(poolKey);

      for (const pos of poolPositions) {
        let safeBins = 0;
        for (let b = pos.minBinId; b <= pos.maxBinId; b++) {
          if (pos.side === 'Sell' && b < activeId) safeBins++;
          if (pos.side === 'Buy' && b > activeId) safeBins++;
        }
        if (safeBins > 0) {
          pending.push({
            positionPDA: pos.positionPDA,
            lbPair: poolKey,
            owner: pos.owner.toBase58(),
            side: pos.side,
            safeBinCount: safeBins,
            totalBins: pos.maxBinId - pos.minBinId + 1,
          });
        }
      }
    }
    this.json(res, 200, { pending, count: pending.length });
    return true;
  }

  private handleRovers(res: ServerResponse): boolean {
    const rovers = [...this.roverTvl.values()]
      .sort((a, b) => b.tvl - a.tvl)
      .map((entry, idx) => ({ rank: idx + 1, ...entry }));
    this.json(res, 200, {
      rovers,
      count: rovers.length,
      totalTvl: rovers.reduce((sum, r) => sum + r.tvl, 0),
    });
    return true;
  }

  private handleRoversTop5(res: ServerResponse): boolean {
    const rovers = [...this.roverTvl.values()]
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 5)
      .map((entry, idx) => ({ rank: idx + 1, ...entry }));
    this.json(res, 200, { top5: rovers });
    return true;
  }

  private handleStats(res: ServerResponse): boolean {
    this.json(res, 200, {
      positionCount: this.subscriber.getPositionCount(),
      watchedPools: this.subscriber.getWatchedPools().length,
      grpcConnected: this.subscriber.isConnected(),
      grpcReconnects: this.subscriber.getReconnectCount(),
      totalHarvests: this.executor.totalHarvests,
      totalCloses: this.executor.totalCloses,
      queueDepth: this.executor.getQueueLength(),
      inflightTxs: this.executor.getInflightCount(),
      roverPoolCount: this.roverTvl.size,
      roverTotalTvl: [...this.roverTvl.values()].reduce((sum, r) => sum + r.tvl, 0),
      wsClients: this.clients.size,
    });
    return true;
  }

  private handleBotWallet(res: ServerResponse): boolean {
    if (!this.botWalletProvider) {
      this.json(res, 503, { error: 'Bot wallet info not available' });
      return true;
    }
    this.json(res, 200, this.botWalletProvider());
    return true;
  }

  private async handleFees(res: ServerResponse): Promise<void> {
    if (!this.feeProvider) {
      this.json(res, 503, { error: 'Fee pipeline info not available' });
      return;
    }
    try {
      const state = await this.feeProvider();
      this.json(res, 200, state);
    } catch (e: any) {
      logger.error(`[relay] Fee pipeline query error: ${e.message}`);
      this.json(res, 500, { error: 'Failed to query fee pipeline' });
    }
  }

  // ─── ADDRESS BOOK ───

  private async fetchMeteoraPoolData(poolAddress: string): Promise<any | null> {
    const cached = this.meteoraCache.get(poolAddress);
    if (cached && Date.now() - cached.ts < RelayServer.METEORA_CACHE_TTL) {
      return cached.data;
    }
    try {
      const resp = await fetch(`${RelayServer.METEORA_API_BASE}/pools/${poolAddress}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      this.meteoraCache.set(poolAddress, { data, ts: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  private async handleAddressBook(url: URL, res: ServerResponse): Promise<void> {
    const wallet = url.searchParams.get('wallet');
    if (!wallet) {
      this.json(res, 400, { error: 'Missing wallet query parameter' });
      return;
    }

    try {
      new PublicKey(wallet);
    } catch {
      this.json(res, 400, { error: 'Invalid wallet address' });
      return;
    }

    try {
      const livePositions = this.subscriber.getPositionsForWallet(wallet);
      const activePoolMap = new Map<string, number>();
      for (const pos of livePositions) {
        const pool = pos.lbPair.toBase58();
        activePoolMap.set(pool, (activePoolMap.get(pool) || 0) + 1);
      }

      const entries = this.addressBookStore?.getForWallet(wallet) || [];

      const activePools: any[] = [];
      const recentPools: any[] = [];

      const enrichPromises = [...new Set(entries.map(e => e.pair).concat([...activePoolMap.keys()]))].map(
        pair => this.fetchMeteoraPoolData(pair).then(data => [pair, data] as [string, any])
      );
      const enriched = new Map(await Promise.all(enrichPromises));

      for (const entry of entries) {
        const liveCount = activePoolMap.get(entry.pair) || 0;
        const meteoraData = enriched.get(entry.pair);
        const name = meteoraData?.name || entry.pair.slice(0, 8) + '...';
        const vol24h = meteoraData?.volume?.['24h'] || 0;
        const tvl = meteoraData?.tvl || 0;

        const binStep = meteoraData?.pool_config?.bin_step || 0;
        const alive = vol24h > 0 || tvl > 100;

        const item = {
          pair: entry.pair,
          name,
          binStep,
          openPositions: liveCount,
          lastActive: entry.lastActive,
          totalPositions: entry.totalPositionsOpened,
          volume24h: vol24h,
          tvl,
          alive,
        };

        if (liveCount > 0) {
          activePools.push(item);
        } else {
          const fourteenDays = 14 * 24 * 60 * 60;
          const isRecent = (Math.floor(Date.now() / 1000) - entry.lastActive) < fourteenDays;
          if (isRecent && alive) {
            recentPools.push(item);
          }
        }
      }

      for (const [pool, count] of activePoolMap) {
        if (!entries.some(e => e.pair === pool)) {
          const meteoraData = enriched.get(pool);
          activePools.push({
            pair: pool,
            name: meteoraData?.name || pool.slice(0, 8) + '...',
            binStep: meteoraData?.pool_config?.bin_step || 0,
            openPositions: count,
            lastActive: Math.floor(Date.now() / 1000),
            totalPositions: count,
            volume24h: meteoraData?.volume?.['24h'] || 0,
            tvl: meteoraData?.tvl || 0,
            alive: true,
          });
        }
      }

      activePools.sort((a, b) => b.lastActive - a.lastActive);
      recentPools.sort((a, b) => b.lastActive - a.lastActive);

      this.json(res, 200, {
        active: activePools,
        recent: recentPools.slice(0, 10),
        wallet,
        timestamp: Date.now(),
      });
    } catch (e: any) {
      logger.error(`[relay] /api/addressbook error: ${e.message}`);
      this.json(res, 500, { error: 'Failed to fetch address book' });
    }
  }

  /**
   * GET /api/user-bins?pool=<lbPair>&owner=<pubkey>
   * Returns real per-bin position amounts from the DLMM SDK.
   */
  private async handleUserBins(url: URL, res: ServerResponse): Promise<void> {
    const poolParam = url.searchParams.get('pool');
    const ownerParam = url.searchParams.get('owner');
    if (!poolParam || !ownerParam) {
      this.json(res, 400, { error: 'Missing pool or owner query parameter' });
      return;
    }

    try {
      const ownerPk = new PublicKey(ownerParam);
      const poolPositions = this.subscriber.getPositionsForPool(poolParam);
      const userPositions = poolPositions.filter(p => p.owner.equals(ownerPk));

      if (userPositions.length === 0) {
        this.json(res, 200, { bins: [], activeBin: null });
        return;
      }

      const lbPairPk = new PublicKey(poolParam);
      const dlmm = await getDLMM(this.connection, lbPairPk);
      await dlmm.refetchStates();
      const activeBin = dlmm.lbPair.activeId;

      const bins: Map<number, { buy: number; sell: number }> = new Map();

      for (const pos of userPositions) {
        const [vaultPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('vault'), pos.meteoraPosition.toBuffer()],
          this.coreProgramId,
        );

        const { userPositions: meteoraPositions } =
          await dlmm.getPositionsByUserAndLbPair(vaultPda);

        const meteoraPos = meteoraPositions.find(
          (p: any) => p.publicKey.equals(pos.meteoraPosition),
        );
        if (!meteoraPos) continue;

        const binData = meteoraPos.positionData.positionBinData;
        if (!binData || binData.length === 0) continue;

        const side = pos.side.toLowerCase() as 'buy' | 'sell';
        for (const bin of binData) {
          const xAmount = Number(bin.positionXAmount) / 1e9;
          const yAmount = Number(bin.positionYAmount) / 1e9;
          const amount = side === 'sell' ? xAmount : yAmount;
          if (amount <= 0) continue;

          const entry = bins.get(bin.binId) || { buy: 0, sell: 0 };
          entry[side] += amount;
          bins.set(bin.binId, entry);
        }
      }

      const binsArray = [...bins.entries()]
        .map(([binId, amounts]) => ({ binId, ...amounts }))
        .sort((a, b) => a.binId - b.binId);

      this.json(res, 200, { bins: binsArray, activeBin });
    } catch (e: any) {
      logger.error(`[relay] /api/user-bins error: ${e.message}`);
      this.json(res, 500, { error: 'Failed to fetch user bins' });
    }
  }

  // ─── BROADCAST ───

  /** Broadcast an event to all connected WebSocket clients + store in feed buffer */
  broadcast(type: string, data: any): void {
    const event: RelayEvent = { type, data, timestamp: Date.now() };

    // Store in ring buffer
    this.feedEvents.push(event);
    if (this.feedEvents.length > RelayServer.MAX_FEED_EVENTS) {
      this.feedEvents.shift();
    }

    // Broadcast to connected clients
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ─── ROVER TVL ───

  /** Called by keeper after computing rover TVL during Saturday cycle */
  updateRoverTvl(entries: RoverTvlEntry[]): void {
    this.roverTvl.clear();
    for (const entry of entries) {
      this.roverTvl.set(entry.pool, entry);
    }
    this.broadcast('roverTvlUpdated', {
      count: entries.length,
      totalTvl: entries.reduce((sum, e) => sum + e.tvl, 0),
    });
  }

  // ─── HELPERS ───

  private json(res: ServerResponse, status: number, body: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
