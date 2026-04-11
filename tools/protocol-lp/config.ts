/**
 * tools/protocol-lp/config.ts
 *
 * Environment loading + validation.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const _require = createRequire(import.meta.url);
const dotenv = _require('dotenv');
const { PublicKey, Keypair } = _require('@solana/web3.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env — try protocol-lp local first, fall back to bot/.env
const localEnv = path.join(__dirname, '.env');
const botEnv = path.join(__dirname, '..', '..', 'bot', '.env');
dotenv.config({ path: fs.existsSync(localEnv) ? localEnv : botEnv });

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
  return val;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val === 'true' || val === '1';
}

// ─── Load keypair ─────────────────────────────────────────────────────

const keypairPath = process.env.KEYPAIR_PATH || path.join('/root/.keys', 'lp-keypair.json');

function loadKeypair(): typeof Keypair {
  if (!fs.existsSync(keypairPath)) {
    console.error(`Keypair not found: ${keypairPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ─── Strategy ─────────────────────────────────────────────────────────

const STRATEGY_MAP: Record<string, number> = {
  'Spot': 0,
  'Curve': 1,
  'BidAsk': 2,
};

const strategyName = process.env.REENTRY_STRATEGY || 'BidAsk';
if (!(strategyName in STRATEGY_MAP)) {
  console.error(`Invalid REENTRY_STRATEGY: ${strategyName}. Must be Spot, Curve, or BidAsk`);
  process.exit(1);
}

// ─── Pool address ─────────────────────────────────────────────────────

const poolAddress = process.env.POOL_ADDRESS || '9R9gcCqPazHZt217aqh3fYDNBGnqENcupWYd97LYiUDp';

// ─── Export ───────────────────────────────────────────────────────────

export const CONFIG = {
  RPC_URL: requireEnv('RPC_URL'),
  wallet: loadKeypair(),
  poolAddress: new PublicKey(poolAddress) as typeof PublicKey,
  poolAddressStr: poolAddress,

  reentryBinCount: envInt('REENTRY_BIN_COUNT', 70),
  reentryStrategy: STRATEGY_MAP[strategyName],
  reentryStrategyName: strategyName,

  minHarvestLamports: envInt('MIN_HARVEST_LAMPORTS', 10_000_000),        // 0.01 SOL
  minReentryLamports: envInt('MIN_REENTRY_LAMPORTS', 2_000_000_000),     // 2 SOL
  solReserveLamports: envInt('SOL_RESERVE_LAMPORTS', 50_000_000),        // 0.05 SOL

  pollIntervalMs: envInt('POLL_INTERVAL_MS', 30_000),
  pollFastMs: envInt('POLL_FAST_MS', 5_000),
  fastModeDurationMs: envInt('FAST_MODE_DURATION_MS', 120_000),

  healthPort: envInt('HEALTH_PORT', 8081),
  dryRun: envBool('DRY_RUN', true),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || null,
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;

// Validate
if (CONFIG.reentryBinCount > 70) {
  console.error('REENTRY_BIN_COUNT cannot exceed 70 (Meteora max position width)');
  process.exit(1);
}

if (CONFIG.dryRun) {
  console.log('⚠  DRY_RUN mode — no transactions will be submitted');
}
