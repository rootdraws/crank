/**
 * bin-viz-touch.js — Touch drag handles for range selection on liquidity canvas
 *
 * Adds two draggable handles (near/far) on the bin visualization canvas.
 * Dragging updates the range input fields and triggers a live preview.
 */

import { vizState, canvasYToSlot, slotToCanvasY, slotToPercent, percentToSlot, renderBinViz, updateBinVizPreview } from './bin-viz.js';
import { state } from '../state.js';
import { updateBinStrip } from '../pages/trade.js';

const HANDLE_GRAB_RADIUS = 28;
let activeHandle = null; // 'near' | 'far' | null

export function initBinVizTouch() {
  const canvas = document.getElementById('binVizCanvas');
  if (!canvas) return;

  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  canvas.addEventListener('touchcancel', onTouchEnd);

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function getCanvasY(clientY) {
  const canvas = document.getElementById('binVizCanvas');
  if (!canvas) return 0;
  const rect = canvas.getBoundingClientRect();
  return (clientY - rect.top) * (canvas.height / (window.devicePixelRatio || 1)) / rect.height;
}

function pickHandle(canvasY) {
  if (!vizState.binStep || !state.currentPrice) return null;

  const nearPct = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const farPct = parseFloat(document.getElementById('rangeFar')?.value) || 0;

  const nearSlot = percentToSlot(nearPct);
  const farSlot = percentToSlot(farPct);
  if (nearSlot == null && farSlot == null) return null;

  const nearY = nearSlot != null ? slotToCanvasY(nearSlot) : Infinity;
  const farY = farSlot != null ? slotToCanvasY(farSlot) : Infinity;

  const dNear = Math.abs(canvasY - nearY);
  const dFar = Math.abs(canvasY - farY);

  if (dNear <= HANDLE_GRAB_RADIUS && dNear <= dFar) return 'near';
  if (dFar <= HANDLE_GRAB_RADIUS) return 'far';

  if (dNear < dFar && dNear < HANDLE_GRAB_RADIUS * 2) return 'near';
  if (dFar < HANDLE_GRAB_RADIUS * 2) return 'far';

  return dNear <= dFar ? 'near' : 'far';
}

function applyDrag(canvasY) {
  if (!activeHandle) return;

  const slot = canvasYToSlot(canvasY);
  const { totalBins, activeSlot } = vizState.layout;
  const clampedSlot = Math.max(0, Math.min(totalBins - 1, slot));

  if (state.side === 'buy' && clampedSlot >= activeSlot) return;
  if (state.side === 'sell' && clampedSlot <= activeSlot) return;

  const pct = slotToPercent(clampedSlot);
  const rounded = Math.round(pct * 100) / 100;

  const inputId = activeHandle === 'near' ? 'rangeNear' : 'rangeFar';
  const input = document.getElementById(inputId);
  if (input) {
    input.value = rounded.toFixed(2);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  updateBinStrip();
  updateBinVizPreview();
}

function onTouchStart(e) {
  if (e.touches.length !== 1) return;
  const y = getCanvasY(e.touches[0].clientY);
  activeHandle = pickHandle(y);
  if (activeHandle) {
    e.preventDefault();
  }
}

function onTouchMove(e) {
  if (!activeHandle || e.touches.length !== 1) return;
  e.preventDefault();
  applyDrag(getCanvasY(e.touches[0].clientY));
}

function onTouchEnd() {
  activeHandle = null;
}

function onMouseDown(e) {
  const y = getCanvasY(e.clientY);
  activeHandle = pickHandle(y);
  if (activeHandle) {
    e.preventDefault();
  }
}

function onMouseMove(e) {
  if (!activeHandle) return;
  e.preventDefault();
  applyDrag(getCanvasY(e.clientY));
}

function onMouseUp() {
  activeHandle = null;
}
