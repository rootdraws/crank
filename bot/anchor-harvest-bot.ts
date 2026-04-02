/**
 * anchor-harvest-bot.ts
 *
 * crank.money orchestrator. Wires together:
 *   - GeyserSubscriber: gRPC stream for real-time price monitoring
 *   - HarvestExecutor: job queue for harvest/close transactions
 *   - MonkeKeeper: daily fee sequencer (unwrap → sweep → stake_and_forward → fee rovers → new_epoch → cleanup)
 *
 * The bot never holds user funds or revenue SOL.
 * Revenue SOL flows: rover_authority → 40/40/20 split → SOL direct to users.
 * 40/40/20 split: 40% holders + 40% traders + 20% Config.bot. Hardcoded in sweep_rover.
 * The bot only cranks permissionless instructions.
 *
 * Daily cadence: keeper sequence (unwrap WSOL → sweep → stake_and_forward → fee rovers → new_epoch → cleanup).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Commitment,
} from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import DLMM from '@meteora-ag/dlmm';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import * as http from 'http';
import * as fs from 'fs';

import { GeyserSubscriber, HarvestJob } from './geyser-subscriber';
import { HarvestExecutor } from './harvest-executor';
import { MonkeKeeper } from './keeper';
import { RelayServer, FeePipelineState } from './relay-server';
import { logger } from './logger';
import { getDLMMCacheSize, getDLMM } from './meteora-accounts';
import { initAlerter, alertLowBalance, alertGrpcDisconnect, alertGrpcReconnect, alertKeeperFailure } from './alerter';
import { PriceSyncer, SyncPoolConfig } from './price-syncer';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

// ═══ CONFIG ═══

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) { logger.error('FATAL: RPC_URL not set'); process.exit(1); }

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT;
if (!GRPC_ENDPOINT) { logger.error('FATAL: GRPC_ENDPOINT not set'); process.exit(1); }

// Support file-based keypair (BOT_KEYPAIR_PATH) or env var (BOT_PRIVATE_KEY)
let botKeypair: Keypair;
try {
  const keypairPath = process.env.BOT_KEYPAIR_PATH;
  if (keypairPath) {
    // File-based keypair (recommended for production — standard Solana CLI pattern)
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    botKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
    logger.info(`Loaded bot keypair from file: ${keypairPath}`);
  } else {
    const raw = process.env.BOT_PRIVATE_KEY;
    if (!raw) throw new Error('BOT_PRIVATE_KEY or BOT_KEYPAIR_PATH must be set');
    botKeypair = Keypair.fromSecretKey(bs58.decode(raw));
  }
} catch (e: any) {
  logger.error(`FATAL: Invalid bot keypair — ${e.message}`);
  process.exit(1);
}

// Validate all env vars with clear error messages (not silent non-null assertions)
function requireEnvPubkey(name: string): PublicKey {
  const val = process.env[name];
  if (!val) { logger.error(`FATAL: ${name} not set`); process.exit(1); }
  try { return new PublicKey(val); }
  catch { logger.error(`FATAL: ${name} is not a valid pubkey: ${val}`); process.exit(1); }
}

const CORE_PROGRAM_ID       = requireEnvPubkey('CORE_PROGRAM_ID');
const DISTRIBUTOR_PROGRAM_ID = requireEnvPubkey('DISTRIBUTOR_PROGRAM_ID');

// PEGGED/bridge programs retired — SOL distributed directly

const COMMITMENT: Commitment    = 'confirmed';
const KEEPER_ACTIVE_INTERVAL_MS = parseInt(process.env.KEEPER_CHECK_INTERVAL_MS || '3600000'); // 1hr during Active
const KEEPER_PROCESSING_INTERVAL_MS = 30_000; // 30s during daily processing
const SAFETY_POLL_INTERVAL_MS   = 30 * 1000; // 30 seconds

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8080');
// Validate parsed lamport values are within safe integer range
const SOL_BALANCE_WARN = parseInt(process.env.SOL_BALANCE_WARN_LAMPORTS || '1000000000'); // 1 SOL
const SOL_BALANCE_CRITICAL = parseInt(process.env.SOL_BALANCE_CRITICAL_LAMPORTS || '100000000'); // 0.1 SOL
if (!Number.isSafeInteger(SOL_BALANCE_WARN)) { logger.warn(`SOL_BALANCE_WARN exceeds safe integer range`); }
if (!Number.isSafeInteger(SOL_BALANCE_CRITICAL)) { logger.warn(`SOL_BALANCE_CRITICAL exceeds safe integer range`); }

// ═══ SYNCER CONFIG ═══
const SYNC_ENABLED = process.env.SYNC_ENABLED === 'true';
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || '60000');
const SYNC_DIVERGENCE_THRESHOLD_PCT = parseFloat(process.env.SYNC_DIVERGENCE_THRESHOLD_PCT || '2');
const SYNC_MIN_PROFIT_LAMPORTS = parseInt(process.env.SYNC_MIN_PROFIT_LAMPORTS || '5000000');
const SYNC_MAX_SWAP_SOL = parseFloat(process.env.SYNC_MAX_SWAP_SOL || '0.5');
const SYNC_DRY_RUN = process.env.SYNC_DRY_RUN !== 'false'; // default true for safety

// ═══ RETRY ═══

const MAX_RETRIES = 3;
const BASE_DELAY  = 1000;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      if (i < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, i);
        logger.warn(`  [retry] ${label} #${i + 1}, ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ═══ PDA HELPERS ═══

function coreConfigPDA(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], CORE_PROGRAM_ID);
}

// ═══ BOT ═══

class HarvestBot {
  private connection: Connection;
  private provider: AnchorProvider;
  private coreProgram!: Program;
  private distributorProgram!: Program;
  private epochVaultProgram!: Program;

  // Modules
  private subscriber!: GeyserSubscriber;
  private executor!: HarvestExecutor;
  private keeper!: MonkeKeeper;
  private relay!: RelayServer;
  private syncer: PriceSyncer | null = null;

  // Timers
  private keeperTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  private startTime = Date.now();
  private lastHarvestAt: number | null = null;
  private lastKeeperRunAt: number | null = null;
  private healthServer: http.Server | null = null;
  private lastKnownBalance: number | null = null;
  private startingBalance: number | null = null;
  private balanceHistory: { timestamp: number; lamports: number }[] = [];

  constructor() {
    this.connection = new Connection(RPC_URL!, { commitment: COMMITMENT });
    const wallet = new Wallet(botKeypair);
    this.provider = new AnchorProvider(this.connection, wallet, { commitment: COMMITMENT });

    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT',  () => this.shutdown());
  }

  private async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info('\nShutting down...');

    if (this.keeperTimer) clearTimeout(this.keeperTimer);
    if (this.healthServer) this.healthServer.close();

    if (this.syncer) await this.syncer.shutdown();
    if (this.subscriber) await this.subscriber.shutdown();
    if (this.executor) await this.executor.shutdown();

    logger.info('Shutdown complete.');
    process.exit(0);
  }

  private recordBalance(lamports: number): void {
    this.balanceHistory.push({ timestamp: Date.now(), lamports });
    // Keep last 288 samples (~24h at 5min intervals)
    if (this.balanceHistory.length > 288) this.balanceHistory.shift();
  }

  getBotWalletInfo() {
    const now = Date.now();
    const uptimeMs = now - this.startTime;
    const currentBalance = this.lastKnownBalance ?? 0;
    const startBal = this.startingBalance ?? currentBalance;
    const netSpent = startBal - currentBalance;

    // Compute spend rate from balance history (SOL/hour)
    let spendRatePerHour: number | null = null;
    if (this.balanceHistory.length >= 2) {
      const oldest = this.balanceHistory[0];
      const newest = this.balanceHistory[this.balanceHistory.length - 1];
      const elapsedHours = (newest.timestamp - oldest.timestamp) / 3_600_000;
      if (elapsedHours > 0) {
        spendRatePerHour = (oldest.lamports - newest.lamports) / 1e9 / elapsedHours;
      }
    }

    // Estimate hours remaining at current spend rate
    let estimatedHoursRemaining: number | null = null;
    if (spendRatePerHour !== null && spendRatePerHour > 0) {
      estimatedHoursRemaining = Math.round((currentBalance / 1e9) / spendRatePerHour * 10) / 10;
    }

    return {
      address: botKeypair.publicKey.toBase58(),
      balanceSol: currentBalance / 1e9,
      balanceLamports: currentBalance,
      startingBalanceSol: startBal / 1e9,
      netSpentSol: Math.round(netSpent / 1e6) / 1e3, // 3 decimal places
      uptimeHours: Math.round(uptimeMs / 3_600_000 * 10) / 10,
      spendRatePerHour,
      estimatedHoursRemaining,
      warnThresholdSol: SOL_BALANCE_WARN / 1e9,
      criticalThresholdSol: SOL_BALANCE_CRITICAL / 1e9,
      status: currentBalance < SOL_BALANCE_CRITICAL ? 'critical'
            : currentBalance < SOL_BALANCE_WARN ? 'warning'
            : 'healthy',
      txCounts: {
        harvests: this.executor?.totalHarvests ?? 0,
        closes: this.executor?.totalCloses ?? 0,
      },
      samples: this.balanceHistory.length,
    };
  }

  async getFeePipelineState(): Promise<FeePipelineState> {
    const [roverPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('rover_authority')], CORE_PROGRAM_ID
    );
    const [distPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('distributor')], DISTRIBUTOR_PROGRAM_ID
    );
    const wsolMint = new PublicKey('So11111111111111111111111111111111111111112');

    const [roverBal, distAcctInfo] = await Promise.all([
      this.connection.getBalance(roverPDA),
      (this.distributorProgram.account as any).distributor.fetch(distPDA).catch(() => null),
    ]);

    let wsolBal = 0;
    try {
      const { getAssociatedTokenAddressSync: getAta } = await import('@solana/spl-token');
      const ata = getAta(wsolMint, roverPDA, true);
      const info = await this.connection.getAccountInfo(ata);
      if (info && info.data.length >= 72) wsolBal = Number(info.data.readBigUInt64LE(64));
    } catch { /* no WSOL ATA */ }

    const distributorState = distAcctInfo ? {
      currentEpoch: distAcctInfo.currentEpoch?.toString() ?? '0',
      totalAmountFunded: distAcctInfo.totalAmountFunded?.toString() ?? '0',
      totalAmountClaimed: distAcctInfo.totalAmountClaimed?.toString() ?? '0',
      paused: distAcctInfo.paused ?? false,
    } : null;

    return {
      roverAuthority: { address: roverPDA.toBase58(), solBalance: roverBal, wsolBalance: wsolBal },
      distributorState,
      totalInPipeline: roverBal + wsolBal,
      timestamp: Date.now(),
    };
  }

  private startHealthServer(): void {
    this.healthServer = http.createServer((req, res) => {
      // Try relay REST routes first (/api/*)
      if (this.relay && this.relay.handleRequest(req, res)) {
        return;
      }

      if (req.url === '/health' || req.url === '/') {
        const health = {
          status: 'ok',
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          connected: this.subscriber?.isConnected() ?? false,
          positionCount: this.subscriber?.getPositionCount() ?? 0,
          lastHarvestAt: this.lastHarvestAt ? new Date(this.lastHarvestAt).toISOString() : null,
          lastKeeperRunAt: this.lastKeeperRunAt ? new Date(this.lastKeeperRunAt).toISOString() : null,
          botSolBalance: this.lastKnownBalance !== null ? this.lastKnownBalance / 1e9 : null,
          shuttingDown: this.shuttingDown,
          queueDepth: this.executor?.getQueueLength() ?? 0,
          inflightTxs: this.executor?.getInflightCount() ?? 0,
          totalHarvests: this.executor?.totalHarvests ?? 0,
          totalCloses: this.executor?.totalCloses ?? 0,
          grpcReconnects: this.subscriber?.getReconnectCount() ?? 0,
          dlmmCacheSize: getDLMMCacheSize(),
          wsClients: this.relay?.getClientCount() ?? 0,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health, null, 2));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.healthServer.listen(HEALTH_PORT, () => {
      logger.info(`[health] HTTP health endpoint on :${HEALTH_PORT}/health`);
    });

    this.healthServer.on('error', (err: any) => {
      logger.warn(`[health] Failed to start health server: ${err.message}`);
    });
  }

  async init() {
    // Strip query params (may contain API keys) before logging
    const safeRpc = RPC_URL!.split('?')[0];
    const safeGrpc = GRPC_ENDPOINT!.split('?')[0];
    logger.info(`bot:  ${botKeypair.publicKey.toBase58()}`);
    logger.info(`rpc:  ${safeRpc}`);
    logger.info(`grpc: ${safeGrpc}`);

    // Load IDL from local JSON files instead of on-chain fetch.
    // anchor build --no-idl means no IDL account exists on-chain.
    // Generate IDL files with: anchor idl build (on compatible Rust) → bot/idl/*.json
    const idlDir = process.env.IDL_DIR || path.join(__dirname, 'idl');
    function loadIdl(name: string): any {
      const filePath = path.join(idlDir, `${name}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`IDL file not found: ${filePath} — generate with 'anchor idl build' on Rust ≤1.79`);
      }
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }

    const coreIdl = loadIdl('bin_farm');
    this.coreProgram = new Program(coreIdl, this.provider);

    const distributorIdl = loadIdl('merkle_distributor');
    this.distributorProgram = new Program(distributorIdl, this.provider);

    const epochVaultIdl = loadIdl('epoch_vault');
    this.epochVaultProgram = new Program(epochVaultIdl, this.provider);

    // Verify bot authorization
    const [configPDA] = coreConfigPDA();
    const config = await this.coreProgram.account.config.fetch(configPDA);
    if (!config.bot.equals(botKeypair.publicKey)) {
      throw new Error(`Bot key mismatch. Config expects: ${config.bot.toBase58()}`);
    }
    logger.info('Bot authorized ✓');

    // Check bot SOL balance
    const botBalance = await this.connection.getBalance(botKeypair.publicKey);
    this.lastKnownBalance = botBalance;
    this.startingBalance = botBalance;
    this.recordBalance(botBalance);
    if (botBalance < SOL_BALANCE_CRITICAL) {
      logger.error(`[bot] CRITICAL: Bot SOL balance ${botBalance / 1e9} SOL — below ${SOL_BALANCE_CRITICAL / 1e9} threshold`);
    } else if (botBalance < SOL_BALANCE_WARN) {
      logger.warn(`[bot] WARNING: Bot SOL balance ${botBalance / 1e9} SOL — below ${SOL_BALANCE_WARN / 1e9} threshold`);
    } else {
      logger.info(`[bot] Bot SOL balance: ${botBalance / 1e9} SOL`);
    }

    // Initialize modules
    this.subscriber = new GeyserSubscriber(
      this.connection,
      this.coreProgram,
      CORE_PROGRAM_ID,
      GRPC_ENDPOINT!,
    );

    this.executor = new HarvestExecutor({
      connection: this.connection,
      coreProgram: this.coreProgram,
      botKeypair,
      coreProgramId: CORE_PROGRAM_ID,
    });

    this.keeper = new MonkeKeeper({
      connection: this.connection,
      coreProgram: this.coreProgram,
      distributorProgram: this.distributorProgram,
      epochVaultProgram: this.epochVaultProgram,
      botKeypair,
      coreProgramId: CORE_PROGRAM_ID,
      distributorProgramId: DISTRIBUTOR_PROGRAM_ID,
      walletService: null, // set after discord bot starts
      getWatchedPools: () => this.subscriber.getWatchedPools(),
    });
  }

  // ─── SAFETY-NET POLL ───

  // Configurable delay between RPC calls in safety poll
  private static SAFETY_POLL_DELAY_MS = parseInt(process.env.SAFETY_POLL_DELAY_MS || '200');

  async safetyPoll() {
    if (this.shuttingDown) return;

    try {
      const positions = await withRetry(
        () => this.coreProgram.account.position.all(),
        'safety poll positions'
      ) as Array<{ publicKey: PublicKey; account: any }>;

      const ts = new Date().toISOString().slice(11, 19);
      logger.info(`[safety] ${ts} ${positions.length} positions`);

      // Group positions by pool to avoid redundant DLMM.create() calls.
      // One RPC call per pool instead of one per position.
      const byPool = new Map<string, Array<{ publicKey: PublicKey; account: any }>>();
      for (const pos of positions) {
        const poolKey = (pos.account.lbPair as PublicKey).toBase58();
        if (!byPool.has(poolKey)) byPool.set(poolKey, []);
        byPool.get(poolKey)!.push(pos);
      }

      for (const [poolKey, poolPositions] of byPool) {
        if (this.shuttingDown) break;

        try {
          const dlmm = await getDLMM(this.connection, new PublicKey(poolKey));
          const activeId = dlmm.lbPair.activeId;

          // Look up cached pool metadata from gRPC stream (if available)
          // so the executor gets token program flags for Token-2022 ATA derivation.
          const cachedPoolInfo = this.subscriber?.getPoolInfo(poolKey);

          for (const pos of poolPositions) {
            if (this.shuttingDown) break;
            try {
              this.checkPositionAgainstActiveId(pos, activeId, cachedPoolInfo);
            } catch (e: any) {
              // Log safety poll errors instead of silently swallowing
              logger.warn(`[safety] ${pos.publicKey.toBase58().slice(0, 8)}... error: ${e.message?.slice(0, 120)}`);
            }
          }
        } catch (e: any) {
          logger.warn(`[safety] pool ${poolKey.slice(0, 8)}... error: ${e.message?.slice(0, 120)}`);
        }

        // Rate limit between pool checks
        await sleep(HarvestBot.SAFETY_POLL_DELAY_MS);
      }
    } catch (e: any) {
      logger.error(`[safety] poll error: ${e.message}`);
    }
  }

  /**
   * Check a single position against a known activeId.
   * Extracted from checkPositionFallback to allow pool-batched checking.
   */
  private checkPositionAgainstActiveId(
    pos: { publicKey: PublicKey; account: any },
    activeId: number,
    poolInfo?: import('./geyser-subscriber').LbPairInfo,
  ): void {
    const data = pos.account;
    const lbPair = data.lbPair as PublicKey;
    const meteoraPosition = data.meteoraPosition as PublicKey;
    const side: 'Buy' | 'Sell' = data.side.buy ? 'Buy' : 'Sell';
    const owner = data.owner as PublicKey;

    const minBin = data.minBinId as number;
    const maxBin = data.maxBinId as number;

    // Skip dust positions (< 2 bins) to mitigate griefing
    const MIN_BINS = parseInt(process.env.MIN_POSITION_BINS || '2');
    if (maxBin - minBin + 1 < MIN_BINS) return;

    if (side === 'Sell' && activeId <= minBin) {
      logger.info(`[safety] skip ${pos.publicKey.toBase58().slice(0,8)} Sell: activeId ${activeId} <= minBin ${minBin}`);
      return;
    }
    if (side === 'Buy' && activeId >= maxBin) {
      logger.info(`[safety] skip ${pos.publicKey.toBase58().slice(0,8)} Buy: activeId ${activeId} >= maxBin ${maxBin}`);
      return;
    }

    logger.info(`[safety] ENQUEUE ${pos.publicKey.toBase58().slice(0,8)} ${side} activeId=${activeId} bins=${minBin}..${maxBin}`);
    this.executor.enqueue({
      positionPDA: pos.publicKey.toBase58(),
      lbPair,
      meteoraPosition,
      owner,
      side,
      safeBinIds: [],
      poolInfo,
    });
  }

  // ─── RUN ───

  async run() {
    await this.init();

    this.startHealthServer();

    // Initialize relay server (WebSocket + REST) on the same HTTP server
    this.relay = new RelayServer(
      this.subscriber, this.executor, this.keeper,
      this.connection, CORE_PROGRAM_ID,
      () => this.getBotWalletInfo(),
      () => this.getFeePipelineState(),
    );
    if (this.healthServer) {
      this.relay.attach(this.healthServer);
      this.relay.setHealthProvider(() => ({
        lastHarvestAt: this.lastHarvestAt,
        lastKeeperRunAt: this.lastKeeperRunAt,
        startTime: this.startTime,
        botSolBalance: this.lastKnownBalance,
      }));
      logger.info(`[relay] WebSocket relay on :${HEALTH_PORT}/ws, REST on :${HEALTH_PORT}/api/*`);
    }

    // Wire keeper rover TVL computation to relay
    this.keeper.onRoverTvlComputed = (entries) => {
      this.relay?.updateRoverTvl(entries.map(e => ({
        pool: e.pool,
        tokenXSymbol: '',
        tokenYSymbol: '',
        tvl: e.tvl,
        positionCount: e.positionCount,
        status: e.status as any,
      })));
    };

    logger.info(`keeper: ${KEEPER_ACTIVE_INTERVAL_MS / 1000}s (idle) / ${KEEPER_PROCESSING_INTERVAL_MS / 1000}s (processing)`);
    logger.info(`safety: ${SAFETY_POLL_INTERVAL_MS / 1000}s fallback poll`);
    logger.info('---');

    // Start gRPC subscriber for real-time harvest monitoring
    await this.subscriber.start();

    // Wire subscriber health alerts
    this.subscriber.on('disconnected', () => alertGrpcDisconnect());
    this.subscriber.on('reconnected', () => alertGrpcReconnect());

    // Wire subscriber events to executor
    this.subscriber.on('harvestNeeded', (job: HarvestJob) => {
      this.lastHarvestAt = Date.now();
      this.executor.enqueue(job);
    });

    // Wire executor events to relay
    this.executor.on('harvestExecuted', (data: any) => {
      this.relay?.broadcast('harvestExecuted', data);
    });
    this.executor.on('positionClosed', (data: any) => {
      this.relay?.broadcast('positionClosed', data);
    });

    // Discord bot — starts if DISCORD_TOKEN is set
    if (process.env.DISCORD_TOKEN) {
      try {
        const { DiscordBot } = await import('../packages/discord-bot/src/index');
        const discordBot = new DiscordBot({
          executor: this.executor,
          subscriber: this.subscriber,
          connection: this.connection,
          coreProgram: this.coreProgram,
          coreProgramId: CORE_PROGRAM_ID,
        });
        this.executor.on('harvestExecuted', (data: any) => {
          discordBot.notifier.onHarvestExecuted(data);
        });
        this.executor.on('positionClosed', (data: any) => {
          discordBot.notifier.onPositionClosed(data);
        });
        await discordBot.start();
        this.executor.setWalletService(discordBot.walletService);
        this.keeper.setWalletService(discordBot.walletService);
        initAlerter((text) => discordBot.notifier.postToFeed(text));
        logger.info('[discord] Bot started');
      } catch (e: any) {
        logger.warn(`[discord] Failed to start: ${e.message}`);
      }
    }

    // Price syncer — arb bot for low-liquidity pools
    if (SYNC_ENABLED) {
      try {
        const curatorPath = path.join(__dirname, '..', 'curator.json');
        const curatorData = JSON.parse(fs.readFileSync(curatorPath, 'utf-8'));
        const syncPools: SyncPoolConfig[] = curatorData.pools
          .filter((p: any) => p.syncEnabled === true)
          .map((p: any) => ({
            address: p.address,
            label: p.label,
            mintX: p.mintX,
            mintY: p.mintY,
            decimalsX: p.decimalsX,
            decimalsY: p.decimalsY,
            binStep: p.binStep,
          }));

        if (syncPools.length > 0) {
          this.syncer = new PriceSyncer({
            connection: this.connection,
            botKeypair,
            subscriber: this.subscriber,
            syncPools,
            intervalMs: SYNC_INTERVAL_MS,
            divergenceThresholdPct: SYNC_DIVERGENCE_THRESHOLD_PCT,
            minProfitLamports: SYNC_MIN_PROFIT_LAMPORTS,
            maxSwapLamports: Math.floor(SYNC_MAX_SWAP_SOL * 1e9),
            dryRun: SYNC_DRY_RUN,
          });

          this.syncer.on('syncExecuted', (data: any) => {
            this.relay?.broadcast('syncExecuted', data);
          });
          this.syncer.on('divergenceDetected', (data: any) => {
            this.relay?.broadcast('divergenceDetected', data);
          });

          this.relay?.setSyncerStatsProvider(() => this.syncer!.getStats());
          await this.syncer.start();
          logger.info(`[syncer] Price syncer started: ${syncPools.length} pool(s), interval=${SYNC_INTERVAL_MS}ms, dryRun=${SYNC_DRY_RUN}`);
        } else {
          logger.info('[syncer] No sync-enabled pools in curator.json — syncer disabled');
        }
      } catch (e: any) {
        logger.warn(`[syncer] Failed to start: ${e.message}`);
      }
    } else {
      logger.info('[syncer] Price syncer disabled (SYNC_ENABLED != true)');
    }

    // Start safety-net polling (5 min fallback for harvests)
    this.subscriber.startSafetyPolling(() => this.safetyPoll());

    // Keeper: adaptive interval — 30s during daily processing, 1hr during idle
    const scheduleKeeper = async () => {
      if (this.shuttingDown) return;
      try {
        this.lastKeeperRunAt = Date.now();
        // Refresh bot SOL balance on each keeper tick
        try {
          const bal = await this.connection.getBalance(botKeypair.publicKey);
          this.lastKnownBalance = bal;
          this.recordBalance(bal);
          if (bal < SOL_BALANCE_CRITICAL) {
            logger.error(`[bot] CRITICAL: Bot SOL balance ${bal / 1e9} SOL — below ${SOL_BALANCE_CRITICAL / 1e9} threshold`);
            alertLowBalance(bal / 1e9);
          } else if (bal < SOL_BALANCE_WARN) {
            logger.warn(`[bot] WARNING: Bot SOL balance ${bal / 1e9} SOL — below ${SOL_BALANCE_WARN / 1e9} threshold`);
            alertLowBalance(bal / 1e9);
          }
        } catch (e: any) {
          logger.warn(`[bot] Failed to fetch SOL balance: ${e.message}`);
        }
        const phase = await this.keeper.runDailySequence();
        const nextInterval = phase === 'Idle'
          ? KEEPER_ACTIVE_INTERVAL_MS
          : KEEPER_PROCESSING_INTERVAL_MS;
        this.keeperTimer = setTimeout(() => scheduleKeeper(), nextInterval);
      } catch (e: any) {
        logger.error(`[keeper] Error: ${e.message}`);
        alertKeeperFailure('daily_sequence', e.message);
        // On error, retry at processing speed
        this.keeperTimer = setTimeout(() => scheduleKeeper(), KEEPER_PROCESSING_INTERVAL_MS);
      }
    };

    // Run keeper once on startup to catch any pending phase
    await scheduleKeeper();

    logger.info('Bot running — gRPC harvests + daily fee sequence');
  }
}

// ═══ ENTRY ═══

new HarvestBot().run().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
