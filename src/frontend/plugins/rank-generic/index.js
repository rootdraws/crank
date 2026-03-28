import { registerPlugin } from '../../plugin-loader.js';
import { state } from '../../state.js';
import { relayFetch } from '../../relay.js';
import { formatPrice, escapeHtml, showToast } from '../../helpers.js';
import { themeColors } from '../../theme.js';

let mounted = false;

async function renderGenericStats(container) {
  const el = (id) => document.getElementById(id);

  const [stats, pnl] = await Promise.all([
    relayFetch('/api/stats').catch(() => null),
    relayFetch('/api/protocol-pnl').catch(() => null),
  ]);

  const rankContent = el('rankContent');
  if (!rankContent) return;

  const totalVolume = stats?.totalVolumeUsd || 0;
  const totalPositions = stats?.totalPositions || 0;
  const totalUsers = stats?.uniqueUsers || 0;
  const netPnl = pnl?.netPnlUsd || 0;

  rankContent.innerHTML = `
    <div class="generic-rank-stats" style="padding: 2rem 1rem; max-width: 480px; margin: 0 auto;">
      <h3 style="color: var(--nerv-orange); margin-bottom: 1.5rem; text-align: center; text-transform: uppercase; letter-spacing: 0.1em;">Protocol Stats</h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
        <div class="stat-card" style="background: var(--void-panel); border-radius: 8px; padding: 1rem; text-align: center;">
          <div style="color: var(--wire-cyan); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;">Total Volume</div>
          <div style="color: var(--thermal-yellow); font-size: 1.25rem; margin-top: 0.5rem;">$${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
        </div>
        <div class="stat-card" style="background: var(--void-panel); border-radius: 8px; padding: 1rem; text-align: center;">
          <div style="color: var(--wire-cyan); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;">Positions</div>
          <div style="color: var(--thermal-yellow); font-size: 1.25rem; margin-top: 0.5rem;">${totalPositions}</div>
        </div>
        <div class="stat-card" style="background: var(--void-panel); border-radius: 8px; padding: 1rem; text-align: center;">
          <div style="color: var(--wire-cyan); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;">Users</div>
          <div style="color: var(--thermal-yellow); font-size: 1.25rem; margin-top: 0.5rem;">${totalUsers}</div>
        </div>
        <div class="stat-card" style="background: var(--void-panel); border-radius: 8px; padding: 1rem; text-align: center;">
          <div style="color: var(--wire-cyan); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;">Net PnL</div>
          <div style="color: ${netPnl >= 0 ? 'var(--data-green)' : 'var(--nerv-orange-hot)'}; font-size: 1.25rem; margin-top: 0.5rem;">${netPnl >= 0 ? '+' : ''}$${Math.abs(netPnl).toFixed(2)}</div>
        </div>
      </div>
    </div>`;
}

export function showSubPage() {}
export function ensureBurnFireRunning() {}

const plugin = {
  id: 'rank-generic',
  label: 'Stats',
  pageIndex: 2,

  register(ctx) {},

  mount(container) {
    mounted = true;
    renderGenericStats(container);
  },

  unmount() {
    mounted = false;
  },

  onWalletConnect() {
    if (mounted) renderGenericStats();
  },

  onWalletDisconnect() {
    if (mounted) renderGenericStats();
  },
};

registerPlugin(plugin);
export default plugin;
