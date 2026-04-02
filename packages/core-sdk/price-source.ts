/**
 * core-sdk/price-source.ts
 *
 * Price fetching. SOL/USD from Pyth Hermes (oracle, no contamination).
 * Other tokens from DexScreener with stablecoin pair + symbol consensus filters.
 */

import { NATIVE_MINT } from './constants';

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { data: { priceUsd: number; marketCap?: number }; ts: number }>();

// Pyth SOL/USD feed ID
const PYTH_SOL_USD = '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

const STABLECOIN_SYMBOLS = new Set(['USDC', 'USDT', 'USDS', 'USD1', 'DAI', 'PYUSD']);

/**
 * Fetch SOL/USD directly from Pyth oracle. No DexScreener, no FOGO.
 */
async function fetchSolPrice(): Promise<number | null> {
  try {
    const resp = await fetch(
      `https://hermes.pyth.network/api/latest_price_feeds?ids[]=${PYTH_SOL_USD}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const feed = data[0];
    if (!feed?.price) return null;
    return parseInt(feed.price.price) * Math.pow(10, parseInt(feed.price.expo));
  } catch {
    return null;
  }
}

export async function fetchDexScreenerPrice(mint: string): Promise<{ priceUsd: number; marketCap?: number } | null> {
  // SOL: use Pyth, not DexScreener
  if (mint === NATIVE_MINT.toBase58()) {
    const cached = cache.get(mint);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;
    const solPrice = await fetchSolPrice();
    if (solPrice && solPrice > 0) {
      const result = { priceUsd: solPrice };
      cache.set(mint, { data: result, ts: Date.now() });
      return result;
    }
    // Pyth failed — fall through to DexScreener as last resort
  }

  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const pairs = data.pairs;
    if (!pairs || pairs.length === 0) return null;

    const mintLower = mint.toLowerCase();

    // Filter to pairs where this mint is the base token
    const rawBasePairs = pairs.filter(
      (p: any) => p.baseToken?.address?.toLowerCase() === mintLower
    );

    // Find consensus symbol to filter out contamination (e.g. FOGO labeled as SOL)
    const symbolCounts = new Map<string, number>();
    for (const p of rawBasePairs) {
      const sym = p.baseToken?.symbol ?? '';
      symbolCounts.set(sym, (symbolCounts.get(sym) ?? 0) + 1);
    }
    let consensusSymbol = '';
    let maxCount = 0;
    for (const [sym, count] of symbolCounts) {
      if (count > maxCount) { consensusSymbol = sym; maxCount = count; }
    }

    const basePairs = consensusSymbol
      ? rawBasePairs.filter((p: any) => p.baseToken?.symbol === consensusSymbol)
      : rawBasePairs;

    if (basePairs.length === 0) {
      const fallback = pairs.sort((a: any, b: any) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
      if (!fallback) return null;
      const result = {
        priceUsd: parseFloat(fallback.priceUsd),
        marketCap: fallback.marketCap ? Number(fallback.marketCap) : undefined,
      };
      cache.set(mint, { data: result, ts: Date.now() });
      return result;
    }

    // Prefer stablecoin-quoted pairs for cleanest price
    const stablePairs = basePairs.filter(
      (p: any) => STABLECOIN_SYMBOLS.has(p.quoteToken?.symbol?.toUpperCase() ?? '')
    );

    const candidates = stablePairs.length > 0 ? stablePairs : basePairs;
    const bestPair = candidates.sort(
      (a: any, b: any) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0)
    )[0];

    if (!bestPair) return null;
    const result = {
      priceUsd: parseFloat(bestPair.priceUsd),
      marketCap: bestPair.marketCap ? Number(bestPair.marketCap) : undefined,
    };
    cache.set(mint, { data: result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}
