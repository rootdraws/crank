# crankbot-pool-routing.md
# Addendum to crankbot.md — Pool Routing + Display Mode Implementation
# For Cursor Claude: read this alongside crankbot.md

---

## COMMAND SYNTAX (canonical)

```
/crankbuy  TOKEN HIGH to LOW  AMOUNT QUOTE
/cranksell TOKEN LOW  to HIGH AMOUNT QUOTE
/crankarb  TOKEN LOW% to HIGH% AMOUNT QUOTE
```

Buy:  range goes HIGH → LOW  (accumulating on the way down)
Sell: range goes LOW  → HIGH (exiting on the way up)
Arb:  range expressed as % offset from peg

Parsed as:
```typescript
interface ParsedCommand {
  action:     'buy' | 'sell' | 'arb';
  token:      string;           // "SOL", "CRANK", "BUTT"
  rangeHigh:  string;           // "84", "22mc", "-0.5%"
  rangeLow:   string;           // "74", "11mc", "-1.5%"
  amount:     number;
  quote:      string;           // "USDC", "SOL"
}
```

---

## POOL CONFIG TYPE (TypeScript)

```typescript
// packages/core-sdk/pool-config.ts

export type DisplayMode = 'price' | 'mc' | 'pct';
export type SplitStrategy = 'auto' | 'reject';

export interface PoolConfig {
  id: string;
  label: string;
  address: string;
  binStep: number;

  tokenX: string;           // symbol
  tokenY: string;
  mintX: string;
  mintY: string;
  decimalsX: number;
  decimalsY: number;

  displayMode: DisplayMode;
  supply?: number;          // REQUIRED for mc mode. Set by Root. Never auto-fetched.
  pegToken?: string;        // REQUIRED for pct mode. Reference asset symbol.

  splitStrategy: SplitStrategy;
  maxRangePct: number;      // precomputed: ((1 + binStep/10000)^70 - 1) * 100

  buyToken: string;         // token accumulated on buy side
  quoteToken: string;       // token spent on buy side

  notes?: string;
}
```

---

## RANGE PARSING

```typescript
// packages/core-sdk/range-parser.ts

export type RangeInput =
  | { type: 'price'; value: number }
  | { type: 'mc';    value: number }   // in dollars e.g. 22_000_000
  | { type: 'pct';   value: number }   // as decimal e.g. -0.005

/**
 * Parse a range endpoint string from user input.
 * "84"       → { type: 'price', value: 84 }
 * "22mc"     → { type: 'mc',    value: 22_000_000 }
 * "2.5M"     → { type: 'mc',    value: 2_500_000 }
 * "500K"     → { type: 'mc',    value: 500_000 }
 * "-1.5%"    → { type: 'pct',   value: -0.015 }
 * "0%"       → { type: 'pct',   value: 0 }
 */
export function parseRangeInput(raw: string): RangeInput | null {
  const s = raw.trim().toLowerCase();

  // Percentage: "-1.5%" or "0%"
  if (s.endsWith('%')) {
    const val = parseFloat(s.slice(0, -1));
    if (isNaN(val)) return null;
    return { type: 'pct', value: val / 100 };
  }

  // Market cap: "22mc", "22M", "500K", "2.5B"
  // Accept "mc" suffix OR bare M/K/B with no "mc" suffix
  const mcMatch = s.match(/^(\d+(?:\.\d+)?)(k|m|b)?mc$/) ||
                  s.match(/^(\d+(?:\.\d+)?)(k|m|b)$/);
  if (mcMatch) {
    const base = parseFloat(mcMatch[1]);
    const mult: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
    const multiplier = mcMatch[2] ? (mult[mcMatch[2]] ?? 1) : 1;
    return { type: 'mc', value: base * multiplier };
  }

  // Plain price: "84", "97.43", "0.0000089"
  const val = parseFloat(s);
  if (!isNaN(val) && val > 0) return { type: 'price', value: val };

  return null;
}

/**
 * Convert a RangeInput to an absolute price in dollars.
 */
export function rangeInputToPrice(
  input: RangeInput,
  pool: PoolConfig,
  currentPrice: number  // current price from on-chain
): number {
  switch (input.type) {
    case 'price':
      return input.value;

    case 'mc':
      if (!pool.supply) throw new Error(`Pool ${pool.id} missing supply for MC conversion`);
      return input.value / pool.supply;

    case 'pct':
      // pegToken price = currentPrice when pegToken === tokenX
      // For cross-asset peg: fetch reference asset price separately (future)
      return currentPrice * (1 + input.value);
  }
}
```

---

## ROUTING LOGIC

```typescript
// packages/core-sdk/pool-router.ts

import { PoolConfig, RangeInput, rangeInputToPrice, parseRangeInput } from './pool-config';
import { priceToBin } from './math';

export interface RouteResult {
  pool: PoolConfig;
  positions: Array<{ minBinId: number; maxBinId: number; depositFraction: number }>;
  // depositFraction: fraction of total amount for this position (sums to 1.0)
}

export interface RouteError {
  error: string;
  suggestion?: string;
}

/**
 * Find the best pool and compute position ranges for a buy command.
 * Returns RouteResult on success, RouteError on failure.
 */
export function routeBuyCommand(
  tokenSymbol: string,
  quoteSymbol: string,
  rawHigh: string,
  rawLow: string,
  currentPrice: number,
  pools: PoolConfig[]
): RouteResult | RouteError {

  // 1. Find candidate pools
  const candidates = pools.filter(
    p => p.buyToken.toUpperCase() === tokenSymbol.toUpperCase() &&
         p.quoteToken.toUpperCase() === quoteSymbol.toUpperCase()
  );

  if (candidates.length === 0) {
    return {
      error: `No pool found for ${tokenSymbol}/${quoteSymbol}.`,
      suggestion: 'Use /pools to see covered pairs.',
    };
  }

  // 2. Parse range inputs
  const highInput = parseRangeInput(rawHigh);
  const lowInput  = parseRangeInput(rawLow);
  if (!highInput || !lowInput) {
    return { error: 'Could not parse range. Examples: "84", "22mc", "-1%"' };
  }

  // 3. Convert to prices using the first candidate's config (for mc/pct)
  // All candidates for same token pair share same supply/peg, so this is fine.
  const ref = candidates[0];
  const priceHigh = rangeInputToPrice(highInput, ref, currentPrice);
  const priceLow  = rangeInputToPrice(lowInput,  ref, currentPrice);

  if (priceHigh <= priceLow) {
    return { error: 'High price must be greater than low price.' };
  }

  // 4. Try each candidate, pick best fit
  // "Best fit" = covers range in fewest positions, preferring lower binStep
  let bestPool: PoolConfig | null = null;
  let bestPositions: Array<{ minBinId: number; maxBinId: number; depositFraction: number }> | null = null;
  let bestPositionCount = Infinity;

  for (const pool of candidates) {
    const result = computePositionRanges(priceHigh, priceLow, pool, currentPrice);
    if ('error' in result) continue;

    // Prefer fewer positions; break ties by lower binStep
    const count = result.length;
    if (count < bestPositionCount ||
       (count === bestPositionCount && pool.binStep < (bestPool?.binStep ?? Infinity))) {
      bestPool = pool;
      bestPositions = result;
      bestPositionCount = count;
    }
  }

  if (!bestPool || !bestPositions) {
    // All pools rejected — find the widest pool and tell user max range
    const widest = candidates.sort((a, b) => b.binStep - a.binStep)[0];
    return {
      error: `Range too wide for available pools.`,
      suggestion: `Max range for ${tokenSymbol}/${quoteSymbol}: ${widest.maxRangePct.toFixed(1)}%`,
    };
  }

  return { pool: bestPool, positions: bestPositions };
}

/**
 * Compute position ranges for a given price range and pool.
 * Returns array of positions (split if needed) or error.
 */
function computePositionRanges(
  priceHigh: number,
  priceLow: number,
  pool: PoolConfig,
  currentPrice: number
): Array<{ minBinId: number; maxBinId: number; depositFraction: number }> | { error: string } {

  const MAX_BINS = 70;
  const MAX_POSITIONS = 5; // sanity cap

  // Compute bins for the full range
  const binHigh = priceToBin(priceHigh, pool.binStep, pool.decimalsX, pool.decimalsY, false);
  const binLow  = priceToBin(priceLow,  pool.binStep, pool.decimalsX, pool.decimalsY, true);

  if (binLow >= binHigh) {
    return { error: 'Range too narrow — prices resolve to the same bin.' };
  }

  const totalBins = binHigh - binLow + 1;

  if (totalBins <= MAX_BINS) {
    // Single position
    return [{ minBinId: binLow, maxBinId: binHigh, depositFraction: 1.0 }];
  }

  // Need to split
  if (pool.splitStrategy === 'reject') {
    return { error: `Range requires split but pool ${pool.id} has splitStrategy=reject.` };
  }

  // Auto-split into chunks of MAX_BINS
  const positions: Array<{ minBinId: number; maxBinId: number; depositFraction: number }> = [];
  for (let b = binLow; b <= binHigh; b += MAX_BINS) {
    positions.push({
      minBinId: b,
      maxBinId: Math.min(b + MAX_BINS - 1, binHigh),
      depositFraction: 0, // computed below
    });
  }

  if (positions.length > MAX_POSITIONS) {
    return { error: `Range requires ${positions.length} positions (max ${MAX_POSITIONS}). Narrow your range.` };
  }

  // Split deposit evenly across positions
  const fraction = 1.0 / positions.length;
  positions.forEach(p => p.depositFraction = fraction);

  return positions;
}
```

---

## DISPLAY MODE RENDERING

```typescript
// packages/telegram-bot/src/display.ts

import { PoolConfig } from '@crankbot/core-sdk';
import { binToPrice } from '@crankbot/core-sdk';

/**
 * Format a price value for display according to pool's display mode.
 */
export function formatRangeValue(
  price: number,
  pool: PoolConfig
): string {
  switch (pool.displayMode) {
    case 'mc': {
      if (!pool.supply) return `$${price.toFixed(8)}`;
      const mc = price * pool.supply;
      return formatMC(mc);
    }
    case 'pct': {
      // TODO: requires reference price — compute offset %
      return `$${price.toFixed(6)}`;
    }
    case 'price':
    default:
      return `$${formatPrice(price)}`;
  }
}

export function formatMC(mc: number): string {
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`;
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(1)}M`;
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(0)}K`;
  return `$${mc.toFixed(0)}`;
}

function formatPrice(p: number): string {
  if (p >= 1_000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 1)     return p.toFixed(2);
  if (p >= 0.001) return p.toFixed(4);
  return p.toPrecision(4);
}

/**
 * Build the position confirmation message shown after opening.
 */
export function renderOpenConfirmation(params: {
  pool: PoolConfig;
  side: 'buy' | 'sell';
  priceHigh: number;
  priceLow: number;
  currentPrice: number;
  amount: number;
  quoteSymbol: string;
  positionCount: number;
  baseApr?: number;
  emissionsApr?: number;
}): string {
  const highStr = formatRangeValue(params.priceHigh, params.pool);
  const lowStr  = formatRangeValue(params.priceLow,  params.pool);
  const curStr  = formatRangeValue(params.currentPrice, params.pool);

  const isBuy = params.side === 'buy';
  const inRange = isBuy
    ? params.currentPrice <= params.priceHigh && params.currentPrice >= params.priceLow
    : params.currentPrice >= params.priceLow  && params.currentPrice <= params.priceHigh;

  const priceStatus = inRange
    ? `in range`
    : isBuy
      ? `${curStr} (above range, waiting)`
      : `${curStr} (below range, waiting)`;

  const bar = '░'.repeat(20);

  let aprLine = '';
  if (params.baseApr !== undefined || params.emissionsApr !== undefined) {
    const base = params.baseApr ?? 0;
    const emit = params.emissionsApr ?? 0;
    aprLine = `\nAPR: ${(base + emit).toFixed(1)}% (LP ${base.toFixed(1)}% + Emissions ${emit.toFixed(1)}%)`;
  }

  const splitNote = params.positionCount > 1
    ? `\n_Split into ${params.positionCount} positions_`
    : '';

  return (
    `✅ ${isBuy ? 'BUY' : 'SELL'} ${params.pool.tokenX} — ${lowStr} to ${highStr}\n\n` +
    `\`[${bar}] waiting\`\n` +
    `Current: ${priceStatus}\n\n` +
    `Depositing: ${params.amount} ${params.quoteSymbol}${aprLine}${splitNote}`
  );
}

/**
 * Build the split confirmation message (shown BEFORE multi-tx opens).
 * User must reply Y to proceed.
 */
export function renderSplitConfirmation(params: {
  pool: PoolConfig;
  side: 'buy' | 'sell';
  positions: Array<{ minBinId: number; maxBinId: number; depositFraction: number }>;
  totalAmount: number;
  quoteSymbol: string;
}): string {
  const lines = params.positions.map((p, i) => {
    const low  = binToPrice(p.minBinId, params.pool.binStep, params.pool.decimalsX, params.pool.decimalsY);
    const high = binToPrice(p.maxBinId, params.pool.binStep, params.pool.decimalsX, params.pool.decimalsY);
    const amt  = (params.totalAmount * p.depositFraction).toFixed(2);
    return `  Pos ${i + 1}: ${formatRangeValue(low, params.pool)} → ${formatRangeValue(high, params.pool)}  (${amt} ${params.quoteSymbol})`;
  });

  return (
    `${params.pool.label} — range requires ${params.positions.length} positions\n\n` +
    lines.join('\n') +
    `\n\nTotal: ${params.totalAmount} ${params.quoteSymbol} · ${params.positions.length} transactions\n\n` +
    `_Reply Y to confirm, N to cancel._`
  );
}
```

---

## WHERE THESE FILES GO

```
packages/
  core-sdk/
    pool-config.ts      ← PoolConfig interface
    range-parser.ts     ← parseRangeInput, rangeInputToPrice
    pool-router.ts      ← routeBuyCommand, computePositionRanges
    index.ts            ← add exports for above

  telegram-bot/src/
    display.ts          ← formatRangeValue, renderOpenConfirmation, renderSplitConfirmation
    pool-registry.ts    ← loads curator.md (or a JSON version) at startup
```

## LOADING curator.md AT RUNTIME

The bot doesn't parse markdown. Root maintains a parallel `curator.json` that mirrors `curator.md`. `curator.md` is the human-readable document. `curator.json` is the machine-readable version the bot actually loads.

Whenever Root updates `curator.md`, they also update `curator.json`.

```typescript
// packages/telegram-bot/src/pool-registry.ts

import * as fs from 'fs';
import * as path from 'path';
import { PoolConfig } from '@crankbot/core-sdk';

export function loadPoolRegistry(configPath?: string): PoolConfig[] {
  const filePath = configPath
    || process.env.POOL_CONFIG_PATH
    || path.join(__dirname, '..', 'curator.json');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Pool config not found: ${filePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return raw.pools as PoolConfig[];
}
```

`curator.json` is the same data as `curator.md` pools section, just JSON. The `.md` is for Root to think in. The `.json` is for the bot to execute from.
