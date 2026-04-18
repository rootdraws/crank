/**
 * core-sdk/math.ts
 *
 * Bin/price math and fee calculations.
 */

import { DEFAULT_FEE_BPS } from './constants';

/**
 * Convert bin ID to human-readable price.
 * decimalsX/Y normalize atomic price to human-readable units.
 */
export function binToPrice(
  binId: number,
  binStep: number,
  decimalsX = 0,
  decimalsY = 0
): number {
  const raw = Math.pow(1 + binStep / 10000, binId);
  return raw * Math.pow(10, decimalsX - decimalsY);
}

/**
 * Convert human-readable price to bin ID.
 * roundDown=true for buy side (floor), false for sell side (ceil).
 */
export function priceToBin(
  price: number,
  binStep: number,
  decimalsX = 0,
  decimalsY = 0,
  roundDown = true
): number {
  if (price <= 0) return NaN;
  const raw = price / Math.pow(10, decimalsX - decimalsY);
  const binId = Math.log(raw) / Math.log(1 + binStep / 10000);
  return roundDown ? Math.floor(binId) : Math.ceil(binId);
}

/**
 * Format a price for display (human-readable, adaptive precision).
 */
export function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1)    return price.toFixed(2);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toExponential(2);
}

/**
 * Format token amount from base units to human-readable.
 */
export function formatAmount(amount: bigint, decimals: number): string {
  const divisor = Math.pow(10, decimals);
  const value = Number(amount) / divisor;
  const fixed =
    value >= 1000 ? value.toFixed(2) :
    value >= 1    ? value.toFixed(4) :
                    value.toFixed(6);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/**
 * Calculate protocol fee on a given amount.
 * Returns fee in same units as amount.
 */
export function calculateFee(amount: bigint, feeBps = DEFAULT_FEE_BPS): bigint {
  return (amount * BigInt(feeBps)) / 10_000n;
}

/**
 * Calculate net amount after fee.
 */
export function calculateNet(amount: bigint, feeBps = DEFAULT_FEE_BPS): bigint {
  return amount - calculateFee(amount, feeBps);
}

/**
 * Convert a percentage offset to a bin range for buy/sell positions.
 *
 * Buy side:  range is X% to Y% BELOW current price
 * Sell side: range is X% to Y% ABOVE current price
 *
 * Returns { minBinId, maxBinId } — always minBinId <= maxBinId.
 * Caller must validate minBinId < activeBin (buy) or maxBinId > activeBin (sell).
 */
export function percentRangeToBins(
  nearPct: number,
  farPct: number,
  currentPrice: number,
  activeBinId: number,
  binStep: number,
  side: 'buy' | 'sell',
  decimalsX: number,
  decimalsY: number
): { minBinId: number; maxBinId: number } {
  let nearPrice: number;
  let farPrice: number;

  if (side === 'buy') {
    nearPrice = currentPrice * (1 - nearPct / 100);
    farPrice  = currentPrice * (1 - farPct  / 100);
  } else {
    nearPrice = currentPrice * (1 + nearPct / 100);
    farPrice  = currentPrice * (1 + farPct  / 100);
  }

  const binA = priceToBin(Math.min(nearPrice, farPrice), binStep, decimalsX, decimalsY, true);
  const binB = priceToBin(Math.max(nearPrice, farPrice), binStep, decimalsX, decimalsY, false);

  return { minBinId: binA, maxBinId: binB };
}

/**
 * Format elapsed time for display.
 */
export function formatAge(unixSeconds: number): string {
  const elapsed = Math.floor(Date.now() / 1000) - unixSeconds;
  if (elapsed < 60) return '<1m';
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`;
  const d = Math.floor(elapsed / 86400);
  const h = Math.floor((elapsed % 86400) / 3600);
  return `${d}d ${h}h`;
}
