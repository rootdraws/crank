/**
 * tools/depth.ts
 *
 * DLMM Order Book Depth — ASCII visualization of buy/sell pressure by market cap band.
 *
 * Usage:
 *   npx tsx tools/depth.ts CRANK
 *   npx tsx tools/depth.ts CRANK --bands 15
 *   npx tsx tools/depth.ts CRANK --band-size 10k
 *   npx tsx tools/depth.ts SOL --pool sol-usdc-1
 */

// tsx + Node 24 CJS/ESM interop: workspace packages and @meteora-ag/dlmm
// must be loaded via createRequire to get correct named exports.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const _require = createRequire(import.meta.url);
const { Connection, PublicKey } = _require('@solana/web3.js');
const DLMM = _require('@meteora-ag/dlmm');
const dotenv = _require('dotenv');
const sdk = _require('@crankbot/core-sdk');

const { loadPoolRegistry, binToPrice, fetchDexScreenerPrice, NATIVE_MINT } = sdk;
type PoolConfig = typeof sdk extends { PoolConfig: infer T } ? T : any;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

// ─── CLI Parsing ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.log(`Usage: npx tsx tools/depth.ts <TICKER> [options]

Options:
  --bands <n>       Bands per side (default: 10)
  --band-size <s>   Band size override (e.g. "5k", "25k", "100k")
  --pool <id>       Specific pool id from curator.json
  --bins <n>        Bins to fetch per side (default: auto)`);
    process.exit(0);
  }

  const ticker = args[0].toUpperCase();
  let bands = 10;
  let bandSize: number | null = null;
  let poolId: string | null = null;
  let binsPerSide: number | null = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--bands' && args[i + 1]) { bands = parseInt(args[++i]); }
    else if (args[i] === '--band-size' && args[i + 1]) { bandSize = parseSizeArg(args[++i]); }
    else if (args[i] === '--pool' && args[i + 1]) { poolId = args[++i]; }
    else if (args[i] === '--bins' && args[i + 1]) { binsPerSide = parseInt(args[++i]); }
  }

  return { ticker, bands, bandSize, poolId, binsPerSide };
}

function parseSizeArg(s: string): number {
  const lower = s.toLowerCase();
  if (lower.endsWith('m')) return parseFloat(lower) * 1_000_000;
  if (lower.endsWith('k')) return parseFloat(lower) * 1_000;
  return parseFloat(s);
}

// ─── Pool Lookup ──────────────────────────────────────────────────────

function findPool(ticker: string, poolId: string | null): PoolConfig {
  const pools = loadPoolRegistry();
  const tU = ticker.toUpperCase();

  let matches = pools.filter(
    p => p.buyToken.toUpperCase() === tU || p.tokenX.toUpperCase() === tU
  );

  if (matches.length === 0) {
    const available = [...new Set(pools.map(p => p.buyToken))].join(', ');
    console.error(`No pool found for "${ticker}". Available: ${available}`);
    process.exit(1);
  }

  if (poolId) {
    const exact = matches.find(p => p.id === poolId);
    if (!exact) {
      console.error(`Pool "${poolId}" not found. Matches: ${matches.map(p => p.id).join(', ')}`);
      process.exit(1);
    }
    return exact;
  }

  // Prefer widest binStep for depth coverage
  matches.sort((a, b) => b.binStep - a.binStep);
  return matches[0];
}

// ─── Band Sizing ──────────────────────────────────────────────────────

function autoBandSize(mcap: number): number {
  if (mcap < 100_000) return 5_000;
  if (mcap < 1_000_000) return 25_000;
  if (mcap < 10_000_000) return 100_000;
  if (mcap < 100_000_000) return 500_000;
  return 5_000_000;
}

function autoPriceBandSize(price: number): number {
  if (price < 1) return 0.1;
  if (price < 10) return 0.5;
  if (price < 100) return 1;
  if (price < 1000) return 5;
  return 50;
}

// ─── Formatting ───────────────────────────────────────────────────────

function fmtMcap(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}b`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtSol(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1);
  if (n >= 0.01) return n.toFixed(2);
  return n.toFixed(3);
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

function renderBar(value: number, max: number, width = 12): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

// ─── Data Types ───────────────────────────────────────────────────────

interface Band {
  low: number;
  high: number;
  solAmount: number;
  side: 'sell' | 'buy';
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { ticker, bands: numBands, bandSize: bandSizeOverride, poolId, binsPerSide } = parseArgs();
  const pool = findPool(ticker, poolId);

  const RPC_URL = process.env.RPC_URL;
  if (!RPC_URL) { console.error('RPC_URL not set in bot/.env'); process.exit(1); }
  const connection = new Connection(RPC_URL, 'confirmed');

  const isMcMode = pool.displayMode === 'mc' && pool.supply;
  const quoteLabel = pool.quoteToken;

  console.log(`\nFetching ${pool.label} bin data...`);

  // Determine bins to fetch
  const fetchBins = binsPerSide ?? (pool.binStep >= 20 ? 500 : 200);

  // Parallel fetches: bins + SOL price
  const [dlmmResult, solPriceResult] = await Promise.all([
    (async () => {
      const dlmm = await DLMM.create(connection, new PublicKey(pool.address));
      return dlmm.getBinsAroundActiveBin(fetchBins, fetchBins);
    })(),
    fetchDexScreenerPrice(NATIVE_MINT.toBase58()),
  ]);

  const { activeBin: activeBinId, bins } = dlmmResult;
  const solPriceUsd = solPriceResult?.priceUsd ?? 0;

  if (bins.length === 0) {
    console.error('No bins returned from DLMM pool.');
    process.exit(1);
  }

  // Current price from active bin
  const activeBinPrice = binToPrice(activeBinId, pool.binStep, pool.decimalsX, pool.decimalsY);
  const quoteUsdPrice = pool.mintY === NATIVE_MINT.toBase58() ? solPriceUsd : 1.0;
  const currentMcap = isMcMode ? activeBinPrice * quoteUsdPrice * pool.supply! : 0;
  const currentPriceUsd = activeBinPrice * quoteUsdPrice;

  // Band size
  let bandSize: number;
  if (bandSizeOverride) {
    bandSize = bandSizeOverride;
  } else if (isMcMode) {
    bandSize = autoBandSize(currentMcap);
  } else {
    bandSize = autoPriceBandSize(currentPriceUsd);
  }

  // Reference value for band computation (mcap or price-in-USD)
  const currentRef = isMcMode ? currentMcap : currentPriceUsd;
  const currentBandFloor = Math.floor(currentRef / bandSize) * bandSize;

  // Aggregate bins into bands
  const sellBands = new Map<number, number>(); // bandFloor → SOL
  const buyBands = new Map<number, number>();

  for (const bin of bins) {
    const binPrice = binToPrice(bin.binId, pool.binStep, pool.decimalsX, pool.decimalsY);
    const refValue = isMcMode ? binPrice * quoteUsdPrice * pool.supply! : binPrice * quoteUsdPrice;

    if (bin.binId > activeBinId) {
      // Sell side: xAmount is tokens waiting to be bought
      const xAmount = Number(bin.xAmount.toString()) / Math.pow(10, pool.decimalsX);
      const solCost = xAmount * binPrice; // binPrice is in quote token (e.g. SOL/CRANK)
      if (solCost > 0) {
        const bandFloor = Math.floor(refValue / bandSize) * bandSize;
        sellBands.set(bandFloor, (sellBands.get(bandFloor) ?? 0) + solCost);
      }
    } else if (bin.binId < activeBinId) {
      // Buy side: yAmount is quote token (SOL) sitting as support
      const yAmount = Number(bin.yAmount.toString()) / Math.pow(10, pool.decimalsY);
      if (yAmount > 0) {
        const bandFloor = Math.floor(refValue / bandSize) * bandSize;
        buyBands.set(bandFloor, (buyBands.get(bandFloor) ?? 0) + yAmount);
      }
    }
  }

  // Build ordered band arrays radiating from center
  const sellList: Band[] = [];
  for (let i = 1; i <= numBands; i++) {
    const low = currentBandFloor + (i - 1) * bandSize;
    const high = low + bandSize;
    // Include partial band above current price
    const floor = i === 1 ? currentBandFloor : low;
    let sol = 0;
    for (const [bf, amount] of sellBands) {
      if (bf >= floor && bf < high) sol += amount;
    }
    sellList.push({ low, high, solAmount: sol, side: 'sell' });
  }

  const buyList: Band[] = [];
  for (let i = 1; i <= numBands; i++) {
    const high = currentBandFloor - (i - 1) * bandSize;
    const low = high - bandSize;
    if (low < 0) break;
    let sol = 0;
    for (const [bf, amount] of buyBands) {
      if (bf >= low && bf < high) sol += amount;
    }
    buyList.push({ low, high, solAmount: sol, side: 'buy' });
  }

  // Find max for bar scaling
  const allAmounts = [...sellList, ...buyList].map(b => b.solAmount);
  const maxSol = Math.max(...allAmounts, 0.001);

  // Compute cumulatives
  let sellCum = 0;
  const sellCums = sellList.map(b => { sellCum += b.solAmount; return sellCum; });
  let buyCum = 0;
  const buyCums = buyList.map(b => { buyCum += b.solAmount; return buyCum; });

  // Format label function
  const fmtLabel = isMcMode ? fmtMcap : fmtPrice;

  // ─── Render ───────────────────────────────────────────────────────

  const BAR_WIDTH = 40;
  const LABEL_W = 15;
  const STATS_W = 30; // right-side stats

  console.log('');
  console.log(`${pool.label} \u2014 Order Book Depth`);
  if (isMcMode) {
    console.log(`Current MC: ~${fmtMcap(currentMcap)} | Price: ${activeBinPrice.toExponential(3)} ${quoteLabel} | SOL: $${solPriceUsd.toFixed(2)}`);
  } else {
    console.log(`Current Price: ${fmtPrice(currentPriceUsd)} | SOL: $${solPriceUsd.toFixed(2)}`);
  }
  console.log('');

  const totalW = LABEL_W + BAR_WIDTH + 2 + STATS_W;

  function renderRow(label: string, solAmount: number, cumSol: number, side: 'sell' | 'buy') {
    const filled = maxSol > 0 ? Math.round((solAmount / maxSol) * BAR_WIDTH) : 0;
    const barFill = '\u2588'.repeat(filled);
    const barEmpty = '\u2591'.repeat(BAR_WIDTH - filled);
    const bar = side === 'sell'
      ? barEmpty + barFill  // sell: bars grow leftward (wall above)
      : barFill + barEmpty; // buy: bars grow rightward (support below)
    const arrow = side === 'sell' ? '\u2193' : '\u2191';
    const stats = `  ${fmtSol(solAmount).padStart(6)} ${quoteLabel}  ${fmtUsd(solAmount * quoteUsdPrice).padStart(7)}  ${arrow} ${fmtUsd(cumSol * quoteUsdPrice).padStart(7)}`;
    console.log(`${label.padStart(LABEL_W)} ${bar}${stats}`);
  }

  // Sell bands (highest at top) — bars grow from right edge leftward
  for (let i = sellList.length - 1; i >= 0; i--) {
    const b = sellList[i];
    const label = `${fmtLabel(b.high)}`;
    renderRow(label, b.solAmount, sellCums[i], 'sell');
  }

  // Center divider
  const centerLabel = isMcMode
    ? ` \u25C6 ${fmtMcap(currentMcap)} MC \u25C6 `
    : ` \u25C6 ${fmtPrice(currentPriceUsd)} \u25C6 `;
  const divPad = Math.max(0, Math.floor((totalW - centerLabel.length) / 2));
  console.log('\u2550'.repeat(divPad) + centerLabel + '\u2550'.repeat(Math.max(0, totalW - divPad - centerLabel.length)));

  // Buy bands (closest to price first) — bars grow from left edge rightward
  for (let i = 0; i < buyList.length; i++) {
    const b = buyList[i];
    const label = `${fmtLabel(b.low)}`;
    renderRow(label, b.solAmount, buyCums[i], 'buy');
  }

  console.log('');

  // Footer summary
  const totalSell = sellCums[sellCums.length - 1] ?? 0;
  const totalBuy = buyCums[buyCums.length - 1] ?? 0;
  const highestSell = sellList[sellList.length - 1];
  const lowestBuy = buyList[buyList.length - 1];

  if (highestSell) {
    console.log(`  \u25B2 Sell pressure to ${fmtLabel(highestSell.high)}: ${fmtSol(totalSell)} ${quoteLabel} (${fmtUsd(totalSell * quoteUsdPrice)})`);
  }
  if (lowestBuy) {
    console.log(`  \u25BC Buy support to ${fmtLabel(lowestBuy.low)}: ${fmtSol(totalBuy)} ${quoteLabel} (${fmtUsd(totalBuy * quoteUsdPrice)})`);
  }
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
