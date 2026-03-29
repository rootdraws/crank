/**
 * core-sdk/range-parser.ts
 *
 * Parses range endpoints from user input. Supports price, mcap, and pct modes.
 * Replaces discord-bot/src/parse-range.ts for range endpoint parsing.
 */

import type { PoolConfig } from './pool-config';

export type RangeInput =
  | { type: 'price'; value: number }
  | { type: 'mc'; value: number }
  | { type: 'pct'; value: number };

/**
 * Parse a single range endpoint string.
 *
 * "84"       → { type: 'price', value: 84 }
 * "22mmc"    → { type: 'mc',    value: 22_000_000 }
 * "2.5mmc"   → { type: 'mc',    value: 2_500_000 }
 * "500kmc"   → { type: 'mc',    value: 500_000 }
 * "1.1bmc"   → { type: 'mc',    value: 1_100_000_000 }
 * "-1.5%"    → { type: 'pct',   value: -0.015 }
 */
export function parseRangeInput(raw: string): RangeInput | null {
  const s = raw.trim().toLowerCase();

  // Percentage: "-1.5%" or "0%"
  if (s.endsWith('%')) {
    const val = parseFloat(s.slice(0, -1));
    if (isNaN(val)) return null;
    return { type: 'pct', value: val / 100 };
  }

  // Market cap with "mc" suffix: "22mmc", "500kmc", "1.1bmc", "45mc"
  const mcMatch = s.match(/^(\d+(?:\.\d+)?)(k|m|b)?mc$/);
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
 * Convert a RangeInput to an absolute price.
 */
export function rangeInputToPrice(
  input: RangeInput,
  pool: PoolConfig,
  currentPrice: number,
): number {
  switch (input.type) {
    case 'price':
      return input.value;
    case 'mc':
      if (!pool.supply) throw new Error(`Pool ${pool.id} missing supply for MC conversion`);
      return input.value / pool.supply;
    case 'pct':
      return currentPrice * (1 + input.value);
  }
}

/**
 * Parse a full command range string.
 * "SOL 84 to 74 1000 USDC" → structured data
 * "CRANK 45mmc to 22mmc 2 SOL" → structured data with mc endpoints
 */
export interface ParsedCommand {
  token: string;
  rangeA: RangeInput;
  rangeB: RangeInput;
  amount: number;
  quote: string;
}

export function parseCommand(input: string): ParsedCommand | null {
  const parts = input.trim().split(/\s+/);

  const toIdx = parts.findIndex(p => p.toLowerCase() === 'to');
  if (toIdx < 2 || toIdx >= parts.length - 2) return null;

  const token = parts[0];
  const rangeAStr = parts[toIdx - 1];
  const rangeBStr = parts[toIdx + 1];

  const remaining = parts.slice(toIdx + 2);
  if (remaining.length < 2) return null;

  const amount = parseFloat(remaining[0]);
  const quote = remaining[1];

  if (isNaN(amount) || amount <= 0) return null;

  const rangeA = parseRangeInput(rangeAStr);
  const rangeB = parseRangeInput(rangeBStr);
  if (!rangeA || !rangeB) return null;

  return { token, rangeA, rangeB, amount, quote };
}
