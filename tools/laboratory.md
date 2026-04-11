# laboratory.md — Volume & Fee Yield Tracker

Tool for measuring trade volume across PumpSwap and Meteora DLMM pools during a time window, then comparing against expected fee take to verify fee economics.

## Concept

The fee yield tracker answers: "How much volume flowed through both venues since I last claimed, and does the fee accrual match the expected rate?"

### Flow

1. **Start a session** — either manually (`npm run volume start CRANK`) or triggered by a fee claim action (`npm run volume claim CRANK`)
2. **Track volume** — poll PumpSwap and Meteora DLMM volume for the token during the session window
3. **Compare** — total volume × fee rate = expected fees. Compare against actual fees earned.
4. **History** — global historical view across all sessions, cumulative take from both venues

### Commands

```bash
npm run volume start CRANK              # Begin a new tracking session
npm run volume claim CRANK              # Mark a fee claim, close current session, start new one
npm run volume status CRANK             # Show current session: volume, expected fees, elapsed time
npm run volume history CRANK            # Global historical: all sessions, cumulative yield
```

## Open Questions (need Root's input)

### 1. PumpSwap volume source
- **DexScreener API** — has pool-level volume by time period, simplest integration
- **On-chain tx parsing** — most accurate, but complex and slow
- **PumpSwap API** — does pump.fun expose a volume endpoint?
- **Birdeye / other aggregator** — alternative data source

### 2. Fee rates
- **Meteora DLMM** — fee rate is binStep-dependent per pool. What are the actual rates for tracked pools?
- **PumpSwap** — what's the LP fee cut on PumpSwap trades?
- Are we tracking the *total* fee pool or *our share* (based on position size vs total liquidity)?

### 3. Scope
- **Protocol-owned LP only** — fees earned by Root's positions (from `protocol-lp/`)
- **All LPs** — total fees generated across all LPs on both venues
- **Per-community** — track per token pair (CRANK, GSD, etc.)

### 4. PumpSwap pool addresses
- Are these in `curator.json` already or separate?
- Need the PumpSwap pool address for each token being tracked
- Can they be derived from token mint + SOL?

## Planned Architecture

### File: `tools/volume-tracker.ts`

Single-file tool (like `depth.ts`). CLI subcommands via first arg.

### State: `data/volume-tracker-state.json`

```typescript
interface VolumeTrackerState {
  sessions: Session[];
  globalStats: GlobalStats;
}

interface Session {
  id: string;                    // UUID
  token: string;                 // e.g. "CRANK"
  startedAt: number;             // unix ms
  endedAt: number | null;        // null = active session
  startTrigger: 'manual' | 'claim';

  // Volume snapshots at start (baseline)
  pumpswapVolumeAtStart: number;    // USD
  meteoraVolumeAtStart: number;     // USD

  // Latest snapshot
  pumpswapVolumeCurrent: number;
  meteoraVolumeCurrent: number;

  // Deltas (current - start)
  pumpswapVolumeDelta: number;
  meteoraVolumeDelta: number;

  // Fee tracking
  expectedFeesUsd: number;       // volume × fee rate
  actualFeesUsd: number | null;  // from fee claim if available
  feeRatePumpswap: number;       // e.g. 0.0025 (0.25%)
  feeRateMeteora: number;        // e.g. 0.003 (0.3%)
}

interface GlobalStats {
  totalSessions: number;
  totalPumpswapVolume: number;
  totalMeteoraVolume: number;
  totalExpectedFees: number;
  totalActualFees: number;
  firstSessionAt: number;
  lastClaimAt: number;
}
```

### Volume data fetching

```typescript
// Option A: DexScreener (simplest)
async function fetchPoolVolume(poolAddress: string): Promise<{ volume24h: number; volumeTotal: number }> {
  // GET https://api.dexscreener.com/latest/dex/pairs/solana/{address}
  // Returns: pair.volume.h24, pair.volume.h6, etc.
  // Limitation: only gives rolling windows, not arbitrary time ranges
}

// Option B: On-chain signature scanning (most accurate)
async function fetchVolumeFromSignatures(
  poolAddress: string,
  since: number,
): Promise<{ tradeCount: number; volumeUsd: number }> {
  // getSignaturesForAddress → getTransaction for each → parse swap amounts
  // Accurate but expensive (RPC calls) and slow
}

// Option C: Birdeye API (if available)
async function fetchBirdeyeVolume(tokenMint: string, timeFrom: number, timeTo: number) {
  // Birdeye has historical volume endpoints with custom time ranges
  // Requires API key
}
```

### Display (ASCII, like depth.ts)

```
CRANK Volume Tracker — Session #3 (active)
Started: 2026-04-05 14:30 UTC (2h 15m ago)
Trigger: manual start

  Venue          Volume         Expected Fee    Rate
  ─────────────  ─────────────  ──────────────  ─────
  PumpSwap       $12,450        $31.12          0.25%
  Meteora DLMM   $3,200         $9.60          0.30%
  ─────────────  ─────────────  ──────────────  ─────
  Total          $15,650        $40.72

  Actual fees claimed: —
  Yield efficiency: — (claim to compare)

══════════════════════════════════════════════

CRANK Volume History — 12 sessions since 2026-03-15

  Venue          Total Volume   Total Fees     Avg Yield
  ─────────────  ─────────────  ─────────────  ─────────
  PumpSwap       $284,500       $711.25        0.25%
  Meteora DLMM   $67,200        $201.60        0.30%
  ─────────────  ─────────────  ─────────────  ─────────
  Combined       $351,700       $912.85        0.26%

  Claimed total: $887.30
  Efficiency: 97.2% (claimed / expected)
```

## Dependencies

- Same import pattern as `depth.ts` (createRequire for CJS compat)
- `@crankbot/core-sdk` for pool registry, price fetching
- Volume data source TBD (DexScreener, Birdeye, or on-chain)
- State persistence: same atomic write pattern as `protocol-lp/state.ts`

## Notes

- DexScreener gives rolling windows (24h, 6h, 1h) not arbitrary time ranges — may need to poll frequently and accumulate deltas ourselves
- On-chain parsing is the most accurate but most expensive approach
- Could hybrid: use DexScreener for rough estimates, on-chain for reconciliation
- PumpSwap program ID needed for on-chain parsing if we go that route
- Session state survives restarts (persisted to disk)
- Multiple concurrent sessions per token not supported (new start closes old)
