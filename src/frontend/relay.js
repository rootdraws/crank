// ============================================================
// relay.js — Bot Relay WebSocket + REST connection to LaserStream
// Extracted from public/app.js (Phase 1 structural extraction)
// ============================================================

import { state } from './state.js';
import { CONFIG } from './constants.js';
import { binToPrice, formatPrice } from './helpers.js';

// Forward imports — modules created in later phases
import { addFeedEvent } from './pages/ops.js';
import { refreshPositionsList, renderPositionsPage } from './pages/positions.js';
import { patchBinArrayCache, renderBinVizDebounced, renderBinViz, loadBinVizData, loadUserBins, vizState } from './shared/bin-viz.js';

// ============================================================
// MODULE STATE
// ============================================================

let relayWs = null;
export let relayConnected = false;
let relayRetries = 0;
const RELAY_MAX_RETRIES = 10;
const RELAY_BASE_DELAY = 5000;

// ============================================================
// CONNECT
// ============================================================

export function connectRelay() {
  const url = CONFIG.BOT_RELAY_URL;
  if (!url) return;
  if (relayRetries >= RELAY_MAX_RETRIES) {
    if (CONFIG.DEBUG) console.log('[relay] Max retries reached — bot offline');
    return;
  }

  try {
    relayWs = new WebSocket(url + '/ws');

    relayWs.onopen = () => {
      relayConnected = true;
      relayRetries = 0;
      if (CONFIG.DEBUG) console.log('[relay] Connected to bot relay');
      const statusEl = document.getElementById('opsBotStatus');
      if (statusEl) statusEl.textContent = 'connected';
    };

    relayWs.onclose = () => {
      relayConnected = false;
      const statusEl = document.getElementById('opsBotStatus');
      if (statusEl) statusEl.textContent = 'offline';
      relayRetries++;
      if (relayRetries < RELAY_MAX_RETRIES) {
        const delay = RELAY_BASE_DELAY * Math.pow(2, relayRetries - 1);
        if (CONFIG.DEBUG) console.log(`[relay] Reconnecting in ${delay / 1000}s (attempt ${relayRetries}/${RELAY_MAX_RETRIES})`);
        setTimeout(connectRelay, delay);
      }
    };

    relayWs.onerror = () => {
      relayConnected = false;
    };

    relayWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRelayEvent(msg);
      } catch {}
    };
  } catch {
    relayRetries++;
    if (relayRetries < RELAY_MAX_RETRIES) {
      setTimeout(connectRelay, RELAY_BASE_DELAY * Math.pow(2, relayRetries - 1));
    }
  }
}

// ============================================================
// EVENT HANDLING
// ============================================================

export function handleRelayEvent(msg) {
  switch (msg.type) {
    case 'activeBinChanged': {
      // Update price if we're watching the primary pool
      const isWatchedPool = state.poolAddress && (
        msg.data.lbPair === state.poolAddress ||
        state.discoveredDlmmPools.some(p => p.address === msg.data.lbPair)
      );
      if (isWatchedPool) {
        if (msg.data.lbPair === state.poolAddress && state.binStep && state.tokenXDecimals !== undefined && state.tokenYDecimals !== undefined) {
          const newPrice = binToPrice(msg.data.newActiveId, state.binStep, state.tokenXDecimals, state.tokenYDecimals);
          state.currentPrice = newPrice;
          state.activeBin = msg.data.newActiveId;
          const priceEl = document.getElementById('currentPrice');
          if (priceEl) priceEl.textContent = '$' + formatPrice(newPrice);
          vizState.activeBin = msg.data.newActiveId;
        }
        loadBinVizData();
      }
      break;
    }

    case 'binArrayUpdated':
      if (msg.data && msg.data.lbPair && state.discoveredDlmmPools.some(p => p.address === msg.data.lbPair)) {
        patchBinArrayCache(msg.data);
        renderBinVizDebounced();
      }
      break;

    case 'harvestExecuted':
    case 'positionClosed':
    case 'positionChanged':
      addFeedEvent(formatRelayEvent(msg));
      refreshPositionsList();
      if (state.currentPage === 1) renderPositionsPage();
      loadUserBins().then(() => renderBinViz());
      break;

    case 'harvestNeeded':
      addFeedEvent(formatRelayEvent(msg));
      break;
    case 'roverTvlUpdated':
      if (msg.data?.totalTvl > 0) addFeedEvent(formatRelayEvent(msg));
      break;

    case 'feedHistory':
      if (msg.data && Array.isArray(msg.data)) {
        const feed = document.getElementById('activityFeed');
        const hasFeedContent = feed && feed.children.length > 0 && !feed.querySelector('.empty-state');
        if (!hasFeedContent) {
          for (const evt of [...msg.data].reverse()) {
            const text = evt.text || formatRelayEvent(evt);
            if (text.includes('rover TVL') && text.includes('$0')) continue;
            addFeedEvent(text, evt.timestamp);
          }
        }
      }
      break;
  }
}

// ============================================================
// FORMAT
// ============================================================

export function formatRelayEvent(msg) {
  const d = msg.data || {};
  const pool = (d.lbPair || '').slice(0, 8);
  const owner = (d.owner || '').slice(0, 6);
  const side = d.side ? ` · ${d.side.toLowerCase()}` : '';
  switch (msg.type) {
    case 'harvestExecuted':
      return `harvested ${d.binCount || '?'} bins · ${pool}...${side} → ${owner}...`;
    case 'positionClosed':
      return `closed · ${pool}...${side} → ${owner}...`;
    case 'harvestNeeded':
      return `${d.safeBinCount || '?'} bins ready · ${pool}...${side}`;
    case 'positionChanged':
      return `position ${d.action || '?'} · ${pool}...${side}`;
    case 'activeBinChanged': {
      const dir = d.previousActiveId != null
        ? (d.newActiveId > d.previousActiveId ? ' ▲' : d.newActiveId < d.previousActiveId ? ' ▼' : '')
        : '';
      if (state.binStep && state.tokenXDecimals !== undefined) {
        const price = binToPrice(d.newActiveId, state.binStep, state.tokenXDecimals, state.tokenYDecimals);
        return `${pool}... $${formatPrice(price)}${dir}`;
      }
      return `${pool}... bin ${d.newActiveId}${dir}`;
    }
    case 'roverTvlUpdated':
      return `rover TVL: ${d.count || 0} pools · $${(d.totalTvl || 0).toFixed(0)}`;
    default:
      return `${msg.type}: ${JSON.stringify(d).slice(0, 80)}`;
  }
}

// ============================================================
// REST HELPER
// ============================================================

export async function relayFetch(path, options = {}) {
  if (!CONFIG.BOT_RELAY_URL) return null;
  const baseUrl = CONFIG.BOT_RELAY_URL.replace('ws://', 'http://').replace('wss://', 'https://');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const opts = { ...options, signal: controller.signal };
    if (opts.body && !opts.headers) opts.headers = { 'Content-Type': 'application/json' };
    const resp = await fetch(baseUrl + path, opts);
    clearTimeout(timer);
    if (resp.ok) return resp.json();
  } catch {}
  clearTimeout(timer);
  return null;
}
