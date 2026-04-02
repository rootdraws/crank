/**
 * relay-server.ts
 *
 * WebSocket + REST relay for crank.money bot.
 * Exposes the bot's LaserStream-powered in-memory state to API consumers.
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
import * as fs from 'fs';
const WebSocketServer = WebSocket.Server;
import type { Server as HttpServer } from 'http';
import type { GeyserSubscriber, ActiveBinChangedEvent, HarvestJob, PositionChangedEvent } from './geyser-subscriber';
import type { HarvestExecutor } from './harvest-executor';
import type { MonkeKeeper } from './keeper';
import { logger } from './logger';

// ═══ TYPES ═══

/** Event broadcast to all connected WebSocket clients */
interface RelayEvent {
  type: string;
  data: any;
  timestamp: number;
}

/** Rover TVL entry for analytics */
export interface RoverTvlEntry {
  pool: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tvl: number;
  positionCount: number;
  status: 'active' | 'converting' | 'exhausted';
}

// ═══ PROTOCOL PNL AGGREGATOR ═══

interface PositionPnl {
  meteoraPosition: string;
  pool: string;
  side: 'Buy' | 'Sell';
  depositedUsd: number;
  withdrawnUsd: number;
  feesUsd: number;
  netPnl: number;
  isClosed: boolean;
  lastFetchedAt: number;
}

export interface ProtocolPnlSnapshot {
  totalPositions: number;
  closedPositions: number;
  openPositions: number;
  profitableCount: number;
  unprofitableCount: number;
  winRate: number;
  totalDepositedUsd: string;
  totalWithdrawnUsd: string;
  totalFeesUsd: string;
  netPnlUsd: string;
  avgReturnPct: number;
  byPool: Array<{
    pool: string;
    name: string;
    positions: number;
    winRate: number;
    netPnlUsd: string;
    depositedUsd: string;
  }>;
  bySide: {
    buy: { count: number; winRate: number; netPnlUsd: string };
    sell: { count: number; winRate: number; netPnlUsd: string };
  };
  roverPortfolio: any | null;
  lastUpdated: number;
}

export class ProtocolPnlAggregator {
  private positionPnls: Map<string, PositionPnl> = new Map();
  private snapshot: ProtocolPnlSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private meteoraApiBase: string;
  private concurrency = 5;

  constructor(
    private getPositions: () => Array<{ positionPDA: string; meteoraPosition: string; lbPair: string; side: 'Buy' | 'Sell'; isClosed?: boolean }>,
    private getPoolName: (pool: string) => Promise<string>,
    private getRoverAuthority?: () => string | null,
    meteoraApiBase?: string,
  ) {
    this.meteoraApiBase = meteoraApiBase || 'https://dlmm.datapi.meteora.ag';
  }

  start(intervalMs = 10 * 60 * 1000): void {
    this.runCycle().catch(e => logger.error(`[pnl-aggregator] Initial cycle failed: ${e.message}`));
    this.timer = setInterval(() => {
      this.runCycle().catch(e => logger.error(`[pnl-aggregator] Cycle failed: ${e.message}`));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  getSnapshot(): ProtocolPnlSnapshot | null {
    return this.snapshot;
  }

  private async runCycle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const positions = this.getPositions();
      logger.info(`[pnl-aggregator] Scanning ${positions.length} positions`);

      const toFetch: typeof positions = [];
      for (const pos of positions) {
        const cached = this.positionPnls.get(pos.meteoraPosition);
        if (cached?.isClosed) continue;
        const staleMs = 10 * 60 * 1000;
        if (cached && Date.now() - cached.lastFetchedAt < staleMs) continue;
        toFetch.push(pos);
      }

      // Fetch in batches with concurrency limit
      for (let i = 0; i < toFetch.length; i += this.concurrency) {
        const batch = toFetch.slice(i, i + this.concurrency);
        await Promise.allSettled(batch.map(pos => this.fetchPositionHistory(pos)));
      }

      // Fetch rover portfolio if available
      let roverPortfolio: any = null;
      if (this.getRoverAuthority) {
        const roverAddr = this.getRoverAuthority();
        if (roverAddr) {
          roverPortfolio = await this.fetchRoverPortfolio(roverAddr);
        }
      }

      this.buildSnapshot(positions, roverPortfolio);
      logger.info(`[pnl-aggregator] Snapshot updated: ${this.snapshot?.totalPositions} positions, ${(this.snapshot?.winRate ?? 0 * 100).toFixed(1)}% win rate`);
    } finally {
      this.running = false;
    }
  }

  private async fetchPositionHistory(pos: { meteoraPosition: string; lbPair: string; side: 'Buy' | 'Sell' }): Promise<void> {
    try {
      const resp = await fetch(`${this.meteoraApiBase}/positions/${pos.meteoraPosition}/historical`);
      if (!resp.ok) return;
      const data = await resp.json();
      const events: Array<{ eventType: string; amountXUsd: string; amountYUsd: string; totalUsd: string }> = data.events || [];

      let depositedUsd = 0;
      let withdrawnUsd = 0;
      let feesUsd = 0;
      let hasRemoveOrClaim = false;

      for (const evt of events) {
        const total = parseFloat(evt.totalUsd) || 0;
        switch (evt.eventType) {
          case 'add':
            depositedUsd += total;
            break;
          case 'remove':
            withdrawnUsd += total;
            hasRemoveOrClaim = true;
            break;
          case 'claim_fee':
            feesUsd += total;
            hasRemoveOrClaim = true;
            break;
          case 'claim_reward':
            feesUsd += total;
            hasRemoveOrClaim = true;
            break;
        }
      }

      const isClosed = hasRemoveOrClaim && events.length > 0 &&
        events[events.length - 1]?.eventType === 'remove';

      this.positionPnls.set(pos.meteoraPosition, {
        meteoraPosition: pos.meteoraPosition,
        pool: pos.lbPair,
        side: pos.side,
        depositedUsd,
        withdrawnUsd,
        feesUsd,
        netPnl: (withdrawnUsd + feesUsd) - depositedUsd,
        isClosed,
        lastFetchedAt: Date.now(),
      });
    } catch {
      // Skip failures silently
    }
  }

  private async fetchRoverPortfolio(roverAuthority: string): Promise<any> {
    try {
      const [openResp, totalResp] = await Promise.all([
        fetch(`${this.meteoraApiBase}/portfolio/open?user=${roverAuthority}`).then(r => r.ok ? r.json() : null),
        fetch(`${this.meteoraApiBase}/portfolio/total?user=${roverAuthority}`).then(r => r.ok ? r.json() : null),
      ]);
      return { open: openResp, total: totalResp };
    } catch {
      return null;
    }
  }

  private buildSnapshot(
    positions: Array<{ meteoraPosition: string; lbPair: string; side: 'Buy' | 'Sell' }>,
    roverPortfolio: any,
  ): void {
    let totalDeposited = 0, totalWithdrawn = 0, totalFees = 0;
    let profitableCount = 0, unprofitableCount = 0;
    let closedCount = 0, openCount = 0;

    const poolStats = new Map<string, { positions: number; profitable: number; netPnl: number; deposited: number }>();
    const sideStats = {
      buy: { count: 0, profitable: 0, netPnl: 0 },
      sell: { count: 0, profitable: 0, netPnl: 0 },
    };

    for (const pos of positions) {
      const pnl = this.positionPnls.get(pos.meteoraPosition);
      if (!pnl) continue;

      totalDeposited += pnl.depositedUsd;
      totalWithdrawn += pnl.withdrawnUsd;
      totalFees += pnl.feesUsd;

      if (pnl.isClosed) {
        closedCount++;
        if (pnl.netPnl > 0) profitableCount++;
        else unprofitableCount++;
      } else {
        openCount++;
      }

      const poolKey = pnl.pool;
      const ps = poolStats.get(poolKey) || { positions: 0, profitable: 0, netPnl: 0, deposited: 0 };
      ps.positions++;
      if (pnl.netPnl > 0) ps.profitable++;
      ps.netPnl += pnl.netPnl;
      ps.deposited += pnl.depositedUsd;
      poolStats.set(poolKey, ps);

      const sideKey = pnl.side === 'Buy' ? 'buy' : 'sell';
      sideStats[sideKey].count++;
      if (pnl.netPnl > 0) sideStats[sideKey].profitable++;
      sideStats[sideKey].netPnl += pnl.netPnl;
    }

    const totalClosed = profitableCount + unprofitableCount;
    const winRate = totalClosed > 0 ? profitableCount / totalClosed : 0;
    const netPnl = (totalWithdrawn + totalFees) - totalDeposited;
    const avgReturn = totalDeposited > 0 ? (netPnl / totalDeposited) * 100 : 0;

    const byPoolArray: ProtocolPnlSnapshot['byPool'] = [];
    for (const [pool, ps] of poolStats) {
      const wr = ps.positions > 0 ? ps.profitable / ps.positions : 0;
      byPoolArray.push({
        pool,
        name: pool.slice(0, 8) + '...',
        positions: ps.positions,
        winRate: wr,
        netPnlUsd: ps.netPnl.toFixed(2),
        depositedUsd: ps.deposited.toFixed(2),
      });
    }
    byPoolArray.sort((a, b) => parseFloat(b.netPnlUsd) - parseFloat(a.netPnlUsd));

    // Resolve pool names asynchronously (best-effort, use cached)
    for (const entry of byPoolArray) {
      this.getPoolName(entry.pool).then(name => { entry.name = name; }).catch(() => {});
    }

    this.snapshot = {
      totalPositions: positions.length,
      closedPositions: closedCount,
      openPositions: openCount,
      profitableCount,
      unprofitableCount,
      winRate,
      totalDepositedUsd: totalDeposited.toFixed(2),
      totalWithdrawnUsd: totalWithdrawn.toFixed(2),
      totalFeesUsd: totalFees.toFixed(2),
      netPnlUsd: netPnl.toFixed(2),
      avgReturnPct: parseFloat(avgReturn.toFixed(2)),
      byPool: byPoolArray,
      bySide: {
        buy: {
          count: sideStats.buy.count,
          winRate: sideStats.buy.count > 0 ? sideStats.buy.profitable / sideStats.buy.count : 0,
          netPnlUsd: sideStats.buy.netPnl.toFixed(2),
        },
        sell: {
          count: sideStats.sell.count,
          winRate: sideStats.sell.count > 0 ? sideStats.sell.profitable / sideStats.sell.count : 0,
          netPnlUsd: sideStats.sell.netPnl.toFixed(2),
        },
      },
      roverPortfolio,
      lastUpdated: Date.now(),
    };
  }
}

// ═══ RELAY SERVER ═══

/** Fee pipeline state returned by the /api/fees endpoint */
export interface FeePipelineState {
  roverAuthority: { address: string; solBalance: number; wsolBalance: number };
  distributor: { address: string; vaultPeggedBalance: number };
  distributorState: {
    currentEpoch: string;
    totalAmountFunded: string;
    totalAmountClaimed: string;
    paused: boolean;
    mint: string | null;
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
  private healthProvider: (() => { lastHarvestAt: number | null; lastKeeperRunAt: number | null; startTime: number; botSolBalance: number | null }) | null;

  // Rover TVL cache (computed by keeper, exposed via REST)
  private roverTvl: Map<string, RoverTvlEntry> = new Map();

  // Activity feed ring buffer (last 200 events)
  private feedEvents: RelayEvent[] = [];
  private static MAX_FEED_EVENTS = 200;

  // Meteora DataPI cache (pool name lookups for PnL aggregator)
  private meteoraCache: Map<string, { data: any; ts: number }> = new Map();
  private static METEORA_CACHE_TTL = 5 * 60 * 1000;
  private static METEORA_API_BASE = 'https://dlmm.datapi.meteora.ag';

  // Protocol PnL aggregator
  private pnlAggregator: ProtocolPnlAggregator | null = null;

  // Price syncer stats provider
  private syncerStatsProvider: (() => Record<string, any>) | null = null;

  // Feed persistence
  private feedCachePath = './feed-cache.json';
  private feedSaveTimer: NodeJS.Timeout | null = null;

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
    this.healthProvider = null;
  }

  setHealthProvider(provider: () => { lastHarvestAt: number | null; lastKeeperRunAt: number | null; startTime: number; botSolBalance: number | null }): void {
    this.healthProvider = provider;
  }

  setSyncerStatsProvider(provider: () => Record<string, any>): void {
    this.syncerStatsProvider = provider;
  }

  /** Start the protocol PnL aggregator that scans all position histories periodically */
  startPnlAggregator(getRoverAuthority?: () => string | null): void {
    this.pnlAggregator = new ProtocolPnlAggregator(
      () => {
        const results: Array<{ positionPDA: string; meteoraPosition: string; lbPair: string; side: 'Buy' | 'Sell' }> = [];
        for (const poolKey of this.subscriber.getWatchedPools()) {
          for (const pos of this.subscriber.getPositionsForPool(poolKey)) {
            results.push({
              positionPDA: pos.positionPDA,
              meteoraPosition: pos.meteoraPosition.toBase58(),
              lbPair: pos.lbPair.toBase58(),
              side: pos.side,
            });
          }
        }
        return results;
      },
      async (pool: string) => {
        const data = await this.fetchMeteoraPoolData(pool);
        return data?.name || pool.slice(0, 8) + '...';
      },
      getRoverAuthority,
      RelayServer.METEORA_API_BASE,
    );
    this.pnlAggregator.start();
    logger.info('[relay] Protocol PnL aggregator started');
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

    // Load persisted feed cache
    this.loadFeedCache();

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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        case '/api/health':
          return this.handleHealth(res);
        case '/api/bot-wallet':
          return this.handleBotWallet(res);
        case '/api/fees':
          this.handleFees(res);
          return true;
        case '/api/feed':
          this.handleFeed(res);
          return true;
        case '/api/protocol-pnl':
          this.handleProtocolPnl(res);
          return true;
        case '/api/syncer':
          return this.handleSyncer(res);
        default:
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

  private handleHealth(res: ServerResponse): boolean {
    const grpcConnected = this.subscriber.isConnected();
    const health = this.healthProvider?.() ?? null;
    const now = Date.now();

    // Stale thresholds
    const GRPC_STALE = !grpcConnected;
    const LOW_BALANCE = health?.botSolBalance !== null && health!.botSolBalance < 0.05 * 1e9; // < 0.05 SOL

    const ok = !GRPC_STALE && !LOW_BALANCE;
    const status = ok ? 200 : 503;

    this.json(res, status, {
      healthy: ok,
      grpcConnected,
      lowBalance: !!LOW_BALANCE,
      botSolBalance: health?.botSolBalance ? health.botSolBalance / 1e9 : null,
      lastHarvestAt: health?.lastHarvestAt ? new Date(health.lastHarvestAt).toISOString() : null,
      lastKeeperRunAt: health?.lastKeeperRunAt ? new Date(health.lastKeeperRunAt).toISOString() : null,
      uptimeSeconds: health?.startTime ? Math.floor((now - health.startTime) / 1000) : null,
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

  private handleFeed(res: ServerResponse): void {
    this.json(res, 200, {
      events: this.feedEvents.slice(-50),
      timestamp: Date.now(),
    });
  }

  private handleSyncer(res: ServerResponse): boolean {
    if (!this.syncerStatsProvider) {
      this.json(res, 503, { error: 'Price syncer not enabled' });
      return true;
    }
    this.json(res, 200, this.syncerStatsProvider());
    return true;
  }

  private handleProtocolPnl(res: ServerResponse): void {
    const snapshot = this.pnlAggregator?.getSnapshot();
    if (!snapshot) {
      this.json(res, 503, { error: 'PnL aggregator not ready — data is being computed' });
      return;
    }
    this.json(res, 200, snapshot);
  }

  // ─── METEORA POOL DATA (for PnL aggregator pool name resolution) ───

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

  // ─── BROADCAST ───

  /** Broadcast an event to all connected WebSocket clients + store in feed buffer */
  broadcast(type: string, data: any): void {
    const event: RelayEvent = { type, data, timestamp: Date.now() };

    // Store in ring buffer
    this.feedEvents.push(event);
    if (this.feedEvents.length > RelayServer.MAX_FEED_EVENTS) {
      this.feedEvents.shift();
    }

    // Debounce-save feed cache every 5s
    clearTimeout(this.feedSaveTimer!);
    this.feedSaveTimer = setTimeout(() => this.saveFeedCache(), 5000);

    // Broadcast to connected clients
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ─── ROVER TVL ───

  /** Called by keeper after computing rover TVL during daily cycle */
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

  // ─── FEED PERSISTENCE ───

  private loadFeedCache(): void {
    try {
      if (fs.existsSync(this.feedCachePath)) {
        const raw = fs.readFileSync(this.feedCachePath, 'utf8');
        const events = JSON.parse(raw);
        if (Array.isArray(events)) {
          this.feedEvents = events.slice(-RelayServer.MAX_FEED_EVENTS);
          logger.info(`[relay] Loaded ${this.feedEvents.length} feed events from cache`);
        }
      }
    } catch (e: any) {
      logger.warn(`[relay] Failed to load feed cache: ${e.message}`);
    }
  }

  private saveFeedCache(): void {
    try {
      fs.writeFileSync(this.feedCachePath, JSON.stringify(this.feedEvents.slice(-200)));
    } catch (e: any) {
      logger.warn(`[relay] Failed to save feed cache: ${e.message}`);
    }
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
