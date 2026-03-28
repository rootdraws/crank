import { state } from '../state.js';
import { CONFIG } from '../constants.js';
import { formatPrice, escapeHtml, showToast } from '../helpers.js';
import { relayFetch } from '../relay.js';

let reconPnlData = null;
let reconFilter = 'all';

export { reconPnlData, reconFilter };

export function setReconFilter(val) { reconFilter = val; }

export async function loadReconDashboard() {
  const el = id => document.getElementById(id);
  const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };

  const [pnlData, botWallet, fees, stats, roverTop5] = await Promise.all([
    relayFetch('/api/protocol-pnl').catch(() => null),
    relayFetch('/api/bot-wallet').catch(() => null),
    relayFetch('/api/fees').catch(() => null),
    relayFetch('/api/stats').catch(() => null),
    relayFetch('/api/rovers/top5').catch(() => null),
  ]);

  if (pnlData) {
    reconPnlData = pnlData;
    renderReconDashboard(pnlData);

    const totalDep = (pnlData.byPool || []).reduce((s, p) => s + parseFloat(p.depositedUsd || 0), 0);
    const totalWith = (pnlData.byPool || []).reduce((s, p) => s + parseFloat(p.withdrawnUsd || 0), 0);
    setText('reconTotalDeposited', '$' + totalDep.toLocaleString(undefined, { maximumFractionDigits: 0 }));
    setText('reconTotalWithdrawn', '$' + totalWith.toLocaleString(undefined, { maximumFractionDigits: 0 }));
    const profitable = (pnlData.byPool || []).filter(p => parseFloat(p.netPnlUsd) > 0).length;
    const unprofitable = (pnlData.byPool || []).filter(p => parseFloat(p.netPnlUsd) <= 0).length;
    setText('reconProfitableCount', profitable.toString());
    setText('reconUnprofitableCount', unprofitable.toString());
  } else {
    const bd = el('reconPoolBreakdown');
    if (bd) bd.innerHTML = '<div class="empty-state">bot relay unavailable — protocol PnL requires the bot</div>';
  }

  if (botWallet) {
    setText('reconBotBalance', botWallet.balanceSol?.toFixed(4) + ' SOL');
    const balEl = el('reconBotBalance');
    if (balEl) balEl.className = 'stat-value ' + (botWallet.status === 'critical' ? 'red' : botWallet.status === 'warning' ? 'yellow' : 'green');
    setText('reconBotSpendRate', botWallet.spendRatePerHour != null ? botWallet.spendRatePerHour.toFixed(4) + ' SOL/hr' : '—');
    setText('reconBotRunway', botWallet.estimatedHoursRemaining != null ? botWallet.estimatedHoursRemaining.toFixed(1) + 'h' : '—');
    setText('reconBotStatus', botWallet.status || '—');
    const statusEl = el('reconBotStatus');
    if (statusEl) statusEl.className = 'stat-value ' + (botWallet.status === 'healthy' ? 'green' : botWallet.status === 'warning' ? 'yellow' : 'red');
    setText('reconBotUptime', botWallet.uptimeHours != null ? botWallet.uptimeHours.toFixed(1) + 'h' : '—');
  }

  if (fees) {
    const rover = fees.roverAuthority || {};
    setText('reconRoverSol', (rover.solBalance || 0).toFixed(4));
    setText('reconRoverWsol', (rover.wsolBalance || 0).toFixed(4));
    const dist = fees.distPool || {};
    setText('reconDistSol', (dist.solBalance || 0).toFixed(4));
    setText('reconDistPegged', dist.peggedBalance != null ? dist.peggedBalance.toFixed(2) : '—');
    const vault = fees.programVault || {};
    setText('reconVaultSol', (vault.solBalance || 0).toFixed(4));
    setText('reconVaultPegged', vault.peggedBalance != null ? vault.peggedBalance.toFixed(2) : '—');
    setText('reconTotalPipeline', (fees.totalInPipeline || 0).toFixed(4) + ' SOL');
  }

  if (stats) {
    setText('reconWatchedPools', stats.watchedPools?.toString() || '0');
    setText('reconGrpcReconnects', stats.grpcReconnects?.toString() || '0');
    setText('reconTotalCloses', stats.totalCloses?.toString() || '0');
    setText('reconQueueDepth', stats.queueDepth?.toString() || '0');
    setText('reconInflightTxs', stats.inflightTxs?.toString() || '0');
    setText('reconWsClients', stats.wsClients?.toString() || '0');
  }

  if (roverTop5?.top5) {
    const lb = el('reconRoverLeaderboard');
    if (lb) {
      if (roverTop5.top5.length === 0) {
        lb.innerHTML = '<div class="empty-state">no rovers active</div>';
      } else {
        lb.innerHTML = '<div class="recon-pool-header"><span>#</span><span>pool</span><span>TVL</span></div>' +
          roverTop5.top5.map(r => `<div class="recon-pool-row"><span>${r.rank}</span><span>${(r.pool || '').slice(0, 8)}...</span><span>$${(r.tvl || 0).toFixed(2)}</span></div>`).join('');
      }
    }
  }
}

export function renderReconDashboard(data) {
  const el = id => document.getElementById(id);

  const wr = el('reconWinRate');
  if (wr) {
    const pct = (data.winRate * 100).toFixed(1);
    wr.textContent = pct + '%';
    wr.className = 'stat-value ' + (data.winRate >= 0.5 ? 'green' : '');
  }

  const netPnl = parseFloat(data.netPnlUsd);
  if (el('reconNetPnl')) {
    el('reconNetPnl').textContent = (netPnl >= 0 ? '+' : '') + '$' + Math.abs(netPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    el('reconNetPnl').className = 'stat-value ' + (netPnl >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  if (el('reconPosCount')) el('reconPosCount').textContent = `${data.openPositions} open / ${data.closedPositions} closed`;
  if (el('reconFeesEarned')) el('reconFeesEarned').textContent = '$' + parseFloat(data.totalFeesUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (el('reconAvgReturn')) {
    el('reconAvgReturn').textContent = (data.avgReturnPct >= 0 ? '+' : '') + data.avgReturnPct.toFixed(2) + '%';
    el('reconAvgReturn').className = 'stat-value ' + (data.avgReturnPct >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  // Side stats
  const buy = data.bySide?.buy || {};
  const sell = data.bySide?.sell || {};
  if (el('reconBuyWr')) el('reconBuyWr').textContent = ((buy.winRate || 0) * 100).toFixed(1) + '%';
  if (el('reconBuyCount')) el('reconBuyCount').textContent = (buy.count || 0) + ' positions';
  if (el('reconBuyPnl')) {
    const v = parseFloat(buy.netPnlUsd || '0');
    el('reconBuyPnl').textContent = (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
    el('reconBuyPnl').className = 'recon-side-pnl ' + (v >= 0 ? 'pnl-positive' : 'pnl-negative');
  }
  if (el('reconSellWr')) el('reconSellWr').textContent = ((sell.winRate || 0) * 100).toFixed(1) + '%';
  if (el('reconSellCount')) el('reconSellCount').textContent = (sell.count || 0) + ' positions';
  if (el('reconSellPnl')) {
    const v = parseFloat(sell.netPnlUsd || '0');
    el('reconSellPnl').textContent = (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
    el('reconSellPnl').className = 'recon-side-pnl ' + (v >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  // Rover
  if (data.roverPortfolio?.total) {
    const rt = data.roverPortfolio.total;
    const roverPnl = parseFloat(rt.totalPnlUsd || '0');
    if (el('reconRoverPnl')) {
      el('reconRoverPnl').textContent = (roverPnl >= 0 ? '+$' : '-$') + Math.abs(roverPnl).toFixed(2);
      el('reconRoverPnl').className = 'stat-value ' + (roverPnl >= 0 ? 'pnl-positive' : 'pnl-negative');
    }
    const roverSection = el('reconRoverSection');
    if (roverSection) {
      const openPools = data.roverPortfolio.open?.pools || [];
      if (openPools.length > 0) {
        roverSection.innerHTML = openPools.map(p => `
          <div class="recon-pool-row">
            <span>${escapeHtml(p.tokenX || '?')}/${escapeHtml(p.tokenY || '?')}</span>
            <span>${p.openPositionCount || 0}</span>
            <span>—</span>
            <span>$${parseFloat(p.balances || '0').toFixed(2)}</span>
            <span class="${parseFloat(p.pnl || '0') >= 0 ? 'pnl-positive' : 'pnl-negative'}">
              ${parseFloat(p.pnl || '0') >= 0 ? '+' : ''}$${parseFloat(p.pnl || '0').toFixed(2)}
            </span>
          </div>
        `).join('');
      } else {
        roverSection.innerHTML = '<div class="empty-state">no open rover positions</div>';
      }
    }
  } else {
    if (el('reconRoverPnl')) el('reconRoverPnl').textContent = '—';
    const roverSection = el('reconRoverSection');
    if (roverSection) roverSection.innerHTML = '<div class="empty-state">rover data unavailable</div>';
  }

  renderReconPoolBreakdown(data.byPool || []);
}

export function renderReconPoolBreakdown(pools) {
  const container = document.getElementById('reconPoolBreakdown');
  if (!container) return;

  let filtered = pools;
  if (reconFilter === 'profitable') filtered = pools.filter(p => parseFloat(p.netPnlUsd) > 0);
  else if (reconFilter === 'unprofitable') filtered = pools.filter(p => parseFloat(p.netPnlUsd) <= 0);

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">no pools match filter</div>';
    return;
  }

  container.innerHTML = filtered.map(p => {
    const pnl = parseFloat(p.netPnlUsd);
    return `<div class="recon-pool-row">
      <span>${escapeHtml(p.name)}</span>
      <span>${p.positions}</span>
      <span>${(p.winRate * 100).toFixed(0)}%</span>
      <span>$${parseFloat(p.depositedUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      <span class="${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}</span>
    </div>`;
  }).join('');
}

