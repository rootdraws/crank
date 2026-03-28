/**
 * discord-bot/src/parse-range.ts
 *
 * Parses the freeform range string from /buy and /sell commands.
 * Accepts: TOKEN PRICE to PRICE AMOUNT QUOTE
 * Order-agnostic — both prices are returned unsorted, caller sorts.
 *
 * Examples:
 *   "SOL 84 to 74 1000 USDC"       -> { token: "SOL", priceA: 84, priceB: 74, amount: 1000, quote: "USDC" }
 *   "SOL 74 to 84 1000 USDC"       -> { token: "SOL", priceA: 74, priceB: 84, amount: 1000, quote: "USDC" }
 *   "CRANK 45mmc to 22mmc 2 SOL"   -> TODO: mc mode parsing
 */

export interface ParsedRange {
  token: string;
  priceA: number;
  priceB: number;
  amount: number;
  quote: string;
}

export function parseRange(input: string): ParsedRange | null {
  const parts = input.trim().split(/\s+/);

  // Expected: TOKEN PRICE_A to PRICE_B AMOUNT QUOTE
  // Minimum 6 parts, "to" at index 2
  const toIdx = parts.findIndex(p => p.toLowerCase() === 'to');
  if (toIdx < 2 || toIdx >= parts.length - 2) {
    // Try without "to": TOKEN PRICE_A PRICE_B AMOUNT QUOTE (5 parts)
    if (parts.length >= 5) {
      const token = parts[0];
      const priceA = parseFloat(parts[1]);
      const priceB = parseFloat(parts[2]);
      const amount = parseFloat(parts[3]);
      const quote = parts[4];
      if (!isNaN(priceA) && !isNaN(priceB) && !isNaN(amount) && amount > 0) {
        return { token, priceA, priceB, amount, quote };
      }
    }
    return null;
  }

  const token = parts.slice(0, toIdx - 1).join(' ') || parts[0];
  const priceAStr = parts[toIdx - 1];
  const priceBStr = parts[toIdx + 1];

  const remaining = parts.slice(toIdx + 2);
  if (remaining.length < 2) return null;

  const amount = parseFloat(remaining[0]);
  const quote = remaining[1];

  const priceA = parseFloat(priceAStr);
  const priceB = parseFloat(priceBStr);

  if (isNaN(priceA) || isNaN(priceB) || isNaN(amount) || amount <= 0) return null;
  if (priceA <= 0 || priceB <= 0) return null;

  return { token: parts[0], priceA, priceB, amount, quote };
}
