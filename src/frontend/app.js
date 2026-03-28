/**
 * crank.money — Application Entry Point
 *
 * Thin orchestrator: imports all modules, wires event listeners,
 * handles page navigation. No business logic lives here.
 */

import { state } from './state.js';
import { CONFIG, loadConfig } from './constants.js';
import { showToast } from './helpers.js';
import { phantomSDK, connectWallet, disconnectWallet, toggleWalletMenu } from './wallet.js';
import { connectRelay } from './relay.js';

import { updateSide, updateFee, updateBinStrip, createPosition, loadPool,
         discoverAllPoolsForToken, loadAggregatedView } from './pages/trade.js';

import { renderPositionsPage, handleHarvestAll } from './pages/positions.js';

import { initBurnFireCanvas, renderMonkeList, renderRoster, renderGlobalStats,
         handleFeedMonke, handleFeedGoose, handleClaimAll, handleMonkeBurnLookup,
         handleMintPegged, handleRedeemPegged, updatePeggedEstimates,
         showSubPage, ensureBurnFireRunning } from './plugins/rank-monke/index.js';
import { getActivePlugin, mountPlugin, unmountActivePlugin } from './plugin-loader.js';

import { renderOpsStats, renderBountyBoard, preloadFeed,
         handleRoverDeposit, handleCrankSweep, handleCrankStakeForward,
         handleCrankDeposit } from './pages/ops.js';

import { loadReconDashboard, renderReconPoolBreakdown,
         reconPnlData, reconFilter, setReconFilter } from './pages/recon.js';

import { vizState, renderBinViz, loadBinVizData, updateBinVizPreview } from './shared/bin-viz.js';
import { initBinVizTouch } from './shared/bin-viz-touch.js';

import { closePnlModal, downloadPnlCard, copyPnlCard,
         closeUnclaimedWarning } from './shared/pnl-card.js';


// ============================================================
// NAVIGATION
// ============================================================

const ALL_PAGE_IDS = ['page-trade', 'page-positions', 'page-rank', 'page-ops', 'page-recon'];
const ALL_PAGE_NAMES = ['trade', 'positions', 'rank', 'ops', 'recon'];
const PAGE_BODY_CLASSES = ['on-trade', 'on-positions', 'on-rank', 'on-ops', 'on-recon'];

let PAGE_IDS = ALL_PAGE_IDS;

function applyTribePageFilter() {
  const allowedPages = CONFIG.PAGES;
  if (!allowedPages || !Array.isArray(allowedPages)) return;

  PAGE_IDS = [];
  ALL_PAGE_NAMES.forEach((name, i) => {
    if (allowedPages.includes(name)) {
      PAGE_IDS.push(ALL_PAGE_IDS[i]);
    } else {
      const el = document.getElementById(ALL_PAGE_IDS[i]);
      if (el) el.style.display = 'none';
    }
  });

  document.querySelectorAll('.mobile-nav-tab').forEach(tab => {
    const pageIdx = parseInt(tab.dataset.page);
    const pageName = ALL_PAGE_NAMES[pageIdx];
    if (!allowedPages.includes(pageName)) {
      tab.style.display = 'none';
    }
  });

  if (CONFIG.SINGLE_TOKEN) {
    document.body.classList.add('single-token');
  }
}

function showPage(idx) {
  const actualIdx = ALL_PAGE_IDS.indexOf(PAGE_IDS[idx] || ALL_PAGE_IDS[idx]);
  const resolvedIdx = actualIdx >= 0 ? actualIdx : idx;

  state.currentPage = resolvedIdx;
  window._isRankPageVisible = (resolvedIdx === 2);
  if (resolvedIdx === 2) ensureBurnFireRunning();

  window.scrollTo(0, 0);

  ALL_PAGE_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', i === resolvedIdx);
  });

  PAGE_BODY_CLASSES.forEach((cls, i) => {
    document.body.classList.toggle(cls, i === resolvedIdx);
  });

  document.querySelectorAll('.mobile-nav-tab').forEach(tab => {
    const isActive = parseInt(tab.dataset.page) === resolvedIdx;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  if (idx === 0) {
    const orbitals = document.querySelectorAll('.orbital');
    orbitals.forEach((o, i) => o.classList.toggle('sub-active', i === state.activePoolOrbital));
    void document.body.offsetHeight;
    setTimeout(renderBinViz, 50);
  }

  if (idx === 1) {
    renderPositionsPage();
  }

  if (idx === 2) {
    const rankPlugin = getActivePlugin() || mountPlugin('rank-monke', document.getElementById('page-rank'));
    if (rankPlugin && rankPlugin.mount && !getActivePlugin()) rankPlugin.mount(document.getElementById('page-rank'));
    showSubPage(state.currentSubPage);
  } else {
    unmountActivePlugin();
    document.querySelectorAll('.orbital').forEach(o => o.classList.remove('sub-active'));
    document.querySelectorAll('.orbital-sigil').forEach(g => g.setAttribute('opacity', '0'));
  }
}

// ============================================================
// RECON ACCESS CONTROL
// ============================================================

function activateReconPage() {
  const reconEl = document.getElementById('page-recon');
  if (!reconEl) return;
  reconEl.style.display = '';
  reconEl.style.removeProperty('display');
  showPage(PAGE_IDS.indexOf('page-recon'));
  loadReconDashboard();
  showToast('Recon dashboard activated', 'info');
}

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
  await loadConfig();
  applyTribePageFilter();
  connectRelay();
  preloadFeed();

  if (CONFIG.CORE_PROGRAM_ID.includes('1111111111')) {
    const banner = document.createElement('div');
    banner.textContent = 'DEMO MODE — no real transactions';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--alert-red);color:var(--void);text-align:center;padding:4px;z-index:9999;font-size:12px;font-family:inherit;letter-spacing:0.1em;text-transform:uppercase;';
    document.body.prepend(banner);
  }

  document.getElementById('connectWallet')?.addEventListener('click', toggleWalletMenu);

  document.getElementById('loadPool')?.addEventListener('click', loadPool);
  document.getElementById('poolAddress')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const loadBtn = document.getElementById('loadPool');
      if (loadBtn && !loadBtn.disabled) loadPool();
    }
  });

  const ZOOM_STEPS = [10, 20, 50];
  document.getElementById('zoomIn')?.addEventListener('click', () => {
    const curIdx = ZOOM_STEPS.indexOf(vizState.zoomPct);
    const newIdx = Math.max(0, (curIdx >= 0 ? curIdx : 1) - 1);
    vizState.zoomPct = ZOOM_STEPS[newIdx];
    document.getElementById('zoomLevel').textContent = '±' + vizState.zoomPct + '%';
    loadBinVizData();
  });
  document.getElementById('zoomOut')?.addEventListener('click', () => {
    const curIdx = ZOOM_STEPS.indexOf(vizState.zoomPct);
    const newIdx = Math.min(ZOOM_STEPS.length - 1, (curIdx >= 0 ? curIdx : 1) + 1);
    vizState.zoomPct = ZOOM_STEPS[newIdx];
    document.getElementById('zoomLevel').textContent = '±' + vizState.zoomPct + '%';
    loadBinVizData();
  });

  document.querySelectorAll('.side-tab').forEach(tab => {
    tab.addEventListener('click', () => { updateSide(tab.dataset.side); updateBinVizPreview(); });
  });

  document.getElementById('rangeNear')?.addEventListener('input', () => { updateBinStrip(); updateBinVizPreview(); });
  document.getElementById('rangeFar')?.addEventListener('input', () => { updateBinStrip(); updateBinVizPreview(); });

  document.getElementById('amount')?.addEventListener('input', () => { updateFee(); updateBinVizPreview(); });

  document.getElementById('actionBtn')?.addEventListener('click', createPosition);

  initBinVizTouch();

  document.querySelectorAll('.mobile-nav-tab').forEach(tab => {
    tab.addEventListener('click', () => showPage(parseInt(tab.dataset.page)));
  });

  const orbitals = document.querySelectorAll('.orbital');
  orbitals.forEach((o, i) => {
    o.addEventListener('click', () => {
      if (state.currentPage === 2 && o.dataset.sub) {
        showSubPage(o.dataset.sub);
      }
    });
    o.addEventListener('mouseenter', () => {
      if (state.currentPage === 2 && o.dataset.sub) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === o.dataset.sub ? '1' : '0');
        });
      }
    });
    o.addEventListener('mouseleave', () => {
      if (state.currentPage === 2) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === state.currentSubPage ? '0.4' : '0');
        });
      }
    });
  });

  document.getElementById('burnFire1M')?.addEventListener('click', () => {
    if (!state.selectedMonkeMint) { showToast('Select a monke first', 'error'); return; }
    const nft = (state.monkeNfts || []).find(n => n.mint === state.selectedMonkeMint);
    if (nft && nft.gen === 'goose') handleFeedGoose(state.selectedMonkeMint, 1);
    else handleFeedMonke(state.selectedMonkeMint, 1);
  });

  document.querySelectorAll('.burn-amount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const count = parseInt(btn.dataset.count, 10);
      if (!state.selectedMonkeMint) { showToast('Select a monke first', 'error'); return; }
      const nft = (state.monkeNfts || []).find(n => n.mint === state.selectedMonkeMint);
      if (nft && nft.gen === 'goose') handleFeedGoose(state.selectedMonkeMint, count);
      else handleFeedMonke(state.selectedMonkeMint, count);
    });
  });
  document.getElementById('claimAllBtn')?.addEventListener('click', handleClaimAll);

  document.getElementById('monkeBurnSearchBtn')?.addEventListener('click', handleMonkeBurnLookup);
  document.getElementById('monkeBurnLookup')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleMonkeBurnLookup();
  });

  document.getElementById('roverDepositBtn')?.addEventListener('click', handleRoverDeposit);
  document.getElementById('historyClose')?.addEventListener('click', () => {
    document.getElementById('positionHistoryModal')?.classList.remove('visible');
    document.body.classList.remove('modal-open'); document.documentElement.classList.remove('modal-open');
  });

  document.querySelectorAll('.recon-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.recon-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setReconFilter(btn.dataset.filter);
      if (reconPnlData) renderReconPoolBreakdown(reconPnlData.byPool || []);
    });
  });

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('recon') === '1') {
    activateReconPage();
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      activateReconPage();
    }
  });

  document.getElementById('crankSweep')?.addEventListener('click', handleCrankSweep);
  document.getElementById('crankStakeForward')?.addEventListener('click', handleCrankStakeForward);
  document.getElementById('crankDeposit')?.addEventListener('click', handleCrankDeposit);
  document.getElementById('harvestAllBtn')?.addEventListener('click', handleHarvestAll);

  document.getElementById('peggedMintBtn')?.addEventListener('click', handleMintPegged);
  document.getElementById('peggedRedeemBtn')?.addEventListener('click', handleRedeemPegged);
  document.getElementById('peggedMintAmount')?.addEventListener('input', updatePeggedEstimates);
  document.getElementById('peggedRedeemAmount')?.addEventListener('input', updatePeggedEstimates);
  document.getElementById('peggedRedeemMax')?.addEventListener('click', () => {
    const bal = state.peggedUserBalance || 0n;
    const input = document.getElementById('peggedRedeemAmount');
    if (input && bal > 0n) {
      input.value = (Number(bal) / 1e9).toString();
      updatePeggedEstimates();
    }
  });

  document.querySelectorAll('.rank-sub-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.rank-sub-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      showSubPage(tab.dataset.sub);
    });
  });

  document.getElementById('pnlClose')?.addEventListener('click', closePnlModal);
  document.getElementById('pnlDownload')?.addEventListener('click', downloadPnlCard);
  document.getElementById('pnlCopy')?.addEventListener('click', copyPnlCard);

  document.getElementById('warningClaimBtn')?.addEventListener('click', () => {
    closeUnclaimedWarning();
    handleClaimAll();
  });
  document.getElementById('warningDismissBtn')?.addEventListener('click', closeUnclaimedWarning);

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.classList.remove('visible');
        document.body.classList.remove('modal-open'); document.documentElement.classList.remove('modal-open');
      }
    });
  });

  const pages = CONFIG.PAGES;
  const hasPage = (name) => !pages || pages.includes(name);

  if (hasPage('rank')) {
    initBurnFireCanvas();
    renderMonkeList();
    renderRoster();
    renderGlobalStats();
  }
  if (hasPage('ops')) {
    renderOpsStats();
    renderBountyBoard();
  }
  if (hasPage('recon')) {
    loadReconDashboard();
  }

  if (CONFIG.DEFAULT_POOL) {
    const poolInput = document.getElementById('poolAddress');
    if (poolInput) {
      poolInput.value = CONFIG.DEFAULT_POOL;
      discoverAllPoolsForToken(CONFIG.DEFAULT_POOL).then(({ dlmm, damm }) => {
        if (dlmm.length > 0) loadAggregatedView(dlmm, damm);
        else loadPool();
      }).catch(() => loadPool());
    }
  }

  showPage(0);

  setTimeout(() => {
    try {
      if (phantomSDK.solana?.isConnected?.()) connectWallet();
    } catch (_) {}
  }, 500);
}

if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('input, select, textarea')) {
      setTimeout(() => e.target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
    }
  });
}

// Canvas resize handler — only redraw on width change
let resizeTimer;
let lastWindowWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWindowWidth) return;
  lastWindowWidth = window.innerWidth;

  clearTimeout(resizeTimer);
  const delay = ('ontouchstart' in window) ? 350 : 100;
  resizeTimer = setTimeout(() => {
    renderBinViz();
  }, delay);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
