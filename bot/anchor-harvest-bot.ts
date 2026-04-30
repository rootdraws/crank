/**
 * anchor-harvest-bot.ts
 *
 * crank.money orchestrator. Wires together:
 *   - GeyserSubscriber: gRPC stream for real-time DLMM position monitoring
 *   - HarvestExecutor: job queue for harvest/close transactions
 *   - MonkeKeeper: daily orchestration (Discord role prune, supply refresh, stats post)
 *
 * The bot is a stateless operator — never custodies user funds. User funds live
 * in PDA-derived UserVault accounts, withdrawable only to the registered owner.
 *
 * Post-2026-04-29 bin-farm cleanup: BANK distribution, Merkle epochs, and
 * rover/curve machinery are all retired. Protocol fees from harvest_bins flow
 * directly to Config.fee_dest (initial: bot keypair; later: Hopper PDA).
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
import { RelayServer } from './relay-server';
import { logger } from './logger';
import { getDLMMCacheSize, getDLMM } from './meteora-accounts';
import { initAlerter, alertLowBalance, alertGrpcDisconnect, alertGrpcReconnect, alertKeeperFailure } from './alerter';

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

const COMMITMENT: Commitment    = 'confirmed';
const KEEPER_ACTIVE_INTERVAL_MS = parseInt(process.env.KEEPER_CHECK_INTERVAL_MS || '3600000'); // 1hr during Active
const KEEPER_PROCESSING_INTERVAL_MS = 30_000; // 30s during daily processing
const SAFETY_POLL_INTERVAL_MS   = 5 * 1000; // 5 seconds

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8080');
// Validate parsed lamport values are within safe integer range
const SOL_BALANCE_WARN = parseInt(process.env.SOL_BALANCE_WARN_LAMPORTS || '1000000000'); // 1 SOL
const SOL_BALANCE_CRITICAL = parseInt(process.env.SOL_BALANCE_CRITICAL_LAMPORTS || '100000000'); // 0.1 SOL
if (!Number.isSafeInteger(SOL_BALANCE_WARN)) { logger.warn(`SOL_BALANCE_WARN exceeds safe integer range`); }
if (!Number.isSafeInteger(SOL_BALANCE_CRITICAL)) { logger.warn(`SOL_BALANCE_CRITICAL exceeds safe integer range`); }

// ═══ SYNCER CONFIG ═══

// ═══ RETRY ═══

import { withRetry } from './retry';

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
  private hopperProgram: Program | null = null;
  private hopperProgramId: PublicKey | null = null;
  private feeDest!: PublicKey;

  // Modules
  private subscriber!: GeyserSubscriber;
  private executor!: HarvestExecutor;
  private keeper!: MonkeKeeper;
  private relay!: RelayServer;

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

    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT',  () => this.shutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
      logger.error(`Uncaught exception: ${err.message}`);
      this.shutdown(`uncaughtException: ${err.message}`);
    });
    process.on('unhandledRejection', (reason: any) => {
      logger.error(`Unhandled rejection: ${reason?.message || reason}`);
      this.shutdown(`unhandledRejection: ${reason?.message || reason}`);
    });
  }

  private async shutdown(reason = 'unknown') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info(`\nShutting down (${reason})...`);

    // Fire death alert before anything else (best-effort, non-blocking timeout)
    if (reason !== 'SIGTERM' && reason !== 'SIGINT') {
      try {
        const { alertProcessDeath } = await import('./alerter');
        await Promise.race([
          alertProcessDeath(reason),
          new Promise(r => setTimeout(r, 3000)),
        ]);
      } catch (e: any) {
        logger.warn(`[shutdown] Death alert failed: ${e.message?.slice(0, 80)}`);
      }
    }

    if (this.keeperTimer) clearTimeout(this.keeperTimer);
    if (this.healthServer) this.healthServer.close();


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

    // Hopper program is optional — only required for the keeper sweep step.
    // If the IDL is missing, sweep step skips silently.
    let hopperProgram: Program | null = null;
    let hopperProgramId: PublicKey | null = null;
    try {
      const hopperIdl = loadIdl('hopper');
      hopperProgram = new Program(hopperIdl, this.provider);
      hopperProgramId = new PublicKey(hopperIdl.address);
      logger.info(`hopper: ${hopperProgramId.toBase58()}`);
    } catch (e: any) {
      logger.warn(`hopper IDL missing — sweep step disabled: ${e.message?.slice(0, 80)}`);
    }
    this.hopperProgram = hopperProgram;
    this.hopperProgramId = hopperProgramId;

    // Verify bot authorization + resolve fee_dest
    const [configPDA] = coreConfigPDA();
    const config = await this.coreProgram.account.config.fetch(configPDA);
    if (!config.bot.equals(botKeypair.publicKey)) {
      throw new Error(`Bot key mismatch. Config expects: ${config.bot.toBase58()}`);
    }
    logger.info('Bot authorized ✓');

    // Resolve effective fee destination. config.fee_dest defaults to Pubkey::default(),
    // which on-chain falls back to config.bot. The bot mirrors that fallback locally
    // so harvest tx accounts match what the on-chain check expects. When admin retargets
    // to the Hopper PDA via set_fee_dest, restart the bot to pick it up.
    const DEFAULT_PUBKEY = new PublicKey('11111111111111111111111111111111');
    this.feeDest = (config.feeDest && !config.feeDest.equals(DEFAULT_PUBKEY))
      ? config.feeDest
      : config.bot;
    logger.info(`fee_dest: ${this.feeDest.toBase58()} (${config.feeDest && !config.feeDest.equals(DEFAULT_PUBKEY) ? 'configured' : 'fallback to config.bot'})`);

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
      feeDest: this.feeDest,
    });

    this.keeper = new MonkeKeeper({
      connection: this.connection,
      coreProgram: this.coreProgram,
      botKeypair,
      coreProgramId: CORE_PROGRAM_ID,
      hopperProgram: this.hopperProgram,
      hopperProgramId: this.hopperProgramId,
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
          // Read activeId directly from on-chain bytes — not the DLMM SDK cache
          // which can be stale for up to 10 minutes.
          const poolInfo = await this.connection.getAccountInfo(new PublicKey(poolKey));
          if (!poolInfo || poolInfo.data.length < 80) continue;
          const activeId = poolInfo.data.readInt32LE(76);

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
    const owner = (data.userVault ?? data.owner) as PublicKey;

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
        const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], CORE_PROGRAM_ID);
        const discordBot = new DiscordBot({
          executor: this.executor,
          subscriber: this.subscriber,
          connection: this.connection,
          coreProgram: this.coreProgram,
          coreProgramId: CORE_PROGRAM_ID,
          botKeypair,
          configPDA,
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
        this.keeper.setDiscordClient(discordBot.client);
        initAlerter({
          postToFeed: (text) => discordBot.notifier.postToFeed(text),
          postToOps: (text) => discordBot.notifier.postToOps(text),
        });
        logger.info('[discord] Bot started');
      } catch (e: any) {
        logger.warn(`[discord] Failed to start: ${e.message}`);
      }
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
