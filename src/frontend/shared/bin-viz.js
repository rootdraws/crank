import { state } from '../state.js';
import { CONFIG, binIdToBinArrayIndex, deriveBinArrayPDA, METEORA_DLMM_PROGRAM } from '../constants.js';
import { binToPrice, priceToBin, formatPrice } from '../helpers.js';
import { relayFetch } from '../relay.js';
import { themeColors, hexToRgba } from '../theme.js';

const BINS_PER_ARRAY = 70;

const BIN_ARRAY_HEADER = 56;
const BIN_SIZE = 144;
const BIN_AMOUNT_X_OFFSET = 0;
const BIN_AMOUNT_Y_OFFSET = 8;

let _binVizDebounceTimer = null;
export function renderBinVizDebounced() {
  clearTimeout(_binVizDebounceTimer);
  _binVizDebounceTimer = setTimeout(renderBinViz, 50);
}

export function patchBinArrayCache(data) {
  if (!data || !data.bins) return;
  const dlmmPools = state.discoveredDlmmPools.length > 0
    ? state.discoveredDlmmPools
    : [{ address: state.poolAddress, bin_step: state.binStep }];
  const poolEntry = dlmmPools.find(p => p.address === data.lbPair);
  if (!poolEntry || !vizState.logSlotStep) return;
  const poolBinStep = poolEntry.bin_step ?? poolEntry.binStep;
  const poolLogStep = Math.log(1 + poolBinStep / 10000);
  const { logPriceMin, logSlotStep, slotCount } = vizState;

  for (const [binIdStr, amounts] of Object.entries(data.bins)) {
    const binId = parseInt(binIdStr, 10);
    const binLogLow = binId * poolLogStep - poolLogStep / 2;
    const binLogHigh = binId * poolLogStep + poolLogStep / 2;
    const slotLow = Math.max(0, Math.floor((binLogLow - logPriceMin) / logSlotStep));
    const slotHigh = Math.min(slotCount - 1, Math.floor((binLogHigh - logPriceMin) / logSlotStep));
    if (slotHigh < 0 || slotLow >= slotCount) continue;
    const span = Math.max(1, slotHigh - slotLow + 1);
    for (let s = slotLow; s <= slotHigh; s++) {
      const ex = vizState.poolBins.get(s) || { amountX: 0, amountY: 0 };
      ex.amountX += amounts.amountX / span;
      ex.amountY += amounts.amountY / span;
      vizState.poolBins.set(s, ex);
    }
  }
}

function binIdToArrayIndex(binId) {
  if (binId >= 0) return Math.floor(binId / BINS_PER_ARRAY);
  return Math.floor((binId - (BINS_PER_ARRAY - 1)) / BINS_PER_ARRAY);
}

export async function fetchBinArrays(poolAddress, centerBin, visibleRange) {
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const poolPubkey = new solanaWeb3.PublicKey(poolAddress);
  const dlmmProgram = new solanaWeb3.PublicKey(METEORA_DLMM_PROGRAM);

  const lowBin = centerBin - visibleRange;
  const highBin = centerBin + visibleRange;
  const lowIdx = binIdToArrayIndex(lowBin);
  const highIdx = binIdToArrayIndex(highBin);

  const pdas = [];
  for (let i = lowIdx; i <= highIdx; i++) {
    // Encode i64 LE using BigInt for correct two's complement
    const signed = BigInt(i);
    const unsigned = signed < 0n ? signed + (1n << 64n) : signed;
    const buf = new Uint8Array(8);
    for (let byte = 0; byte < 8; byte++) {
      buf[byte] = Number((unsigned >> BigInt(byte * 8)) & 0xFFn);
    }
    const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('bin_array'), poolPubkey.toBytes(), buf],
      dlmmProgram
    );
    pdas.push({ pda, arrayIndex: i });
  }

  const RPC_CHUNK = 100;
  const allPdaKeys = pdas.map(p => p.pda);
  const chunks = [];
  for (let i = 0; i < allPdaKeys.length; i += RPC_CHUNK) {
    chunks.push(allPdaKeys.slice(i, i + RPC_CHUNK));
  }
  const accountChunks = await Promise.all(chunks.map(c => conn.getMultipleAccountsInfo(c)));
  const accounts = accountChunks.flat();

  const bins = new Map();
  for (let a = 0; a < accounts.length; a++) {
    const acct = accounts[a];
    if (!acct) continue;
    const data = acct.data;

    // Read the actual index from the account (i64 LE at offset 8, after 8-byte discriminator)
    const idxLo = data.readInt32LE(8);
    const idxHi = data.readInt32LE(12);
    const actualIndex = idxHi * 0x100000000 + (idxLo >>> 0);
    const baseBinId = actualIndex * BINS_PER_ARRAY;

    const expectedBinDataSize = BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SIZE;
    if (data.length < expectedBinDataSize) {
      if (CONFIG.DEBUG) console.warn(`BinArray ${actualIndex} unexpected size: ${data.length} (expected ${expectedBinDataSize})`);
      continue;
    }

    for (let b = 0; b < BINS_PER_ARRAY; b++) {
      const offset = BIN_ARRAY_HEADER + b * BIN_SIZE;
      const amountX = Number(data.readBigUInt64LE(offset + BIN_AMOUNT_X_OFFSET));
      const amountY = Number(data.readBigUInt64LE(offset + BIN_AMOUNT_Y_OFFSET));
      const binId = baseBinId + b;
      if (binId >= lowBin && binId <= highBin && (amountX > 0 || amountY > 0)) {
        bins.set(binId, { amountX, amountY });
      }
    }
  }
  return bins;
}

export function aggregateUserBins(positions, activeBin) {
  const bins = new Map();
  for (const pos of positions) {
    const side = pos.side || 'buy';
    const remaining = Math.max(0, pos.initialAmount - (pos.harvestedAmount || 0));
    if (remaining <= 0) continue;

    // Only show unfilled bins: buy = at/below active, sell = at/above active
    const effectiveMin = side === 'sell' ? Math.max(pos.minBinId, activeBin) : pos.minBinId;
    const effectiveMax = side === 'buy' ? Math.min(pos.maxBinId, activeBin) : pos.maxBinId;
    if (effectiveMin > effectiveMax) continue;

    const preview = computeBidAskPreview(remaining, effectiveMin, effectiveMax, activeBin);
    for (const [binId, amount] of preview) {
      const entry = bins.get(binId) || { buy: 0, sell: 0 };
      entry[side] += amount;
      bins.set(binId, entry);
    }
  }
  return bins;
}

// Canvas rendering state
export const vizState = {
  poolBins: new Map(),
  userBins: new Map(),
  previewBins: new Map(),
  activeBin: 0,
  binStep: 0,
  zoomPct: 20,
  logPriceMin: 0,
  logSlotStep: 0,
  slotCount: 400,
  binArrayCache: new Map(),
  fetchController: null,
  layout: { yMargin: 0, barAreaH: 0, rowH: 0, totalBins: 0, xLabelWidth: 0, W: 0, H: 0, activeSlot: 0 },
};

export function renderBinViz() {
  const canvas = document.getElementById('binVizCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  ctx.clearRect(0, 0, W, H);

  const { poolBins, userBins, previewBins, activeBin, binStep,
          logPriceMin, logSlotStep, slotCount } = vizState;
  if (!binStep) {
    ctx.fillStyle = themeColors().accent;
    ctx.font = '400 12px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('LOAD A POOL TO SEE LIQUIDITY', W / 2, H / 2);
    return;
  }

  const totalBins = slotCount;
  const activeSlot = Math.floor(totalBins / 2);

  const userSlotMap = new Map();
  const previewSlotMap = new Map();
  if (logSlotStep > 0) {
    const logStep = Math.log(1 + binStep / 10000);

    for (const [binId, amounts] of userBins) {
      const logPrice = binId * logStep;
      const slot = Math.floor((logPrice - logPriceMin) / logSlotStep);
      if (slot >= 0 && slot < totalBins) {
        const existing = userSlotMap.get(slot) || { buy: 0, sell: 0 };
        existing.buy += amounts.buy || 0;
        existing.sell += amounts.sell || 0;
        userSlotMap.set(slot, existing);
      }
    }

    for (const [binId, amount] of previewBins) {
      const logPrice = binId * logStep;
      const slot = Math.floor((logPrice - logPriceMin) / logSlotStep);
      if (slot >= 0 && slot < totalBins) {
        previewSlotMap.set(slot, Math.max(previewSlotMap.get(slot) || 0, amount));
      }
    }
  }

  let maxPoolLiq = 0;
  let maxUserLiq = 0;
  for (let slot = 0; slot < totalBins; slot++) {
    const pool = poolBins.get(slot);
    if (pool) {
      const slotPriceRaw = Math.exp(logPriceMin + slot * logSlotStep);
      const poolTotal = pool.amountX * slotPriceRaw + pool.amountY;
      maxPoolLiq = Math.max(maxPoolLiq, poolTotal);
    }
    const ub = userSlotMap.get(slot);
    const user = ub ? ub.buy + ub.sell : 0;
    const preview = previewSlotMap.get(slot) || 0;
    maxUserLiq = Math.max(maxUserLiq, user + preview);
  }
  if (maxPoolLiq === 0) maxPoolLiq = 1;
  if (maxUserLiq === 0) maxUserLiq = 1;

  const yMargin = 24;
  const xLabelWidth = W < 400 ? 56 : 72;
  const barAreaW = W - xLabelWidth - 12;
  const barAreaH = H - yMargin * 2;
  const rowH = barAreaH / totalBins;
  const barH = Math.max(1, rowH * 0.8);
  const halfBar = barH / 2;

  const t = themeColors();
  const poolBuyColor = hexToRgba(t.accent, 0.65);
  const poolSellColor = hexToRgba(t.wire, 0.70);
  const poolNeutralColor = hexToRgba(t.accent, 0.40);
  const userBuyColor = hexToRgba(t.dataGreen, 1.0);
  const userSellColor = hexToRgba(t.void, 0.80);
  const previewBuyColor = hexToRgba(t.dataGreen, 0.30);
  const previewSellColor = hexToRgba(t.void, 0.20);

  for (let slot = 0; slot < totalBins; slot++) {
    const idx = slot;
    const yCenter = yMargin + barAreaH - (idx + 0.5) * rowH;

    const pool = poolBins.get(slot);
    const slotPriceRaw = Math.exp(logPriceMin + slot * logSlotStep);
    const poolTotal = pool ? pool.amountX * slotPriceRaw + pool.amountY : 0;
    const ub = userSlotMap.get(slot);
    const userBuy = ub ? ub.buy : 0;
    const userSell = ub ? ub.sell : 0;
    const preview = previewSlotMap.get(slot) || 0;

    const colW = barAreaW * 0.46;

    // Pool bar (left column) — colored by buy/sell side relative to active slot
    if (poolTotal > 0) {
      const barW = (poolTotal / maxPoolLiq) * colW;
      if (slot < activeSlot) {
        ctx.fillStyle = poolBuyColor;
      } else if (slot > activeSlot) {
        ctx.fillStyle = poolSellColor;
      } else {
        ctx.fillStyle = poolNeutralColor;
      }
      ctx.fillRect(xLabelWidth, yCenter - halfBar, barW, barH);
    }

    // User + preview bars (right column)
    const userX = xLabelWidth + barAreaW * 0.54;
    let userDrawn = 0;

    if (userBuy > 0) {
      const barW = (userBuy / maxUserLiq) * colW;
      ctx.fillStyle = userBuyColor;
      ctx.fillRect(userX, yCenter - halfBar, barW, barH);
      userDrawn += barW;
    }
    if (userSell > 0) {
      const barW = (userSell / maxUserLiq) * colW;
      ctx.fillStyle = userSellColor;
      ctx.fillRect(userX + userDrawn, yCenter - halfBar, barW, barH);
      userDrawn += barW;
    }

    if (preview > 0) {
      const previewW = (preview / maxUserLiq) * colW;
      const isSellPreview = slot > activeSlot;
      ctx.fillStyle = isSellPreview ? previewSellColor : previewBuyColor;
      ctx.fillRect(userX + userDrawn, yCenter - halfBar, previewW, barH);
    }
  }

  // Divider line between pool and user columns
  ctx.strokeStyle = hexToRgba(themeColors().wire, 0.15);
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  const divX = xLabelWidth + barAreaW * 0.5;
  ctx.beginPath();
  ctx.moveTo(divX, yMargin);
  ctx.lineTo(divX, H - yMargin);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = '400 9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = themeColors().accent;
  ctx.fillText('POOL', xLabelWidth + barAreaW * 0.24, yMargin - 6);
  ctx.fillText('YOURS', xLabelWidth + barAreaW * 0.76, yMargin - 6);

  // Active bin line at the middle slot
  const activeY = yMargin + barAreaH - (activeSlot + 0.5) * rowH;
  ctx.strokeStyle = themeColors().void;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(xLabelWidth, activeY);
  ctx.lineTo(W - 8, activeY);
  ctx.stroke();

  ctx.fillStyle = themeColors().void;
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  const priceLabel = '$' + formatPrice(binToPrice(activeBin, binStep, state.tokenXDecimals, state.tokenYDecimals));
  ctx.fillText(priceLabel, xLabelWidth - 6, activeY + 3);

  ctx.fillStyle = themeColors().wire;
  ctx.font = '400 9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  const labelInterval = Math.max(5, Math.round(totalBins / 10));
  for (let slot = 0; slot < totalBins; slot += labelInterval) {
    if (slot === activeSlot) continue;
    const y = yMargin + barAreaH - (slot + 0.5) * rowH;
    const rawP = Math.exp(logPriceMin + slot * logSlotStep);
    const price = rawP * Math.pow(10, state.tokenXDecimals - state.tokenYDecimals);
    ctx.fillText('$' + formatPrice(price), xLabelWidth - 6, y + 3);
  }

  Object.assign(vizState.layout, { yMargin, barAreaH, rowH, totalBins, xLabelWidth, W, H, activeSlot });

  renderRangeOverlay(ctx, W, H);

  const metaEl = document.getElementById('binVizMeta');
  if (metaEl && binStep) {
    const poolCount = state.discoveredDlmmPools.length;
    const metaLabel = poolCount > 1
      ? `${poolCount} pools aggregated · ±${vizState.zoomPct}%`
      : `bin step ${binStep} · ±${vizState.zoomPct}%`;
    metaEl.textContent = metaLabel;
  }
}

function renderRangeOverlay(ctx, W, H) {
  const { yMargin, barAreaH, rowH, totalBins, activeSlot } = vizState.layout;
  if (!vizState.binStep || !state.currentPrice || totalBins === 0) return;

  const nearPct = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const farPct = parseFloat(document.getElementById('rangeFar')?.value) || 0;
  if (nearPct === 0 && farPct === 0) return;

  const nearSlot = percentToSlot(nearPct);
  const farSlot = percentToSlot(farPct);
  if (nearSlot == null || farSlot == null) return;

  const nearY = slotToCanvasY(nearSlot);
  const farY = slotToCanvasY(farSlot);
  const topY = Math.min(nearY, farY);
  const bottomY = Math.max(nearY, farY);

  const t = themeColors();
  ctx.fillStyle = hexToRgba(t.dataGreen, 0.08);
  ctx.fillRect(0, topY, W, bottomY - topY);

  const handleColor = hexToRgba(t.dataGreen, 0.6);
  ctx.strokeStyle = handleColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);

  ctx.beginPath();
  ctx.moveTo(0, nearY);
  ctx.lineTo(W, nearY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, farY);
  ctx.lineTo(W, farY);
  ctx.stroke();

  ctx.setLineDash([]);

  const handleR = 6;
  ctx.fillStyle = handleColor;
  ctx.beginPath();
  ctx.arc(W - 14, nearY, handleR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(W - 14, farY, handleR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = hexToRgba(t.void, 0.9);
  ctx.font = '500 8px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', W - 14, nearY + 3);
  ctx.fillText('F', W - 14, farY + 3);
}

export function slotToCanvasY(slot) {
  const { yMargin, barAreaH, rowH } = vizState.layout;
  return yMargin + barAreaH - (slot + 0.5) * rowH;
}

export function canvasYToSlot(y) {
  const { yMargin, barAreaH, rowH } = vizState.layout;
  return (yMargin + barAreaH - y) / rowH - 0.5;
}

export function percentToSlot(pct) {
  if (!state.currentPrice || !vizState.binStep || !vizState.logSlotStep) return null;
  const logStep = Math.log(1 + vizState.binStep / 10000);
  let price;
  if (state.side === 'buy') {
    price = state.currentPrice * (1 - Math.min(pct, 99.99) / 100);
  } else {
    price = state.currentPrice * (1 + Math.max(0, pct) / 100);
  }
  const rawPrice = price / Math.pow(10, state.tokenXDecimals - state.tokenYDecimals);
  const logPrice = Math.log(rawPrice);
  return (logPrice - vizState.logPriceMin) / vizState.logSlotStep;
}

export function slotToPercent(slot) {
  if (!state.currentPrice || !vizState.logSlotStep) return 0;
  const logPrice = vizState.logPriceMin + slot * vizState.logSlotStep;
  const rawPrice = Math.exp(logPrice);
  const price = rawPrice * Math.pow(10, state.tokenXDecimals - state.tokenYDecimals);
  if (state.side === 'buy') {
    return Math.max(0, (1 - price / state.currentPrice) * 100);
  }
  return Math.max(0, (price / state.currentPrice - 1) * 100);
}

export function updateBinVizPreview() {
  if (!state.poolAddress || state.activeBin == null || !state.binStep) return;

  vizState.activeBin = state.activeBin;
  vizState.binStep = state.binStep;

  const amount = parseFloat(document.getElementById('amount')?.value) || 0;
  const { minBin, maxBin } = getRangeBins();
  const decimals = state.side === 'sell' ? state.tokenXDecimals : state.tokenYDecimals;
  const amountLamports = amount * Math.pow(10, decimals);

  vizState.previewBins = computeBidAskPreview(amountLamports, minBin, maxBin, state.activeBin);
  renderBinViz();
}

export async function fetchAggregatedLiquidity(dlmmPools) {
  const primary = dlmmPools[0];
  const primaryBinStep = primary.bin_step ?? primary.binStep;
  const primaryActiveId = primary.active_id ?? primary.activeId ?? primary.active_bin_id;

  const SLOT_COUNT = 400;
  const logRange = Math.log(1 + vizState.zoomPct / 100);
  const primaryLogStep = Math.log(1 + primaryBinStep / 10000);
  const logPriceCenter = primaryActiveId * primaryLogStep;
  const logPriceMin = logPriceCenter - logRange;
  const logSlotStep = (2 * logRange) / SLOT_COUNT;

  const allBinMaps = await Promise.all(
    dlmmPools.map(p => {
      const poolBinStep = p.bin_step ?? p.binStep;
      const poolActiveId = p.active_id ?? p.activeId ?? p.active_bin_id;
      const poolBinsNeeded = Math.ceil(logRange / Math.log(1 + poolBinStep / 10000));
      return fetchBinArrays(p.address, poolActiveId, poolBinsNeeded).catch(() => new Map());
    })
  );

  const merged = new Map();
  for (let i = 0; i < dlmmPools.length; i++) {
    const pool = dlmmPools[i];
    const poolBinStep = pool.bin_step ?? pool.binStep;
    const poolLogStep = Math.log(1 + poolBinStep / 10000);

    for (const [binId, amounts] of allBinMaps[i]) {
      const binLogLow = binId * poolLogStep - poolLogStep / 2;
      const binLogHigh = binId * poolLogStep + poolLogStep / 2;
      const slotLow = Math.max(0, Math.floor((binLogLow - logPriceMin) / logSlotStep));
      const slotHigh = Math.min(SLOT_COUNT - 1, Math.floor((binLogHigh - logPriceMin) / logSlotStep));
      if (slotHigh < 0 || slotLow >= SLOT_COUNT) continue;
      const span = Math.max(1, slotHigh - slotLow + 1);

      for (let s = slotLow; s <= slotHigh; s++) {
        const ex = merged.get(s) || { amountX: 0, amountY: 0 };
        ex.amountX += amounts.amountX / span;
        ex.amountY += amounts.amountY / span;
        merged.set(s, ex);
      }
    }
  }

  vizState.logPriceMin = logPriceMin;
  vizState.logSlotStep = logSlotStep;
  vizState.slotCount = SLOT_COUNT;
  return merged;
}

export async function loadBinVizData() {
  if (!state.poolAddress || !state.activeBin || !state.binStep) return;
  const requestedPool = state.poolAddress;

  if (vizState.fetchController) vizState.fetchController.abort();
  vizState.fetchController = new AbortController();

  vizState.activeBin = state.activeBin;
  vizState.binStep = state.binStep;

  const dlmmPools = state.discoveredDlmmPools.length > 0
    ? state.discoveredDlmmPools
    : [{ address: state.poolAddress, activeId: state.activeBin, active_id: state.activeBin, binStep: state.binStep, bin_step: state.binStep }];

  try {
    const fetchedBins = await fetchAggregatedLiquidity(dlmmPools);
    if (state.poolAddress !== requestedPool) return;
    vizState.poolBins = fetchedBins;
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (CONFIG.DEBUG) console.error('Failed to fetch bin arrays:', err);
    vizState.poolBins = new Map();
  }

  await loadUserBins();
  if (state.poolAddress !== requestedPool) return;
  updateBinVizPreview();
}

export async function loadUserBins() {
  if (!state.poolAddress) return;
  const requestedPool = state.poolAddress;

  // Try real on-chain bin data from bot relay first
  if (state.publicKey) {
    try {
      const data = await relayFetch(
        `/api/user-bins?pool=${state.poolAddress}&owner=${state.publicKey.toBase58()}`
      );
      if (state.poolAddress !== requestedPool) return;
      if (data && data.bins && data.bins.length > 0) {
        const map = new Map();
        for (const b of data.bins) {
          map.set(b.binId, { buy: b.buy || 0, sell: b.sell || 0 });
        }
        vizState.userBins = map;
        if (CONFIG.DEBUG) console.log('[monke] User bins from relay:', map.size);
        return;
      }
    } catch (e) {
      if (CONFIG.DEBUG) console.warn('[monke] Relay user-bins failed, falling back to synthetic:', e);
    }
  }

  // Fallback: synthetic approximation from on-chain position accounts
  try {
    const positions = await fetchUserPositions(state.poolAddress);
    if (state.poolAddress !== requestedPool) return;
    vizState.userBins = aggregateUserBins(positions, state.activeBin);
  } catch {
    vizState.userBins = new Map();
  }
}

// ---------------------------------------------------------------------------
// Late imports to avoid circular dependency issues at module parse time.
// These are used by updateBinVizPreview (getRangeBins), aggregateUserBins
// (computeBidAskPreview), and loadUserBins (fetchUserPositions).
// ---------------------------------------------------------------------------
import { getRangeBins } from '../pages/trade.js';
import { computeBidAskPreview } from '../instructions.js';
import { fetchUserPositions } from '../pages/positions.js';
