/**
 * core-sdk/pool-config.ts
 *
 * PoolConfig type and loader for curator.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type DisplayMode = 'price' | 'mc' | 'pct';
export type SplitStrategy = 'auto' | 'reject';

export interface PoolConfig {
  id: string;
  label: string;
  address: string;
  binStep: number;

  tokenX: string;
  tokenY: string;
  mintX: string;
  mintY: string;
  decimalsX: number;
  decimalsY: number;

  displayMode: DisplayMode;
  supply?: number;
  pegToken?: string;

  priceSource?: 'self' | 'dexscreener';  // self = read from DLMM activeId (default), dexscreener = external API

  splitStrategy: SplitStrategy;
  maxRangePct: number;

  buyToken: string;
  quoteToken: string;

  example?: string;

  syncEnabled?: boolean;
}

let cachedRaw: any = null;

function loadRaw(configPath?: string): any {
  if (cachedRaw) return cachedRaw;

  const filePath = configPath
    || process.env.POOL_CONFIG_PATH
    || path.resolve(__dirname, '..', '..', 'curator.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Pool config not found: ${filePath}`);
  }

  cachedRaw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return cachedRaw;
}

export function loadPoolRegistry(configPath?: string): PoolConfig[] {
  return loadRaw(configPath).pools as PoolConfig[];
}

/**
 * Override the `supply` field on all mc-mode pools sharing a base mint.
 * Used by the keeper's daily supply-refresh step to keep mcap math honest
 * as CRANK gets burned (rover_burn_and_mint). In-memory only — does not
 * write back to curator.json.
 */
export function setPoolSupply(mintAddress: string, humanSupply: number): number {
  const raw = loadRaw();
  let touched = 0;
  for (const p of raw.pools as PoolConfig[]) {
    if (p.displayMode !== 'mc') continue;
    if (p.mintX === mintAddress || p.mintY === mintAddress) {
      p.supply = humanSupply;
      touched++;
    }
  }
  return touched;
}

/**
 * Load gauge map: token symbol → LbPair address.
 * One gauge per trading pair. Used by /vote to resolve token names to
 * the on-chain PoolGauge PDA. Bin step pools are a routing detail —
 * the gauge represents the pair.
 */
export function loadGauges(configPath?: string): Record<string, string> {
  return loadRaw(configPath).gauges ?? {};
}

export function clearPoolCache(): void {
  cachedRaw = null;
}
