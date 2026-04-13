/**
 * burn-curve.test.ts
 *
 * TS tests for the supply-driven burn curve. MUST stay byte-identical with
 * `compute_curve` in programs/bin-farm/src/lib.rs — if on-chain and off-chain
 * math diverge, /burn status will lie and tests will catch it.
 *
 * Run: npx vitest run bot/burn-curve.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  computeCurve,
  ppbToPct,
  BURN_CURVE_BREAKPOINT_PPB,
  MAX_PROTOCOL_SKIM_PPB,
  PPB_SCALE,
} from '../packages/core-sdk';

describe('compute_curve — reference values', () => {
  const INITIAL = 2_000_000_000_000_000n; // 2B with 6 decimals (CRANK cap)

  it('100% supply → full magnesium (100% burn, 0% protocol)', () => {
    const r = computeCurve(INITIAL, INITIAL, true);
    expect(r.burnRatioPpb).toBe(PPB_SCALE);
    expect(r.protocolSkimPpb).toBe(0n);
    expect(r.traderSolFracPpb).toBe(0n);
  });

  it('75% supply — breakpoint, still full burn', () => {
    const supply = (INITIAL * 75n) / 100n;
    const r = computeCurve(supply, INITIAL, true);
    expect(r.burnRatioPpb).toBe(PPB_SCALE);
    expect(r.protocolSkimPpb).toBe(0n);
  });

  it('50% supply — mid transition, burn ≈ 0.6667', () => {
    const supply = INITIAL / 2n;
    const r = computeCurve(supply, INITIAL, true);
    // remaining = 0.50, burn_ratio = 0.50 / 0.75 = 0.6667
    // protocol_skim = 0.20 × (1 - 0.6667) = 0.0667
    expect(r.burnRatioPpb).toBe(666_666_666n);
    expect(r.protocolSkimPpb).toBe(66_666_666n);
    expect(r.traderSolFracPpb).toBe(PPB_SCALE - r.burnRatioPpb - r.protocolSkimPpb);
  });

  it('25% supply — burn ≈ 0.3333', () => {
    const supply = INITIAL / 4n;
    const r = computeCurve(supply, INITIAL, true);
    expect(r.burnRatioPpb).toBe(333_333_333n);
    // protocol_skim = 0.20 × (1 - 0.3333) = 0.1333
    expect(r.protocolSkimPpb).toBe(133_333_333n);
  });

  it('0% supply — full embers (0% burn, 20% protocol, 80% trader)', () => {
    const r = computeCurve(0n, INITIAL, true);
    expect(r.burnRatioPpb).toBe(0n);
    expect(r.protocolSkimPpb).toBe(MAX_PROTOCOL_SKIM_PPB);
    expect(r.traderSolFracPpb).toBe(PPB_SCALE - MAX_PROTOCOL_SKIM_PPB);
  });
});

describe('compute_curve — invariants', () => {
  const INITIAL = 2_000_000_000_000_000n;

  it('burn + protocol + trader = PPB_SCALE (rounding-safe)', () => {
    const points = [100, 90, 75, 74, 60, 50, 40, 30, 20, 10, 5, 1, 0];
    for (const pct of points) {
      const supply = (INITIAL * BigInt(pct)) / 100n;
      const r = computeCurve(supply, INITIAL, true);
      const sum = r.burnRatioPpb + r.protocolSkimPpb + r.traderSolFracPpb;
      expect(sum).toBe(PPB_SCALE);
    }
  });

  it('burn_ratio monotonically decreases with falling supply', () => {
    const supplies = [100, 75, 60, 45, 30, 15, 0].map(p => (INITIAL * BigInt(p)) / 100n);
    const ratios = supplies.map(s => computeCurve(s, INITIAL, true).burnRatioPpb);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeLessThanOrEqual(ratios[i - 1]);
    }
  });

  it('protocol_skim monotonically increases as supply depletes', () => {
    const supplies = [100, 75, 60, 45, 30, 15, 0].map(p => (INITIAL * BigInt(p)) / 100n);
    const skims = supplies.map(s => computeCurve(s, INITIAL, true).protocolSkimPpb);
    for (let i = 1; i < skims.length; i++) {
      expect(skims[i]).toBeGreaterThanOrEqual(skims[i - 1]);
    }
  });
});

describe('compute_curve — kill switch', () => {
  const INITIAL = 2_000_000_000_000_000n;

  it('kill switch OFF at 100% supply → 80/20 trader/protocol, zero burn', () => {
    const r = computeCurve(INITIAL, INITIAL, false);
    expect(r.burnRatioPpb).toBe(0n);
    expect(r.protocolSkimPpb).toBe(MAX_PROTOCOL_SKIM_PPB);
    expect(r.traderSolFracPpb).toBe(PPB_SCALE - MAX_PROTOCOL_SKIM_PPB);
  });

  it('kill switch OFF at 0% supply → identical to ON at 0% (end state convergence)', () => {
    const off = computeCurve(0n, INITIAL, false);
    const on = computeCurve(0n, INITIAL, true);
    expect(off.burnRatioPpb).toBe(on.burnRatioPpb);
    expect(off.protocolSkimPpb).toBe(on.protocolSkimPpb);
  });
});

describe('compute_curve — edge cases', () => {
  it('initial_supply = 0 → kill switch fallback', () => {
    const r = computeCurve(0n, 0n, true);
    expect(r.burnRatioPpb).toBe(0n);
    expect(r.protocolSkimPpb).toBe(MAX_PROTOCOL_SKIM_PPB);
  });

  it('current > initial (post-init mints) → clamped to initial (full burn)', () => {
    const INITIAL = 1_000_000_000_000_000n;
    const r = computeCurve(INITIAL + 10_000n, INITIAL, true);
    expect(r.burnRatioPpb).toBe(PPB_SCALE);
  });

  it('breakpoint exactly — 75% supply', () => {
    const INITIAL = 4n * BURN_CURVE_BREAKPOINT_PPB / 3n * 1_000_000_000n / PPB_SCALE * 1_000_000_000n;
    // Just verify the breakpoint behavior: remaining_ppb = 750M should give burn_ratio = 1.0
    const supply = (INITIAL * 75n) / 100n;
    const r = computeCurve(supply, INITIAL, true);
    expect(r.burnRatioPpb).toBe(PPB_SCALE);
  });
});

describe('ppbToPct', () => {
  it('formats full scale as 100.00%', () => {
    expect(ppbToPct(PPB_SCALE)).toBe('100.00%');
  });

  it('formats zero as 0.00%', () => {
    expect(ppbToPct(0n)).toBe('0.00%');
  });

  it('formats 20% skim correctly', () => {
    expect(ppbToPct(MAX_PROTOCOL_SKIM_PPB)).toBe('20.00%');
  });
});
