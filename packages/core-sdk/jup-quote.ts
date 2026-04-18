/**
 * core-sdk/jup-quote.ts
 *
 * Thin wrapper over Jupiter's v6 /quote API. Used to snapshot a "market buy/
 * sell right now" baseline at position-open time so we can compare against
 * the actual DLMM-routed yield once the position fully converts.
 *
 * Fails silently (returns null) — baseline is a flex, not a correctness input.
 */

const JUP_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
}

/**
 * Fetch a swap quote. `amount` is in raw input-mint units (lamports for SOL).
 * `slippageBps` defaults to 50 (0.5%) — only used for the quote's routing
 * decision, not baked into the output amount we return.
 */
export async function fetchJupQuote(
  inputMint: string,
  outputMint: string,
  amount: bigint,
  slippageBps = 50,
): Promise<JupQuote | null> {
  try {
    const url = `${JUP_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=${slippageBps}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (!data.outAmount) return null;
    return {
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inAmount: BigInt(data.inAmount ?? amount.toString()),
      outAmount: BigInt(data.outAmount),
      priceImpactPct: parseFloat(data.priceImpactPct ?? '0'),
    };
  } catch {
    return null;
  }
}
