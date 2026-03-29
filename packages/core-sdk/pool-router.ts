/**
 * core-sdk/pool-router.ts
 *
 * Multi-pool routing with auto-split. Given a token pair and price range,
 * finds the best pool (fewest positions, lowest binStep tiebreaker) and
 * computes position ranges.
 */

import type { PoolConfig } from './pool-config';
import { priceToBin } from './math';
import { RangeInput, rangeInputToPrice } from './range-parser';

const MAX_BINS = 70;
const MAX_POSITIONS = 5;

export interface PositionRange {
  minBinId: number;
  maxBinId: number;
  depositFraction: number;
}

export interface RouteResult {
  pool: PoolConfig;
  positions: PositionRange[];
  priceLow: number;
  priceHigh: number;
}

export interface RouteError {
  error: string;
  suggestion?: string;
}

export function isRouteError(r: RouteResult | RouteError): r is RouteError {
  return 'error' in r;
}

/**
 * Route a buy or sell command to the best pool.
 */
export function routeCommand(
  tokenSymbol: string,
  quoteSymbol: string,
  rangeA: RangeInput,
  rangeB: RangeInput,
  currentPrice: number,
  pools: PoolConfig[],
  quoteTokenUsdPrice: number = 1.0,
): RouteResult | RouteError {
  // Find candidate pools matching this token pair
  const candidates = pools.filter(
    p => p.buyToken.toUpperCase() === tokenSymbol.toUpperCase() &&
         p.quoteToken.toUpperCase() === quoteSymbol.toUpperCase() &&
         p.address.length > 0
  );

  if (candidates.length === 0) {
    return {
      error: `No pool found for ${tokenSymbol}/${quoteSymbol}.`,
      suggestion: 'Use /pools to see covered pairs.',
    };
  }

  // Convert range inputs to prices using the first candidate for mc/supply context
  // (all candidates for same pair share the same supply)
  const ref = candidates[0];
  let priceA: number;
  let priceB: number;
  try {
    priceA = rangeInputToPrice(rangeA, ref, currentPrice);
    priceB = rangeInputToPrice(rangeB, ref, currentPrice);
  } catch (e: any) {
    return { error: e.message };
  }

  // Convert USD prices to DLMM-native prices (quote token units per base token).
  // For USDC pools: quoteTokenUsdPrice=1.0, no-op. For SOL pools: divides by SOL/USD.
  priceA = priceA / quoteTokenUsdPrice;
  priceB = priceB / quoteTokenUsdPrice;

  const priceLow = Math.min(priceA, priceB);
  const priceHigh = Math.max(priceA, priceB);

  if (priceLow <= 0 || priceHigh <= 0) {
    return { error: 'Prices must be positive.' };
  }

  if (priceLow === priceHigh) {
    return { error: 'Range endpoints resolve to the same price.' };
  }

  // Try each candidate, pick best fit: fewest positions, lowest binStep tiebreaker
  let bestPool: PoolConfig | null = null;
  let bestPositions: PositionRange[] | null = null;
  let bestCount = Infinity;

  for (const pool of candidates) {
    const result = computePositionRanges(priceHigh, priceLow, pool);
    if (!result) continue;

    if (result.length < bestCount ||
       (result.length === bestCount && pool.binStep < (bestPool?.binStep ?? Infinity))) {
      bestPool = pool;
      bestPositions = result;
      bestCount = result.length;
    }
  }

  if (!bestPool || !bestPositions) {
    const widest = candidates.sort((a, b) => b.maxRangePct - a.maxRangePct)[0];
    return {
      error: 'Range too wide for available pools.',
      suggestion: `Max single-position range: ${widest.maxRangePct.toFixed(1)}% (${widest.label})`,
    };
  }

  return { pool: bestPool, positions: bestPositions, priceLow, priceHigh };
}

/**
 * Compute position ranges for a given price range on a specific pool.
 * Returns null if the range can't fit (too many positions or rejected split).
 */
function computePositionRanges(
  priceHigh: number,
  priceLow: number,
  pool: PoolConfig,
): PositionRange[] | null {
  const binHigh = priceToBin(priceHigh, pool.binStep, pool.decimalsX, pool.decimalsY, false);
  const binLow = priceToBin(priceLow, pool.binStep, pool.decimalsX, pool.decimalsY, true);

  if (binLow >= binHigh) return null;

  const totalBins = binHigh - binLow + 1;

  // Single position
  if (totalBins <= MAX_BINS) {
    return [{ minBinId: binLow, maxBinId: binHigh, depositFraction: 1.0 }];
  }

  // Needs split
  if (pool.splitStrategy === 'reject') return null;

  const positions: PositionRange[] = [];
  for (let b = binLow; b <= binHigh; b += MAX_BINS) {
    positions.push({
      minBinId: b,
      maxBinId: Math.min(b + MAX_BINS - 1, binHigh),
      depositFraction: 0,
    });
  }

  if (positions.length > MAX_POSITIONS) return null;

  const fraction = 1.0 / positions.length;
  for (const p of positions) p.depositFraction = fraction;

  return positions;
}
