/**
 * discord-bot/src/formatter.ts
 *
 * Plain text output for all bot responses. No rich embeds.
 * ASCII fill bars, monospace blocks. Ports directly to Telegram.
 */

import { binToPrice, formatPrice, formatAge } from '@crankbot/core-sdk';

const BAR_WIDTH = 20;
const SOLSCAN_TX = 'https://solscan.io/tx/';

export interface PositionDisplayData {
  positionPda: string;
  lbPair: string;
  poolName: string;
  side: 'Buy' | 'Sell';
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  binStep: number;
  decimalsX: number;
  decimalsY: number;
  initialAmount: bigint;
  harvestedAmount: bigint;
  tokenSymbol: string;
  quoteSymbol: string;
  quoteDecimals: number;
  createdAt: number;
  displayMode?: 'price' | 'mc';
  supply?: number;
  quoteTokenUsdPrice?: number;
}

// ─── Position Opened (public reply in channel) ─────────────────────────────

export function formatPositionOpened(params: {
  side: 'Buy' | 'Sell';
  poolName: string;
  priceLow: number;
  priceHigh: number;
  currentPrice: number;
  amount: number;
  quoteSymbol: string;
  txSig: string;
  displayMode?: 'price' | 'mc';
  supply?: number;
  token?: string;
  walletAddress?: string;
}): string {
  const { side, poolName, priceLow, priceHigh, amount, quoteSymbol, txSig, displayMode, supply, token, walletAddress } = params;
  const isBuy = side === 'Buy';
  const tokenName = token || poolName.split('/')[0];

  let topLabel: string;
  let bottomLabel: string;

  if (displayMode === 'mc' && supply) {
    topLabel = formatMcap(priceHigh * supply);
    bottomLabel = formatMcap(priceLow * supply);
  } else {
    topLabel = `$${formatPrice(priceHigh)}`;
    bottomLabel = `$${formatPrice(priceLow)}`;
  }

  const addr = walletAddress
    ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
    : '';

  return (
    `${addr} is a ${isBuy ? 'buyer' : 'seller'} of ${tokenName} between:\n` +
    `Top:    ${topLabel}\n` +
    `Bottom: ${bottomLabel}\n` +
    `[${amount} ${quoteSymbol} deposited](${SOLSCAN_TX}${txSig})`
  );
}

function formatMcap(mcap: number): string {
  if (mcap >= 1_000_000_000) return `${(mcap / 1_000_000_000).toFixed(1)}b mc`;
  if (mcap >= 1_000_000) return `${(mcap / 1_000_000).toFixed(1)}m mc`;
  if (mcap >= 1_000) return `${(mcap / 1_000).toFixed(1)}k mc`;
  return `$${mcap.toFixed(0)} mc`;
}

// ─── Position Opened (ephemeral follow-up) ─────────────────────────────────

export function formatPositionEphemeral(positionPda: string, txSig: string): string {
  const shortId = positionPda.slice(0, 8);
  return (
    `ID: ${positionPda}\n` +
    `TX: <${SOLSCAN_TX}${txSig}>\n` +
    `/close ${shortId} to close · /positions to see all`
  );
}

// ─── Position Closed (public reply) ────────────────────────────────────────

export function formatPositionClosed(params: {
  side: 'Buy' | 'Sell';
  poolName: string;
  priceLow: number;
  priceHigh: number;
  amountOut: string;
  tokenSymbol: string;
  txSig: string;
}): string {
  return (
    `Closed ${params.side === 'Buy' ? 'BUY' : 'SELL'} ${params.poolName} — ` +
    `$${formatPrice(params.priceLow)} to $${formatPrice(params.priceHigh)}\n` +
    `[${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig}) out`
  );
}

// ─── Positions List (ephemeral) ────────────────────────────────────────────

export function formatPositionsList(positions: PositionDisplayData[]): string {
  if (positions.length === 0) {
    return 'No open positions.\n\n/buy or /sell to open one.';
  }

  const lines = positions.map((p, i) => {
    const minPrice = binToPrice(p.minBinId, p.binStep, p.decimalsX, p.decimalsY);
    const maxPrice = binToPrice(p.maxBinId, p.binStep, p.decimalsX, p.decimalsY);
    const totalBins = p.maxBinId - p.minBinId + 1;

    let filledBins = 0;
    for (let b = p.minBinId; b <= p.maxBinId; b++) {
      if (p.side === 'Buy' && b > p.activeBinId) filledBins++;
      if (p.side === 'Sell' && b < p.activeBinId) filledBins++;
    }
    const fillPct = Math.round((filledBins / totalBins) * 100);
    const filledBlocks = Math.round((filledBins / totalBins) * BAR_WIDTH);
    const emptyBlocks = BAR_WIDTH - filledBlocks;

    const bar = p.side === 'Buy'
      ? '░'.repeat(emptyBlocks) + '▓'.repeat(filledBlocks)
      : '▓'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

    const harvested = (Number(p.harvestedAmount) / Math.pow(10, p.quoteDecimals)).toFixed(4);
    const age = formatAge(Math.floor(p.createdAt / 1000));
    const shortId = p.positionPda.slice(0, 8);

    // Price display: mcap for mc-mode pools, USD otherwise
    const qUsd = p.quoteTokenUsdPrice ?? 1;
    let rangeLabel: string;
    let currentLabel: string;
    if (p.displayMode === 'mc' && p.supply) {
      rangeLabel = `${formatMcap(minPrice * qUsd * p.supply)} to ${formatMcap(maxPrice * qUsd * p.supply)}`;
      const curPrice = binToPrice(p.activeBinId, p.binStep, p.decimalsX, p.decimalsY);
      currentLabel = formatMcap(curPrice * qUsd * p.supply);
    } else {
      rangeLabel = `$${formatPrice(minPrice)} to $${formatPrice(maxPrice)}`;
      const curPrice = binToPrice(p.activeBinId, p.binStep, p.decimalsX, p.decimalsY);
      currentLabel = `$${formatPrice(curPrice)}`;
    }

    // Determine position status relative to current price
    const isBuy = p.side === 'Buy';
    const belowRange = isBuy ? p.activeBinId > p.maxBinId : p.activeBinId > p.maxBinId;
    const aboveRange = isBuy ? p.activeBinId < p.minBinId : p.activeBinId < p.minBinId;
    let statusLabel = '';
    if (fillPct === 0) {
      if (isBuy && aboveRange) statusLabel = 'Currently above range.';
      else if (isBuy && belowRange) statusLabel = 'Currently below range.';
      else if (!isBuy && aboveRange) statusLabel = 'Currently above range.';
      else if (!isBuy && belowRange) statusLabel = 'Currently below range.';
      else statusLabel = 'waiting';
    }

    const harvestedNum = Number(p.harvestedAmount) / Math.pow(10, p.quoteDecimals);

    if (fillPct === 0) {
      return (
        `(${i + 1}) ${isBuy ? 'BUY' : 'SELL'} ${p.poolName} — ${rangeLabel}\n` +
        `    [${bar}] 0%\n` +
        `    ${statusLabel}`
      );
    }

    return (
      `(${i + 1}) ${isBuy ? 'BUY' : 'SELL'} ${p.poolName} — ${rangeLabel}\n` +
      `    [${bar}] ${fillPct}%\n` +
      `    Harvested: [${harvestedNum.toFixed(harvestedNum >= 1 ? 2 : 4)}] ${p.tokenSymbol}`
    );
  });

  return lines.join('\n\n✦. ──────────────────────────────────────── .✦\n\n');
}

// ─── Harvest DM ────────────────────────────────────────────────────────────

export function formatHarvestDM(params: {
  poolName: string;
  side: 'Buy' | 'Sell';
  binCount: number;
  amountOut: string;
  tokenSymbol: string;
  totalHarvested: string;
  txSig?: string;
}): string {
  const txLink = params.txSig ? `[${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig})` : `${params.amountOut} ${params.tokenSymbol}`;
  return (
    `${params.binCount} bins harvested · ${params.poolName} ${params.side}\n` +
    `${txLink} -> your wallet\n` +
    `Total harvested: ${params.totalHarvested} ${params.tokenSymbol}`
  );
}

// ─── Position Closed DM ───────────────────────────────────────────────────

export function formatClosedDM(params: {
  poolName: string;
  side: 'Buy' | 'Sell';
  amountOut: string;
  tokenSymbol: string;
  txSig?: string;
}): string {
  const txLink = params.txSig ? `[${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig})` : `${params.amountOut} ${params.tokenSymbol}`;
  return (
    `Position closed · ${params.poolName} ${params.side}\n` +
    `${txLink} -> your wallet`
  );
}

// ─── Feed Channel (one-liners) ─────────────────────────────────────────────

export function formatFeedOpened(params: {
  side: 'Buy' | 'Sell';
  poolName: string;
  priceLow: number;
  priceHigh: number;
  amount: number;
  quoteSymbol: string;
  txSig: string;
  displayMode?: 'price' | 'mc';
  supply?: number;
}): string {
  let range: string;
  if (params.displayMode === 'mc' && params.supply) {
    range = `${formatMcap(params.priceLow * params.supply)}–${formatMcap(params.priceHigh * params.supply)}`;
  } else {
    range = `$${formatPrice(params.priceLow)}–$${formatPrice(params.priceHigh)}`;
  }
  return (
    `opened · ${params.side} ${params.poolName} ${range} · ` +
    `[${params.amount} ${params.quoteSymbol}](${SOLSCAN_TX}${params.txSig}) deposited`
  );
}

export function formatFeedHarvested(params: {
  poolName: string;
  side: 'Buy' | 'Sell';
  amountOut: string;
  tokenSymbol: string;
  txSig: string;
}): string {
  return `harvested · ${params.poolName} ${params.side.toLowerCase()} · [${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig})`;
}

export function formatFeedClosed(params: {
  side: 'Buy' | 'Sell';
  poolName: string;
  priceLow: number;
  priceHigh: number;
  amountOut: string;
  tokenSymbol: string;
  txSig: string;
}): string {
  return (
    `closed · ${params.side} ${params.poolName} $${formatPrice(params.priceLow)}–$${formatPrice(params.priceHigh)} · ` +
    `[${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig}) out`
  );
}

// ─── Error Messages (orangutan voice) ──────────────────────────────────────

export function formatError(msg: string, example?: string): string {
  let text = `🦧\n${msg}`;
  if (example) text += `\n${example}`;
  return text;
}

export function formatErrorBig(msg: string, example?: string): { monke: string; body: string } {
  let body = msg;
  if (example) body += `\n${example}`;
  return { monke: '🦧', body };
}

// ─── Balance ───────────────────────────────────────────────────────────────

export function formatBalance(address: string, solBalance: number, tokens: { symbol: string; amount: number }[]): string {
  let text = `Wallet: ${address}\n\nSOL: ${solBalance.toFixed(4)}`;
  for (const t of tokens) {
    if (t.amount > 0) text += `\n${t.symbol}: ${t.amount.toFixed(4)}`;
  }
  return text;
}

// ─── Pools List ────────────────────────────────────────────────────────────

export function formatPoolsList(pools: {
  label: string; id: string; displayMode: string; binStep: number;
  example?: string; buyToken?: string; currentPrice?: number; currentMc?: number;
}[]): string {
  if (pools.length === 0) return 'No pools configured.';

  // Group by pair
  const pairs = new Map<string, typeof pools>();
  for (const p of pools) {
    const pair = p.label.replace(/\s*\(.*\)/, '');
    if (!pairs.has(pair)) pairs.set(pair, []);
    pairs.get(pair)!.push(p);
  }

  const sections: string[] = [];
  for (const [pair, group] of pairs) {
    const ref = group[0];
    const example = group.find(p => p.example)?.example;

    let priceLine = '';
    if (ref.displayMode === 'mc' && ref.currentMc) {
      priceLine = `   ${formatMcShort(ref.currentMc)}`;
    } else if (ref.currentPrice) {
      priceLine = `   $${formatPrice(ref.currentPrice)}`;
    }

    let line = `**${pair}**`;
    if (priceLine) line += `\n${priceLine}`;
    if (example) line += `\n   \`${example}\``;
    sections.push(line);
  }

  return 'Covered pairs:\n\n' + sections.join('\n\n');
}

function formatMcShort(mc: number): string {
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B mc`;
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(1)}M mc`;
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(0)}K mc`;
  return `$${mc.toFixed(0)} mc`;
}
