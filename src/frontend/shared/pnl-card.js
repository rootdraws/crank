import { state } from '../state.js';
import { CONFIG } from '../constants.js';
import { formatPrice, showToast } from '../helpers.js';
import { themeColors } from '../theme.js';

export function renderPnlCard(position) {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const containerW = canvas.parentElement?.clientWidth || Math.min(660, window.innerWidth - 32);
  const cssW = Math.min(1200, containerW);
  const cssH = Math.round(cssW * 675 / 1200);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW;
  const h = cssH;

  ctx.fillStyle = themeColors().thermal;
  ctx.fillRect(0, 0, w, h);

  const arcR = 60;
  const margin = 30;
  ctx.strokeStyle = themeColors().wire;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);

  // Top-left arc
  ctx.beginPath();
  ctx.arc(margin + arcR, margin + arcR, arcR, Math.PI, Math.PI * 1.5);
  ctx.stroke();
  // Top-right arc
  ctx.beginPath();
  ctx.arc(w - margin - arcR, margin + arcR, arcR, Math.PI * 1.5, Math.PI * 2);
  ctx.stroke();
  // Bottom-left arc
  ctx.beginPath();
  ctx.arc(margin + arcR, h - margin - arcR, arcR, Math.PI * 0.5, Math.PI);
  ctx.stroke();
  // Bottom-right arc
  ctx.beginPath();
  ctx.arc(w - margin - arcR, h - margin - arcR, arcR, 0, Math.PI * 0.5);
  ctx.stroke();

  ctx.setLineDash([]);

  // Determine profit/loss
  const pnl = position.lpFees || 0;
  const isProfit = pnl > 0;
  const accentColor = isProfit ? themeColors().dataGreen : themeColors().accentHot;

  // Accent: colored inner arcs
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  const innerR = 40;
  ctx.beginPath();
  ctx.arc(margin + arcR, margin + arcR, innerR, Math.PI, Math.PI * 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w - margin - arcR, margin + arcR, innerR, Math.PI * 1.5, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(margin + arcR, h - margin - arcR, innerR, Math.PI * 0.5, Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w - margin - arcR, h - margin - arcR, innerR, 0, Math.PI * 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const fontBase = "'IBM Plex Mono', monospace";
  const s = cssW < 500 ? 0.6 : 1;

  ctx.font = `500 ${Math.round(28 * s)}px ${fontBase}`;
  ctx.fillStyle = themeColors().void;
  ctx.textAlign = 'left';
  ctx.fillText(position.pool, margin + 20 * s, margin + 70 * s);

  ctx.font = `500 ${Math.round(15 * s)}px ${fontBase}`;
  ctx.fillStyle = position.side === 'buy' ? themeColors().dataGreen : themeColors().accentHot;
  ctx.fillText(position.side.toUpperCase(), margin + 20 * s, margin + 100 * s);

  ctx.font = `400 ${Math.round(17 * s)}px ${fontBase}`;
  ctx.fillStyle = themeColors().wire;
  ctx.fillText(`$${formatPrice(position.minPrice)} - $${formatPrice(position.maxPrice)}`, margin + 20 * s, h / 2 - 20 * s);

  ctx.font = `400 ${Math.round(15 * s)}px ${fontBase}`;
  ctx.fillStyle = themeColors().wire;
  ctx.fillText(`${position.filled}% filled`, margin + 20 * s, h / 2 + 10 * s);

  ctx.fillText(`LP fees: ${(position.lpFees || 0).toFixed(4)} SOL`, margin + 20 * s, h / 2 + 40 * s);

  ctx.font = `700 ${Math.round(50 * s)}px ${fontBase}`;
  ctx.fillStyle = accentColor;
  ctx.textAlign = 'right';
  const pnlText = (isProfit ? '+' : '') + pnl.toFixed(4) + ' SOL';
  ctx.fillText(pnlText, w - margin - 20 * s, h / 2 + 15 * s);

  ctx.font = `400 ${Math.round(13 * s)}px ${fontBase}`;
  ctx.fillStyle = themeColors().wire;
  ctx.fillText('EST. FEES', w - margin - 20 * s, h / 2 - 30 * s);

  ctx.font = `400 ${Math.round(11 * s)}px ${fontBase}`;
  ctx.fillStyle = themeColors().wire;
  ctx.textAlign = 'center';
  ctx.letterSpacing = '2px';
  ctx.fillText('HARVESTED BY CRANK.MONEY', w / 2, h - margin - 10 * s);
}

export function showPnlModal(positionIndex) {
  const position = state.positions[positionIndex];
  if (!position) return;

  renderPnlCard(position);

  const modal = document.getElementById('pnlModal');
  if (modal) { modal.classList.add('visible'); document.body.classList.add('modal-open'); document.documentElement.classList.add('modal-open'); }
}

export function closePnlModal() {
  const modal = document.getElementById('pnlModal');
  if (modal) { modal.classList.remove('visible'); document.body.classList.remove('modal-open'); document.documentElement.classList.remove('modal-open'); }
}

export async function downloadPnlCard() {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'crank-pnl.png';
    a.click();
  } catch {
    showToast('Download failed', 'error');
  }
}

export async function copyPnlCard() {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (blob) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Copied to clipboard', 'success');
    }
  } catch {
    // Fallback for mobile Safari / browsers without ClipboardItem support
    try {
      const url = URL.createObjectURL(await new Promise(resolve => canvas.toBlob(resolve, 'image/png')));
      const a = document.createElement('a');
      a.href = url; a.download = 'crank-pnl.png'; a.click();
      URL.revokeObjectURL(url);
      showToast('Downloaded as image', 'success');
    } catch {
      showToast('Copy failed — try screenshot instead', 'error');
    }
  }
}

// ============================================================
// UNCLAIMED REWARDS WARNING
// ============================================================

export function showUnclaimedWarning(amount) {
  const modal = document.getElementById('unclaimedWarning');
  const amountEl = document.getElementById('unclaimedAmount');
  const token = CONFIG.PEGGED_MINT ? '$PEGGED' : 'SOL';
  if (amountEl) amountEl.textContent = amount.toFixed(4) + ' ' + token;
  if (modal) { modal.classList.add('visible'); document.body.classList.add('modal-open'); document.documentElement.classList.add('modal-open'); }
}

export function closeUnclaimedWarning() {
  const modal = document.getElementById('unclaimedWarning');
  if (modal) { modal.classList.remove('visible'); document.body.classList.remove('modal-open'); document.documentElement.classList.remove('modal-open'); }
}
