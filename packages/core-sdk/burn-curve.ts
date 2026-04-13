/**
 * core-sdk/burn-curve.ts
 *
 * TS mirror of `compute_curve` in programs/bin-farm/src/lib.rs.
 *
 * Used by:
 *   - /burn status Discord command (live curve readout)
 *   - epoch-computer + keeper for sizing decisions
 *   - vitest tests that validate on-chain math against this reference
 *
 * All math in BigInt ppb (parts-per-billion). MUST stay byte-identical to the
 * Rust implementation — if you change one, change both and add a test.
 */

import {
  BURN_CURVE_BREAKPOINT_PPB,
  MAX_PROTOCOL_SKIM_PPB,
  PPB_SCALE,
} from './constants';

export interface CurveResult {
  burnRatioPpb: bigint;
  protocolSkimPpb: bigint;
  traderSolFracPpb: bigint;
}

export function computeCurve(
  currentSupply: bigint,
  initialSupply: bigint,
  burnEnabled: boolean
): CurveResult {
  if (!burnEnabled || initialSupply === 0n) {
    return {
      burnRatioPpb: 0n,
      protocolSkimPpb: MAX_PROTOCOL_SKIM_PPB,
      traderSolFracPpb: PPB_SCALE - MAX_PROTOCOL_SKIM_PPB,
    };
  }

  // Clamp current to initial (in case of post-init mints)
  const current = currentSupply > initialSupply ? initialSupply : currentSupply;
  const remainingPpb = (current * PPB_SCALE) / initialSupply;

  const burnRatioPpb =
    remainingPpb >= BURN_CURVE_BREAKPOINT_PPB
      ? PPB_SCALE
      : (remainingPpb * PPB_SCALE) / BURN_CURVE_BREAKPOINT_PPB;

  const invBurnPpb = PPB_SCALE - burnRatioPpb;
  const protocolSkimPpb = (invBurnPpb * MAX_PROTOCOL_SKIM_PPB) / PPB_SCALE;
  const traderSolFracPpb = PPB_SCALE - burnRatioPpb - protocolSkimPpb;

  return { burnRatioPpb, protocolSkimPpb, traderSolFracPpb };
}

/** Format a ppb value as a human percentage string with 2 decimals. */
export function ppbToPct(ppb: bigint): string {
  const bps = Number(ppb / 100_000n); // ppb / 1e5 = bps × 10
  return (bps / 100).toFixed(2) + '%';
}
