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
}): string {
  const { side, poolName, priceLow, priceHigh, currentPrice, amount, quoteSymbol, txSig } = params;
  const isBuy = side === 'Buy';
  const status = isBuy
    ? (currentPrice > priceHigh ? `Current: $${formatPrice(currentPrice)} (above range)` : 'Current: in range')
    : (currentPrice < priceLow ? `Current: $${formatPrice(currentPrice)} (below range)` : 'Current: in range');

  return (
    `${isBuy ? 'BUY' : 'SELL'} ${poolName} — $${formatPrice(priceLow)} to $${formatPrice(priceHigh)}\n` +
    `${status}\n` +
    `[${amount.toLocaleString()} ${quoteSymbol}](${SOLSCAN_TX}${txSig}) deposited`
  );
}

// ─── Position Opened (ephemeral follow-up) ─────────────────────────────────

export function formatPositionEphemeral(positionPda: string, txSig: string): string {
  const shortId = positionPda.slice(0, 8);
  return (
    `ID: ${positionPda}\n` +
    `TX: ${SOLSCAN_TX}${txSig}\n` +
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

    if (fillPct === 0) {
      const curPrice = binToPrice(p.activeBinId, p.binStep, p.decimalsX, p.decimalsY);
      return (
        `(${i + 1}) ${p.side === 'Buy' ? 'BUY' : 'SELL'} ${p.poolName} — $${formatPrice(minPrice)} to $${formatPrice(maxPrice)}\n` +
        `    [${bar}] waiting\n` +
        `    Current: $${formatPrice(curPrice)} · ${age} ago · ${shortId}`
      );
    }

    return (
      `(${i + 1}) ${p.side === 'Buy' ? 'BUY' : 'SELL'} ${p.poolName} — $${formatPrice(minPrice)} to $${formatPrice(maxPrice)}\n` +
      `    [${bar}] ${fillPct}%\n` +
      `    Harvested: ${harvested} ${p.tokenSymbol} · ${age} ago · ${shortId}`
    );
  });

  return lines.join('\n\n');
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
}): string {
  return (
    `opened · ${params.side} ${params.poolName} $${formatPrice(params.priceLow)}–$${formatPrice(params.priceHigh)} · ` +
    `[${params.amount.toLocaleString()} ${params.quoteSymbol}](${SOLSCAN_TX}${params.txSig}) deposited`
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
  let text = `🦧 ${msg}`;
  if (example) text += `\n   ${example}`;
  return text;
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

export function formatPoolsList(pools: { label: string; id: string; displayMode: string; binStep: number }[]): string {
  if (pools.length === 0) return 'No pools configured.';
  const lines = pools.map(p => `${p.label} · ${p.binStep}bps · ${p.displayMode}`);
  return 'Covered pools:\n\n' + lines.join('\n');
}
