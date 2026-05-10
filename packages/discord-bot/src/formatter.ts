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
  actorId?: string;
}): string {
  const { side, poolName, priceLow, priceHigh, amount, quoteSymbol, txSig, displayMode, supply, token, walletAddress, actorId } = params;
  const isBuy = side === 'Buy';
  const tokenName = token || poolName.split('/')[0];

  let rangePhrase: string;
  if (displayMode === 'mc' && supply) {
    rangePhrase = `between ${formatMcapCompact(priceLow * supply)} and ${formatMcapCompact(priceHigh * supply)} market cap`;
  } else {
    rangePhrase = `between $${formatPrice(priceLow)} and $${formatPrice(priceHigh)}`;
  }

  const addr = actorId
    ? `<@${actorId}>`
    : walletAddress
      ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`
      : '';

  return `${addr} is a ${isBuy ? 'buyer' : 'seller'} of ${tokenName} ${rangePhrase} · [${amount} ${quoteSymbol}](${SOLSCAN_TX}${txSig}).`;
}

function formatAmount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

function formatMcap(mcap: number): string {
  if (mcap >= 1_000_000_000) return `${(mcap / 1_000_000_000).toFixed(1)}b mc`;
  if (mcap >= 1_000_000) return `${(mcap / 1_000_000).toFixed(1)}m mc`;
  if (mcap >= 1_000) return `${(mcap / 1_000).toFixed(1)}k mc`;
  return `$${mcap.toFixed(0)} mc`;
}

function trimZero(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return s.replace(/\.?0+$/, '');
}

// Treasury proposal title (Path B markers). Mirrors feed wording with
// "crank.money treasury" as the subject. Used as Realms proposal `name`.
export function formatTreasuryProposalName(params: {
  kind: 'open' | 'close';
  side: 'Buy' | 'Sell';
  priceLow: number;
  priceHigh: number;
  amount: number;
  quoteSymbol: string;
  displayMode?: 'price' | 'mc';
  supply?: number;
  proposerHandle?: string;
}): string {
  const { kind, side, priceLow, priceHigh, amount, quoteSymbol, displayMode, supply, proposerHandle } = params;

  const rangePhrase = displayMode === 'mc' && supply
    ? `between ${formatMcapCompact(priceLow * supply)} and ${formatMcapCompact(priceHigh * supply)} market cap`
    : `between $${formatPrice(priceLow)} and $${formatPrice(priceHigh)}`;

  const verbPhrase = kind === 'open'
    ? `is a matched ${side === 'Buy' ? 'buyer' : 'seller'}`
    : `closing matched ${side === 'Buy' ? 'buy' : 'sell'}`;

  const amountPart = kind === 'open' ? ` - ${formatAmount(amount)} ${quoteSymbol}` : '';
  const handlePart = proposerHandle ? ` | @${proposerHandle}` : '';

  return `crank.money ${verbPhrase} ${rangePhrase}${amountPart}${handlePart}`;
}

export function formatMcapCompact(mcap: number): string {
  if (mcap >= 1_000_000_000) return `${trimZero(mcap / 1_000_000_000, 1)}b`;
  if (mcap >= 1_000_000) return `${trimZero(mcap / 1_000_000, 1)}m`;
  if (mcap >= 1_000) return `${trimZero(mcap / 1_000, 1)}k`;
  return `$${mcap.toFixed(0)}`;
}

// ─── Position Opened (ephemeral follow-up) ─────────────────────────────────

export function formatPositionEphemeral(positionPda: string, txSig: string): string {
  return (
    `TX: <${SOLSCAN_TX}${txSig}>\n` +
    `/close to see positions · /positions to check status`
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
  displayMode?: 'price' | 'mc';
  supply?: number;
  quoteTokenUsdPrice?: number;
}): string {
  const qUsd = params.quoteTokenUsdPrice ?? 1;
  let range: string;
  if (params.displayMode === 'mc' && params.supply) {
    range = `${formatMcap(params.priceLow * qUsd * params.supply)} to ${formatMcap(params.priceHigh * qUsd * params.supply)}`;
  } else {
    range = `$${formatPrice(params.priceLow)} to $${formatPrice(params.priceHigh)}`;
  }
  const amountPart = params.amountOut !== '—'
    ? `[${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig}) returned`
    : `[closed](${SOLSCAN_TX}${params.txSig})`;
  return `Closed ${params.side === 'Buy' ? 'BUY' : 'SELL'} ${params.poolName} — ${range}\n${amountPart}`;
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
      if (aboveRange) statusLabel = 'Range is above current price.';
      else if (belowRange) statusLabel = 'Range is below current price.';
      else statusLabel = 'waiting';
    }

    const harvestedNum = Number(p.harvestedAmount) / Math.pow(10, p.quoteDecimals);

    // Deposit info: initialAmount is in the deposited token's lamports
    // SELL deposits tokenX (e.g. CRANK), BUY deposits tokenY (e.g. SOL)
    const depositDecimals = isBuy ? p.decimalsY : p.decimalsX;
    const depositNum = Number(p.initialAmount) / Math.pow(10, depositDecimals);
    const depositLabel = `${formatAmount(depositNum)} ${p.quoteSymbol}`;

    if (fillPct === 0) {
      return (
        `(${i + 1}) ${isBuy ? 'BUY' : 'SELL'} ${p.poolName} — ${rangeLabel}\n` +
        `    ${depositLabel} deposited\n` +
        `    [${bar}] 0%\n` +
        `    ${statusLabel}`
      );
    }

    return (
      `(${i + 1}) ${isBuy ? 'BUY' : 'SELL'} ${p.poolName} — ${rangeLabel}\n` +
      `    ${depositLabel} → ${harvestedNum.toFixed(harvestedNum >= 1 ? 2 : 4)} ${p.tokenSymbol}\n` +
      `    [${bar}] ${fillPct}%`
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
  actorId?: string;
}): string {
  const isBuy = params.side === 'Buy';
  const tokenName = params.poolName.split('/')[0];
  let rangePhrase: string;
  if (params.displayMode === 'mc' && params.supply) {
    rangePhrase = `between ${formatMcapCompact(params.priceLow * params.supply)} and ${formatMcapCompact(params.priceHigh * params.supply)} market cap`;
  } else {
    rangePhrase = `between $${formatPrice(params.priceLow)} and $${formatPrice(params.priceHigh)}`;
  }
  const actor = params.actorId ? `<@${params.actorId}>` : 'someone';
  return `${actor} is a ${isBuy ? 'buyer' : 'seller'} of ${tokenName} ${rangePhrase} · [${params.amount} ${params.quoteSymbol}](${SOLSCAN_TX}${params.txSig}).`;
}

export function formatFeedHarvested(params: {
  poolName: string;
  side: 'Buy' | 'Sell';
  amountOut: string;
  tokenSymbol: string;
  txSig: string;
  actorId?: string;
}): string {
  const actor = params.actorId ? `<@${params.actorId}>` : 'someone';
  const link = `[${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig})`;
  const verb = params.side === 'Buy' ? 'accumulated' : 'harvested';
  return `${actor} ${verb} ${link}.`;
}

export function formatFeedClosed(params: {
  side: 'Buy' | 'Sell';
  poolName: string;
  priceLow: number;
  priceHigh: number;
  amountOut: string;
  tokenSymbol: string;
  txSig: string;
  displayMode?: 'price' | 'mc';
  supply?: number;
  quoteTokenUsdPrice?: number;
  actorId?: string;
}): string {
  const actor = params.actorId ? `<@${params.actorId}>` : 'someone';
  const sideLower = params.side.toLowerCase();
  if (params.amountOut === '—') {
    return `${actor} [closed a ${sideLower} position in ${params.poolName}](${SOLSCAN_TX}${params.txSig}).`;
  }
  const link = `[${params.amountOut} ${params.tokenSymbol}](${SOLSCAN_TX}${params.txSig})`;
  return `${actor} closed their ${sideLower} position in ${params.poolName} · ${link} returned.`;
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

export function formatBalance(address: string, solBalance: number, tokens: { symbol: string; amount: number }[], withdrawAddress?: string): string {
  let text = `Deposit: [${address}](https://solscan.io/account/${address})\n`;
  if (withdrawAddress) {
    text += `Withdraw: [${withdrawAddress}](https://solscan.io/account/${withdrawAddress})\n`;
  }
  text += `\nSOL: ${solBalance.toFixed(4)}`;
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
