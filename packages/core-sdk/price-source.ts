/**
 * core-sdk/price-source.ts
 *
 * External price fetching for tokens without reliable DLMM liquidity.
 * Per-mint cache with 10s TTL to avoid hammering DexScreener.
 */

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { data: { priceUsd: number; marketCap?: number }; ts: number }>();

export async function fetchDexScreenerPrice(mint: string): Promise<{ priceUsd: number; marketCap?: number } | null> {
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;
    const result = {
      priceUsd: parseFloat(pair.priceUsd),
      marketCap: pair.marketCap ? Number(pair.marketCap) : undefined,
    };
    cache.set(mint, { data: result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}
