import { state } from '../state.js';
import { CONFIG, getConfigPDA, getPositionPDA, getVaultPDA, getPositionCounterPDA, getMeteoraPosiitonPDA, getRoverAuthorityPDA, getAssociatedTokenAddressSync, createAssociatedTokenAccountIx, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, SPL_MEMO_PROGRAM_ID, deriveBinArrayPDA, deriveEventAuthorityPDA, deriveBitmapExtPDA, binIdToBinArrayIndex, buildInitBinArrayIx, METEORA_DLMM_PROGRAM } from '../constants.js';
import { binToPrice, priceToBin, formatPrice, formatAge, calculateFee, calculateAmounts, escapeHtml, showToast, formatVolume } from '../helpers.js';
import { makeComputeUnitPriceIx, kitIxToWeb3, asSigner, preSimulate, walletSendTransaction, getPoolALT, preSimulateVersioned, confirmAndCheck, ensureAccountsSetup, toEncodedAccount, DEFAULT_PRIORITY_MICROLAMPORTS } from '../wallet.js';
import { relayFetch } from '../relay.js';
import { loadOnChainFeeBps, getMintDecimals, ensureBinArraysExist, resolveMeteoraCPIAccounts, getOpenPositionV2InstructionAsync, decodePosition, BIN_FARM_PROGRAM_ADDRESS, Side, computeBidAskPreview } from '../instructions.js';
import { renderBinViz, loadBinVizData, loadUserBins, updateBinVizPreview, vizState, fetchAggregatedLiquidity } from '../shared/bin-viz.js';

import { address } from '@solana/kit';

// ============================================================
// LbPair layout constants (verified against Meteora DLMM IDL)
// ============================================================

const LBPAIR_EXPECTED_SIZE = 904;
const LBPAIR_OFFSETS = {
  ACTIVE_ID: 76,       // i32
  BIN_STEP: 80,        // u16
  TOKEN_X_MINT: 88,    // pubkey (32 bytes)
  TOKEN_Y_MINT: 120,   // pubkey (32 bytes)
  RESERVE_X: 152,      // pubkey (32 bytes)
  RESERVE_Y: 184,      // pubkey (32 bytes)
  TOKEN_X_PROG_FLAG: 880, // u8 (0=SPL, 1=Token-2022)
  TOKEN_Y_PROG_FLAG: 881, // u8
};

const KNOWN_TOKENS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jitoSOL',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump': 'CRANK',
};

// ============================================================
// Pool Discovery constants
// ============================================================

const METEORA_API_BASE = () => CONFIG.METEORA_API_URL || 'https://dlmm.datapi.meteora.ag';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ============================================================
// PERCENTAGE RANGE — bin math from user-entered percentages
// ============================================================

export function percentToPrice(pct, side) {
  if (!state.currentPrice) return 0;
  if (side === 'buy') {
    const safePct = Math.min(pct, 99.99);
    return state.currentPrice * (1 - safePct / 100);
  }
  return state.currentPrice * (1 + Math.max(0, pct) / 100);
}

export function getRangeBins() {
  const near = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const far = parseFloat(document.getElementById('rangeFar')?.value) || 0;
  const nearPrice = percentToPrice(near, state.side);
  const farPrice = percentToPrice(far, state.side);
  // For buy: far is lower price (more bins below), near is higher
  // For sell: near is lower price, far is higher
  const minBin = priceToBin(Math.min(nearPrice, farPrice), state.binStep, state.tokenXDecimals, state.tokenYDecimals);
  const maxBin = priceToBin(Math.max(nearPrice, farPrice), state.binStep, state.tokenXDecimals, state.tokenYDecimals, false);
  return { minBin, maxBin };
}

// ============================================================
// UI UPDATES
// ============================================================

export function updateSide(newSide) {
  state.side = newSide;
  document.querySelectorAll('.side-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.side-tab.${newSide}`)?.classList.add('active');

  const btn = document.getElementById('actionBtn');
  if (btn) {
    btn.className = 'action-btn ' + newSide;
    btn.textContent = newSide === 'buy' ? 'buy' : 'sell';
  }

  const tok = document.getElementById('amountToken');
  if (tok) tok.textContent = newSide === 'buy' ? state.tokenYSymbol : state.tokenXSymbol;

  // Update range suffix text and default values
  const suffix = newSide === 'buy' ? 'percent below price.' : 'percent above price.';
  const suffixEl = document.getElementById('rangeSuffix');
  const suffixFarEl = document.getElementById('rangeSuffixFar');
  if (suffixEl) suffixEl.textContent = suffix;
  if (suffixFarEl) suffixFarEl.textContent = suffix;

  const nearInput = document.getElementById('rangeNear');
  const farInput = document.getElementById('rangeFar');
  if (nearInput) nearInput.value = newSide === 'buy' ? '1' : '1';
  if (farInput) farInput.value = newSide === 'buy' ? '5' : '5';

  updateFee();
  updateBinStrip();
}

export async function updateFee() {
  const el = document.getElementById('feeAmount');
  if (!el) return;

  if (!state.connected || !state.connection || !state.publicKey) {
    el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
    return;
  }

  try {
    const mint = state.side === 'buy' ? state.tokenYMint : state.tokenXMint;
    const decimals = state.side === 'buy' ? state.tokenYDecimals : state.tokenXDecimals;
    const symbol = state.side === 'buy' ? (state.tokenYSymbol || 'SOL') : (state.tokenXSymbol || 'TOKEN');
    if (!mint) { el.textContent = `${CONFIG.FEE_BPS / 100}% on output`; return; }

    let rawAmount;
    if (mint === NATIVE_MINT.toBase58() || mint === 'So11111111111111111111111111111111111111112') {
      rawAmount = await state.connection.getBalance(state.publicKey);
    } else {
      const mintPk = new solanaWeb3.PublicKey(mint);
      const atas = await state.connection.getTokenAccountsByOwner(state.publicKey, { mint: mintPk });
      rawAmount = 0;
      for (const { account } of atas.value) {
        rawAmount += Number(account.data.readBigUInt64LE(64));
      }
    }
    el.textContent = `balance: ${(rawAmount / Math.pow(10, decimals)).toFixed(4)} ${symbol}`;
  } catch {
    el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
  }
}

export function updateBinStrip() {
  if (!state.currentPrice || !state.activeBin) return;

  const near = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const far = parseFloat(document.getElementById('rangeFar')?.value) || 0;

  const rangeEl = document.getElementById('binStripRange');
  const activeEl = document.getElementById('binStripActive');
  const nearLabel = document.getElementById('binStripNear');
  const farLabel = document.getElementById('binStripFar');
  const currentLabel = document.getElementById('binStripCurrent');
  if (!rangeEl || !activeEl) return;

  const maxPct = Math.max(far, near) * 1.3;
  if (maxPct <= 0) return;

  if (state.side === 'buy') {
    const rangeLeft = (1 - far / maxPct) * 100;
    const rangeWidth = ((far - near) / maxPct) * 100;
    const activePos = (1 - 0 / maxPct) * 100;
    rangeEl.style.left = rangeLeft + '%';
    rangeEl.style.width = Math.max(rangeWidth, 1) + '%';
    rangeEl.style.background = 'var(--data-green-faint)';
    activeEl.style.left = Math.min(activePos, 99) + '%';
    if (nearLabel) nearLabel.textContent = '-' + near + '%';
    if (farLabel) farLabel.textContent = '-' + far + '%';
  } else {
    const rangeLeft = (near / maxPct) * 100;
    const rangeWidth = ((far - near) / maxPct) * 100;
    const activePos = 0;
    rangeEl.style.left = rangeLeft + '%';
    rangeEl.style.width = Math.max(rangeWidth, 1) + '%';
    rangeEl.style.background = 'var(--alert-red-fill)';
    activeEl.style.left = activePos + '%';
    if (nearLabel) nearLabel.textContent = '+' + near + '%';
    if (farLabel) farLabel.textContent = '+' + far + '%';
  }

  if (currentLabel) currentLabel.textContent = '$' + formatPrice(state.currentPrice);
}

// ============================================================
// POOL PARSING — on-chain LbPair account data
// ============================================================

export async function parseLbPair(address) {
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const pubkey = new solanaWeb3.PublicKey(address);

  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const accountInfo = await conn.getAccountInfo(pubkey);

  if (!accountInfo) throw new Error('Account not found — check the address');
  if (accountInfo.data.length !== LBPAIR_EXPECTED_SIZE) {
    throw new Error(`Not a DLMM pool (expected ${LBPAIR_EXPECTED_SIZE} bytes, got ${accountInfo.data.length})`);
  }

  const data = accountInfo.data;
  const activeId = data.readInt32LE(LBPAIR_OFFSETS.ACTIVE_ID);
  const binStep = data.readUInt16LE(LBPAIR_OFFSETS.BIN_STEP);

  if (binStep === 0 || binStep > 500) {
    throw new Error(`Invalid bin_step ${binStep} — account may not be an LbPair`);
  }

  const tokenXMint = new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_X_MINT, LBPAIR_OFFSETS.TOKEN_X_MINT + 32));
  const tokenYMint = new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_Y_MINT, LBPAIR_OFFSETS.TOKEN_Y_MINT + 32));

  return { activeId, binStep, tokenXMint, tokenYMint };
}

export async function parseLbPairFull(address) {
  const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
  const pubkey = new solanaWeb3.PublicKey(address);
  const accountInfo = await conn.getAccountInfo(pubkey);
  if (!accountInfo) throw new Error('Account not found');
  if (accountInfo.data.length !== LBPAIR_EXPECTED_SIZE) throw new Error('Not a DLMM pool');
  const data = accountInfo.data;
  return {
    activeId: data.readInt32LE(LBPAIR_OFFSETS.ACTIVE_ID),
    binStep: data.readUInt16LE(LBPAIR_OFFSETS.BIN_STEP),
    tokenXMint: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_X_MINT, LBPAIR_OFFSETS.TOKEN_X_MINT + 32)),
    tokenYMint: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_Y_MINT, LBPAIR_OFFSETS.TOKEN_Y_MINT + 32)),
    reserveX: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.RESERVE_X, LBPAIR_OFFSETS.RESERVE_X + 32)),
    reserveY: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.RESERVE_Y, LBPAIR_OFFSETS.RESERVE_Y + 32)),
    tokenXProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_X_PROG_FLAG),
    tokenYProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_Y_PROG_FLAG),
  };
}

export async function resolveTokenSymbol(mintPubkey) {
  const addr = mintPubkey.toBase58();
  if (KNOWN_TOKENS[addr]) return KNOWN_TOKENS[addr];

  try {
    const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: addr },
      }),
    });
    const json = await resp.json();
    const symbol = json?.result?.content?.metadata?.symbol;
    if (symbol) {
      KNOWN_TOKENS[addr] = symbol;
      return symbol;
    }
  } catch {}

  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

// ============================================================
// POOL DISCOVERY — Meteora DataPI + address book
// ============================================================

export async function discoverAllPoolsForToken(mintAddress) {
  const DAMM_API_BASE = CONFIG.DAMM_API_URL || 'https://damm-v2.datapi.meteora.ag';
  const quoteKeys = [SOL_MINT, USDC_MINT].map(quote => [mintAddress, quote].sort().join('-'));

  const [dlmmSol, dlmmUsdc, dammSol, dammUsdc] = await Promise.all([
    fetch(`${METEORA_API_BASE()}/pools/groups/${quoteKeys[0]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    fetch(`${METEORA_API_BASE()}/pools/groups/${quoteKeys[1]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    fetch(`${DAMM_API_BASE}/pools/groups/${quoteKeys[0]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    fetch(`${DAMM_API_BASE}/pools/groups/${quoteKeys[1]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
  ]);

  const dlmmPools = [...(dlmmSol.data || []), ...(dlmmUsdc.data || [])]
    .filter(p => !p.is_blacklisted)
    .sort((a, b) => (b.volume?.['24h'] || 0) - (a.volume?.['24h'] || 0));

  // Normalize API response shape: the DataAPI nests bin_step inside pool_config
  // and never returns active_id — derive it from current_price and token decimals.
  for (const p of dlmmPools) {
    if (p.bin_step == null && p.pool_config?.bin_step != null) {
      p.bin_step = p.pool_config.bin_step;
    }
    if (p.active_id == null && p.current_price > 0 && p.bin_step) {
      const decimalsX = p.token_x?.decimals ?? 9;
      const decimalsY = p.token_y?.decimals ?? 6;
      const rawPrice = p.current_price / Math.pow(10, decimalsX - decimalsY);
      p.active_id = Math.round(Math.log(rawPrice) / Math.log(1 + p.bin_step / 10000));
    }
  }

  const dammPools = [...(dammSol.data || []), ...(dammUsdc.data || [])]
    .filter(p => !p.is_blacklisted)
    .sort((a, b) => (b.volume?.['24h'] || 0) - (a.volume?.['24h'] || 0));

  // Tag DAMM pools so renderPoolPicker can badge them
  dammPools.forEach(p => { p._source = 'damm'; });

  // Register known symbols
  for (const p of [...dlmmPools, ...dammPools]) {
    if (p.token_x?.symbol) KNOWN_TOKENS[p.token_x?.address] = p.token_x.symbol;
    if (p.token_y?.symbol) KNOWN_TOKENS[p.token_y?.address] = p.token_y.symbol;
  }

  return { dlmm: dlmmPools, damm: dammPools };
}

export async function loadAggregatedView(dlmmPools, dammPools) {
  state.tokenMint = document.getElementById('poolAddress')?.value.trim();
  state.discoveredDlmmPools = dlmmPools;
  state.discoveredDammPools = dammPools;

  const primary = dlmmPools[0];
  state.poolAddress = primary.address;
  state.activeBin = primary.active_id ?? primary.activeId ?? primary.active_bin_id;
  state.binStep = primary.bin_step ?? primary.binStep;
  state.tokenXSymbol = primary.token_x?.symbol || 'TOKEN';
  state.tokenYSymbol = primary.token_y?.symbol || 'SOL';
  state.tokenXMint = primary.token_x?.address || null;
  state.tokenYMint = primary.token_y?.address || null;

  if (state.tokenXMint) {
    const [dX, dY] = await Promise.all([getMintDecimals(state.tokenXMint), getMintDecimals(state.tokenYMint)]);
    state.tokenXDecimals = dX;
    state.tokenYDecimals = dY;
  }

  state.currentPrice = binToPrice(state.activeBin, state.binStep, state.tokenXDecimals, state.tokenYDecimals);

  document.getElementById('poolName').textContent = `${state.tokenXSymbol}/${state.tokenYSymbol}`;
  document.getElementById('currentPrice').textContent = '$' + formatPrice(state.currentPrice);
  document.getElementById('poolInfo').classList.add('visible');

  updatePoolMetrics(primary);

  // Show/hide DAMM TVL info
  let dammInfoEl = document.getElementById('dammTvlInfo');
  if (dammPools.length > 0) {
    const totalTvl = dammPools.reduce((sum, p) => sum + (p.tvl || p.liquidity || 0), 0);
    const tvlStr = totalTvl >= 1e6 ? '$' + (totalTvl / 1e6).toFixed(1) + 'M'
                 : totalTvl >= 1e3 ? '$' + (totalTvl / 1e3).toFixed(0) + 'K'
                 : '$' + Math.round(totalTvl);
    if (!dammInfoEl) {
      dammInfoEl = document.createElement('div');
      dammInfoEl.id = 'dammTvlInfo';
      dammInfoEl.className = 'damm-tvl-info';
      document.getElementById('poolInfo').after(dammInfoEl);
    }
    dammInfoEl.textContent = `+ ${tvlStr} DAMM v2 liquidity (${dammPools.length} pool${dammPools.length > 1 ? 's' : ''})`;
    dammInfoEl.style.display = '';
  } else if (dammInfoEl) {
    dammInfoEl.style.display = 'none';
  }

  // Primary pool selector when multiple DLMM pools exist
  const selectWrap = document.getElementById('primaryPoolSelectWrap');
  const select = document.getElementById('primaryPoolSelect');
  if (selectWrap && select && dlmmPools.length > 1) {
    select.innerHTML = dlmmPools.map((p, i) => {
      const label = `${p.token_x?.symbol || '?'}/${p.token_y?.symbol || '?'} · ${p.bin_step ?? p.binStep} bps`;
      return `<option value="${i}">${label}</option>`;
    }).join('');
    selectWrap.style.display = '';
    select.onchange = () => {
      const idx = parseInt(select.value, 10);
      const pool = state.discoveredDlmmPools[idx];
      state.poolAddress = pool.address;
      state.activeBin = pool.active_id ?? pool.activeId ?? pool.active_bin_id;
      state.binStep = pool.bin_step ?? pool.binStep;
      state.currentPrice = binToPrice(state.activeBin, state.binStep, state.tokenXDecimals, state.tokenYDecimals);
      document.getElementById('currentPrice').textContent = '$' + formatPrice(state.currentPrice);
      loadUserBins();
      updateBinVizPreview();
    };
  } else if (selectWrap) {
    selectWrap.style.display = 'none';
  }

  updateSide(state.side);

  // Restore form sections in case they were hidden by createPoolPanel
  document.querySelector('.side-tabs')?.style.setProperty('display', '');
  document.querySelector('.range-section')?.style.setProperty('display', '');
  document.querySelector('.amount-section')?.style.setProperty('display', '');
  document.getElementById('createPoolPanel')?.style.setProperty('display', 'none');

  showToast(`Found ${dlmmPools.length} DLMM pool${dlmmPools.length > 1 ? 's' : ''}`, 'success');
  loadBinVizData();
  if (state.connected) refreshPositionsList();

  // Notify relay to watch these pools for bin array updates
  const poolAddresses = dlmmPools.map(p => p.address);
  relayFetch('/api/subscribe-pools', { method: 'POST', body: JSON.stringify({ pools: poolAddresses }) }).catch(() => {});
}

export function showCreatePoolUI(mint, dammPools) {
  state.tokenMint = mint;
  state.discoveredDlmmPools = [];
  state.discoveredDammPools = dammPools || [];

  document.querySelector('.side-tabs').style.display = 'none';
  document.querySelector('.range-section').style.display = 'none';
  document.querySelector('.amount-section').style.display = 'none';
  const panel = document.getElementById('createPoolPanel');
  if (panel) panel.style.display = '';

  showToast('No DLMM pool found — create one to get started', 'info');

  const btn = document.getElementById('createPoolBtn');
  if (btn) btn.onclick = createDlmmPool;
}

export async function createDlmmPool() {
  if (!state.connected || !state.publicKey) {
    showToast('Connect wallet first', 'error');
    return;
  }
  const btn = document.getElementById('createPoolBtn');
  const binStep = parseInt(document.getElementById('createPoolBinStep')?.value || '100', 10);
  if (btn) { btn.textContent = 'creating...'; btn.disabled = true; }

  try {
    const body = JSON.stringify({ tokenMint: state.tokenMint, quoteMint: SOL_MINT, binStep });
    const result = await relayFetch('/api/init-pool-tx', { method: 'POST', body });
    if (!result || !result.transaction) throw new Error('Failed to build pool creation transaction');

    const txBytes = Uint8Array.from(atob(result.transaction), c => c.charCodeAt(0));
    const tx = solanaWeb3.Transaction.from(txBytes);
    const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = state.publicKey;

    const signed = await window.phantom?.solana?.signTransaction(tx);
    if (!signed) throw new Error('Transaction rejected by wallet');

    const sig = await conn.sendRawTransaction(signed.serialize());
    await conn.confirmTransaction(sig, 'confirmed');

    showToast('Pool created! Loading...', 'success');
    document.querySelector('.side-tabs').style.display = '';
    document.querySelector('.range-section').style.display = '';
    document.querySelector('.amount-section').style.display = '';
    document.getElementById('createPoolPanel').style.display = 'none';

    document.getElementById('poolAddress').value = result.poolAddress;
    await loadPool();
  } catch (err) {
    console.error('[createPool]', err);
    showToast(err.message || 'Pool creation failed', 'error');
  } finally {
    if (btn) { btn.textContent = 'create pool'; btn.disabled = false; }
  }
}

export function renderPoolPicker(pools) {
  const container = document.getElementById('poolPicker');
  if (!container) return;

  container.innerHTML = pools.slice(0, 10).map(p => {
    const name = p.name || `${p.token_x?.symbol || '?'}/${p.token_y?.symbol || '?'}`;
    const isDamm = p._source === 'damm';
    const typeBadge = isDamm
      ? `<span class="picker-type damm-badge">DAMM v2</span>`
      : `<span class="picker-type dlmm-badge">DLMM · ${p.bin_step ?? p.pool_config?.bin_step ?? '?'} bps</span>`;
    const vol = formatVolume(p.volume?.['24h'] || 0);
    const tvl = formatVolume(p.tvl || p.liquidity || 0);
    return `<button class="picker-row${isDamm ? ' picker-row-damm' : ''}" data-pool="${p.address}" data-damm="${isDamm}">
      <span class="picker-name">${name}</span>
      ${typeBadge}
      <span class="picker-meta">${vol} vol · ${tvl} tvl</span>
    </button>`;
  }).join('');

  container.style.display = 'block';

  container.querySelectorAll('.picker-row').forEach(row => {
    row.addEventListener('click', () => {
      if (row.dataset.damm === 'true') {
        showToast('DAMM v2 — view only. Select a DLMM pool to open positions.', 'info');
        return;
      }
      document.getElementById('poolAddress').value = row.dataset.pool;
      hidePoolPicker();
      loadPool();
    });
  });
}

export function hidePoolPicker() {
  const picker = document.getElementById('poolPicker');
  if (picker) picker.style.display = 'none';
}

export async function loadPool() {
  const addr = document.getElementById('poolAddress')?.value.trim();
  if (!addr) { showToast('Enter a token or pool address', 'error'); return; }

  const btn = document.getElementById('loadPool');
  if (btn) { btn.textContent = 'loading...'; btn.disabled = true; }

  try {
    let pubkey;
    try { pubkey = new solanaWeb3.PublicKey(addr); }
    catch { throw new Error('Invalid Solana address'); }

    hidePoolPicker();

    // Resolve the input to a token mint for discovery.
    // Whether the user enters a token CA or a specific pool address, we always
    // discover all DLMM/DAMM pools for that token and show the aggregated view.
    let tokenMintForDiscovery = addr;
    let preferredPoolAddress = null;
    let fallbackPool = null; // used if the entered pool isn't indexed by the API

    // Step 1 — try relay (fast path for known LP pairs)
    const relayData = await relayFetch(`/api/pools/${addr}`);
    if (relayData && relayData.activeId !== undefined) {
      let xMint = relayData.tokenXMint;
      let yMint = relayData.tokenYMint;
      if (!xMint) {
        const poolData = await parseLbPairFull(addr);
        xMint = poolData.tokenXMint.toBase58();
        yMint = poolData.tokenYMint.toBase58();
      }
      tokenMintForDiscovery = [xMint, yMint].find(m => m && m !== SOL_MINT && m !== USDC_MINT) || xMint;
      preferredPoolAddress = addr;
      fallbackPool = {
        address: addr,
        active_id: relayData.activeId,
        bin_step: relayData.binStep,
        token_x: { address: xMint, symbol: relayData.tokenXSymbol || KNOWN_TOKENS[xMint] || 'TOKEN' },
        token_y: { address: yMint, symbol: relayData.tokenYSymbol || KNOWN_TOKENS[yMint] || 'SOL' },
      };
    } else {
      // Step 2 — try direct on-chain parse
      const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
      const accountInfo = await conn.getAccountInfo(pubkey);
      if (!accountInfo) throw new Error('Account not found — check the address');

      if (accountInfo.data.length === LBPAIR_EXPECTED_SIZE) {
        // It's a raw LP pair account
        const pool = await parseLbPair(addr);
        const xMint = pool.tokenXMint.toBase58();
        const yMint = pool.tokenYMint.toBase58();
        const [symX, symY] = await Promise.all([resolveTokenSymbol(pool.tokenXMint), resolveTokenSymbol(pool.tokenYMint)]);
        tokenMintForDiscovery = [xMint, yMint].find(m => m !== SOL_MINT && m !== USDC_MINT) || xMint;
        preferredPoolAddress = addr;
        fallbackPool = {
          address: addr,
          active_id: pool.activeId,
          bin_step: pool.binStep,
          token_x: { address: xMint, symbol: symX },
          token_y: { address: yMint, symbol: symY },
        };
      }
      // else: it's a token mint — tokenMintForDiscovery is already addr
    }

    if (btn) { btn.textContent = 'searching...'; }
    const { dlmm, damm } = await discoverAllPoolsForToken(tokenMintForDiscovery);

    // If the user entered a specific pool, make sure it's in the list.
    // Promote it to primary (index 0) if found, or inject it if the API missed it.
    if (preferredPoolAddress) {
      const idx = dlmm.findIndex(p => p.address === preferredPoolAddress);
      if (idx > 0) {
        const [preferred] = dlmm.splice(idx, 1);
        dlmm.unshift(preferred);
      } else if (idx === -1 && fallbackPool) {
        dlmm.unshift(fallbackPool);
      }
    }

    if (dlmm.length > 0) {
      await loadAggregatedView(dlmm, damm);
    } else {
      showCreatePoolUI(tokenMintForDiscovery, damm);
    }
  } catch (err) {
    console.error('Failed to load pool:', err);
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'load'; btn.disabled = false; }
  }
}

// ============================================================
// POSITION CREATION
// ============================================================

export async function createPosition() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  if (!state.poolAddress || state.activeBin == null || !state.currentPrice) {
    showToast('Waiting for pool data...', 'error'); return;
  }

  const amount = parseFloat(document.getElementById('amount')?.value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }

  const { minBin, maxBin } = getRangeBins();

  if (isNaN(minBin) || isNaN(maxBin)) {
    showToast('Invalid price range', 'error'); return;
  }

  if (state.side === 'buy' && maxBin >= state.activeBin) {
    showToast('Buy range must be below current price', 'error'); return;
  }
  if (state.side === 'sell' && minBin <= state.activeBin) {
    showToast('Sell range must be above current price', 'error'); return;
  }

  const btn = document.getElementById('actionBtn');
  const original = btn?.textContent;
  if (btn) { btn.textContent = 'creating...'; btn.disabled = true; }

  try {
    showToast('Building transaction...', 'info');

    const decimals = state.side === 'sell' ? state.tokenXDecimals : state.tokenYDecimals;
    const depositAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));
    if (depositAmount <= 0n) {
      showToast('Amount too small for token decimals', 'error');
      if (btn) { btn.textContent = original; btn.disabled = false; }
      return;
    }
    const numBins = maxBin - minBin + 1;

    if (numBins > 70) {
      const maxSpread = (state.binStep * 70 / 100).toFixed(2);
      showToast(`Range too wide: ${numBins} bins (max 70). Narrow to ≤${maxSpread}% spread or use a higher bin-step pool.`, 'error');
      if (btn) { btn.textContent = original; btn.disabled = false; }
      return;
    }

    if (CONFIG.DEBUG) {
      console.log(`[monke] Create ${state.side} position`);
      console.log(`  Amount: ${amount} (${depositAmount} lamports, ${decimals} decimals)`);
      console.log(`  Bins: ${minBin} -> ${maxBin} (${numBins} bins)`);
    }

    const conn = state.connection;
    const user = state.publicKey;
    const coreProgramId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

    // Resolve all Meteora CPI accounts from on-chain pool data
    showToast('Resolving accounts...', 'info');
    const cpi = await resolveMeteoraCPIAccounts(state.poolAddress, minBin, maxBin);

    // Deposit token: sell = token X, buy = token Y (SOL)
    const depositMint = state.side === 'sell' ? cpi.tokenXMint : cpi.tokenYMint;
    const depositTokenProgramId = state.side === 'sell' ? cpi.tokenXProgramId : cpi.tokenYProgramId;

    // Derive meteora position as PDA (single-signer: no keypair needed)
    const [counterPDA] = getPositionCounterPDA(user, cpi.lbPair);
    let posCounter = 0;
    try {
      const counterInfo = await conn.getAccountInfo(counterPDA);
      if (counterInfo && counterInfo.data.length >= 16) {
        posCounter = Number(new DataView(counterInfo.data.buffer, counterInfo.data.byteOffset).getBigUint64(8, true));
      }
    } catch { /* counter doesn't exist yet — first position, count = 0 */ }
    const [meteoraPositionPDA] = getMeteoraPosiitonPDA(user, cpi.lbPair, posCounter);

    const [configPDA] = getConfigPDA();
    const [positionPDA] = getPositionPDA(meteoraPositionPDA);
    const [vaultPDA] = getVaultPDA(meteoraPositionPDA);

    const userTokenAccount = getAssociatedTokenAddressSync(depositMint, user, false, depositTokenProgramId);

    const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
    const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);

    // --- Setup TX: ATAs, bin arrays, SOL wrapping (standard SPL ops only) ---
    const isNativeSol = depositMint.equals(NATIVE_MINT);
    const initBinArrayIxs = await ensureBinArraysExist(cpi.lbPair, minBin, maxBin, user, cpi.dlmmProgram);
    const extraSetupIxs = [...initBinArrayIxs];
    if (isNativeSol) extraSetupIxs.push(...buildWrapSolIxs(user, userTokenAccount, depositAmount));

    await ensureAccountsSetup(conn, user, [
      { ata: userTokenAccount, owner: user, mint: depositMint, tokenProgram: depositTokenProgramId },
      { ata: vaultTokenX, owner: vaultPDA, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: vaultTokenY, owner: vaultPDA, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    ], extraSetupIxs);

    // --- Execute TX: compute budget + openPositionV2 only ---
    const slippage = state.binStep >= 80 ? 15 : 5;
    const bitmapExtWritable = !cpi.binArrayBitmapExt.equals(cpi.dlmmProgram);

    if (CONFIG.DEBUG) console.log('[monke] Open position V2:', { amount: depositAmount.toString(), minBin, maxBin });

    const openIx = await getOpenPositionV2InstructionAsync({
      user: asSigner(user),
      lbPair: address(cpi.lbPair.toBase58()),
      positionCounter: address(counterPDA.toBase58()),
      meteoraPosition: address(meteoraPositionPDA.toBase58()),
      binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
      reserveX: address(cpi.reserveX.toBase58()),
      reserveY: address(cpi.reserveY.toBase58()),
      userTokenAccount: address(userTokenAccount.toBase58()),
      vaultTokenX: address(vaultTokenX.toBase58()),
      vaultTokenY: address(vaultTokenY.toBase58()),
      tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
      tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
      binArrayLower: address(cpi.binArrayLower.toBase58()),
      binArrayUpper: address(cpi.binArrayUpper.toBase58()),
      eventAuthority: address(cpi.eventAuthority.toBase58()),
      dlmmProgram: address(cpi.dlmmProgram.toBase58()),
      tokenXMint: address(cpi.tokenXMint.toBase58()),
      tokenYMint: address(cpi.tokenYMint.toBase58()),
      amount: BigInt(depositAmount.toString()),
      minBinId: minBin,
      maxBinId: maxBin,
      side: state.side === 'buy' ? Side.Buy : Side.Sell,
      maxActiveBinSlippage: slippage,
    });
    const openWeb3Ix = kitIxToWeb3(openIx);
    if (bitmapExtWritable) {
      const bmIdx = openWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
      if (bmIdx >= 0) openWeb3Ix.keys[bmIdx].isWritable = true;
    }

    const altAccount = await getPoolALT();

    const ixs = [
      solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS),
      openWeb3Ix,
    ];

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const messageV0 = new solanaWeb3.TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message([altAccount]);

    const vtx = new solanaWeb3.VersionedTransaction(messageV0);

    await preSimulateVersioned(vtx);
    showToast('Approve in wallet...', 'info');
    const result = await phantomSDK.solana.signAndSendTransaction(vtx);
    const sig = result?.signature || result?.hash || (typeof result === 'string' ? result : undefined);
    if (!sig) throw new Error('Wallet returned no transaction signature');
    showToast('Confirming...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);

    showToast('Position created!', 'success');
    if (CONFIG.DEBUG) console.log(`[monke] Position tx: ${sig}`);

    await refreshPositionsList();
    loadBinVizData();
    if (state.currentPage === 1) renderPositionsPage();
  } catch (err) {
    console.error('Position creation failed:', err);
    showToast('Failed: ' + (err?.message || err), 'error');
  } finally {
    if (btn) { btn.textContent = original; btn.disabled = false; }
  }
}

// ============================================================
// POOL METRICS + OHLCV CHART
// ============================================================

export function updatePoolMetrics(poolData) {
  const metricsEl = document.getElementById('poolMetrics');
  if (!metricsEl) return;

  const apr = poolData.apr;
  const feeTvl = poolData.fee_tvl_ratio?.['24h'];
  const dynFee = poolData.dynamic_fee_pct ?? poolData.pool_config?.base_fee_pct;
  const cumVol = poolData.cumulative_metrics?.volume;

  if (apr != null || feeTvl != null || cumVol != null || dynFee != null) {
    const aprEl = document.getElementById('poolApr');
    const feeTvlEl = document.getElementById('poolFeeTvl');
    const dynFeeEl = document.getElementById('poolDynFee');
    const cumVolEl = document.getElementById('poolCumVol');

    if (aprEl) aprEl.textContent = apr != null ? (apr * 100).toFixed(1) + '%' : '—';
    if (feeTvlEl) feeTvlEl.textContent = feeTvl != null ? (feeTvl * 100).toFixed(2) + '%' : '—';
    if (dynFeeEl) dynFeeEl.textContent = dynFee != null ? dynFee.toFixed(2) + '%' : '—';
    if (cumVolEl) cumVolEl.textContent = cumVol != null ? formatVolume(cumVol) : '—';
    metricsEl.style.display = '';
  } else {
    metricsEl.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// Late imports to avoid circular dependency at module parse time.
// refreshPositionsList / renderPositionsPage are used by createPosition and
// loadAggregatedView respectively.
// ---------------------------------------------------------------------------
import { refreshPositionsList, renderPositionsPage } from './positions.js';
import { buildWrapSolIxs } from '../constants.js';
