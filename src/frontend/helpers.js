import { CONFIG } from './constants.js';

// --- binToPrice, priceToBin (lines 488-498) ---

export function binToPrice(binId, binStep, decimalsX = 0, decimalsY = 0) {
  const raw = Math.pow(1 + binStep / 10000, binId);
  return raw * Math.pow(10, decimalsX - decimalsY);
}

export function priceToBin(price, binStep, decimalsX = 0, decimalsY = 0, roundDown = true) {
  if (price <= 0) return NaN;
  const raw = price / Math.pow(10, decimalsX - decimalsY);
  const binId = Math.log(raw) / Math.log(1 + binStep / 10000);
  return roundDown ? Math.floor(binId) : Math.ceil(binId);
}

// --- formatPrice, formatAge (lines 500-515) ---

export function formatPrice(price) {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toExponential(2);
}

export function formatAge(unixSeconds) {
  const elapsed = Math.floor(Date.now() / 1000) - unixSeconds;
  if (elapsed < 60) return '<1m';
  if (elapsed < 3600) return Math.floor(elapsed / 60) + 'm';
  if (elapsed < 86400) return Math.floor(elapsed / 3600) + 'h ' + Math.floor((elapsed % 3600) / 60) + 'm';
  const d = Math.floor(elapsed / 86400);
  const h = Math.floor((elapsed % 86400) / 3600);
  return d + 'd ' + h + 'h';
}

// --- calculateFee, calculateAmounts (lines 518-525) ---

/** Fee calculation (from transaction.js) */
export function calculateFee(amount) {
  return Math.floor(amount * CONFIG.FEE_BPS / 10000);
}

export function calculateAmounts(amount) {
  const fee = calculateFee(amount);
  return { fee, net: amount - fee, feePercent: CONFIG.FEE_BPS / 100 };
}

// --- getFillPercent, escapeHtml (lines 812-825) ---

export function getFillPercent(currentAmount, initialAmount) {
  if (initialAmount === 0) return 0;
  const converted = initialAmount - currentAmount;
  if (converted < 0) return 0;
  const fillBps = Math.floor((converted * 10000) / initialAmount);
  return Math.min(fillBps / 10000, 1.0);
}

/** HTML escape to prevent XSS from on-chain data */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// --- formatVolume, timeAgo (lines 1232-1244) ---

export function formatVolume(v) {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}

export function timeAgo(ts) {
  const diff = (Date.now() / 1000) - ts;
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  if (diff < 172800) return 'yesterday';
  return Math.round(diff / 86400) + 'd ago';
}

// --- showToast (lines 5194-5209) ---

export function showToast(msg, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const safeMsg = String(msg).length > 200 ? String(msg).slice(0, 200) + '...' : String(msg);
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = safeMsg;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
window.showToast = showToast;
