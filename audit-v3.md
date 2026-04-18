# crank.money Audit v3 — Open Punch List

**Date:** 2026-04-17
**Source:** Items carried forward from `audit-v2.md` after the 2026-04-15 / 2026-04-17 HIGH sweep. Full finding bodies (Impact, PoC, Recommendation) live in `audit-v2.md` — this file is the working worklist.

## Session handoff (2026-04-17, end of day)

**Status of shipped items in this file:** all "Code shipped" items are committed to `main`, **NOT yet deployed to mainnet / droplet**. The working tree at commit time also contained unrelated pre-existing work (baseline USD tracking in wallet-service, discord-bot UI tweaks, etc.) — those rode along in the audit commit since they couldn't be cleanly separated without interactive staging.

**Next session — pick up here:**

1. **Bot-only deploy bundle** (reversible — do first)
   - Items live: v2-H-05, v2-H-04, v2-M-09, BUILD-02
   - Command: `./scripts/deploy.sh`
   - Verify: `pm2 logs crank-harvester`, check for `[epoch] Loaded N gauge weight(s)` and `[epoch] reconcile: …` lines during next daily keeper run (14:00 UTC).

2. **Bin-farm program upgrade** (on-chain, ~1 SOL, careful)
   - Items live: v1-M-02 (trader-dest timelock), v2-M-01 (vault_vote owner check)
   - Pre-flight: confirm mainnet `rover.trader_dest != default` (it is)
   - Steps:
     1. `PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor build -p bin_farm`
     2. `anchor deploy --program-name bin_farm --provider.cluster mainnet`
     3. `npm run generate-clients`
     4. Commit regenerated `packages/core-sdk/generated/` + `bot/idl/bin_farm.json`
     5. `./scripts/deploy.sh` (bot picks up new IDL)
   - Verify: try `setTraderDest(X)` from bot → should revert `TraderDestAlreadySet`. Try `/vote` with a non-gauge-voter account in remaining_accounts → should revert `InvalidGaugeAccount`.

3. **After both deploys succeed:** tick all `Deployed: ☐` → `Deployed: ☑` in this file. Commit + push.

---

## Status legend

- **Open** — not started
- **Code shipped** — edits landed in repo, not yet deployed
- **Deployed** — live on mainnet / droplet
- **Blocked** — external dependency (e.g. hardware)

## Deploy checklist templates

- **bin-farm program upgrade:** `anchor build -p bin_farm` → `anchor deploy` (mainnet) → `npm run generate-clients` → commit regenerated `packages/core-sdk/generated/` + `bot/idl/bin_farm.json` → `./scripts/deploy.sh` (bot restart with new IDL).
- **Bot-only change (bot/, packages/):** `./scripts/deploy.sh` → verify `pm2 logs crank-harvester`.
- **Discord-bot-only change:** same deploy.sh (discord-bot runs under same PM2 tree).

---

## Priority order

Blocked items are listed but not scheduled. Everything else is ordered roughly by leverage (blast-radius reduction × inverse effort).

| # | ID | Severity | Component | Effort | Status |
|---|----|----------|-----------|--------|--------|
| 1 | v2-H-05 | High | wallet-service | 30 min | **Code shipped** — needs deploy (bot-only) |
| 2 | v1-M-02 | Med | bin-farm | 1 hr | **Code shipped** — needs program upgrade + client regen + bot deploy |
| 3 | v2-H-04 | High | epoch-computer | 4 hrs | **Code shipped** — needs bot deploy |
| 4 | v2-M-09 | Med | epoch-computer | 1 hr | **Code shipped** — needs bot deploy |
| 5 | v2-M-05 | Med | wallet-service | 1 hr | Open — atomic JSON + schema |
| 6 | v2-M-11 | Med | epoch-computer | 30 min | Open — local IPFS CID check |
| 7 | NEW-01 | Low | bin-farm | 15 min | Open — PDA constraint, bundle into next bin-farm upgrade |
| 8 | NEW-02 | Info | bin-farm | 15 min | Open — mint constraint, bundle into next bin-farm upgrade |
| 9 | v2-M-01 | Med | bin-farm | 30 min | **Code shipped** — bundles with next bin-farm upgrade |
| 10 | v2-M-03 | Med | bin-farm | 15 min | Open — ATA owner constraints |
| 11 | v2-M-02 | Med | bin-farm | 5 min | Open — `data_len()` over SIZE const |
| 12 | v2-M-04 | Med | bin-farm | 4 hrs | Open — implement `close_vault` with `rent_payer` |
| 13 | v2-M-06 | Med | relay-server | 4 hrs | Open — split ops/admin tokens, redact owner |
| 14 | v2-M-07 | Med | discord-bot | 1 hr | Open — `withUserLock` on `/close all` |
| 15 | v2-M-08 | Med | harvest-executor | 2 hrs | Open — circuit-break on CPI failures |
| 16 | v2-M-10 | Med | protocol-lp | 1 hr | Open — randomize threshold/offset; also applies to rover bids |
| 17 | v2-M-12 | Med | bin-farm | 15 min | Open — `GasShortfallEvent` |
| 18 | v1-M-01 | Med | bin-farm | 2 hrs | Open — close per-position Vault ATAs before Vault PDA close |
| 19 | v1-M-04 | Med | gauge-voter | 1 hr | Open — `remove_pool` weight redistribution |
| 20 | v2-L-01..13 | Low | various | 1 day | Open — cleanup pass |
| 21 | NEW-03 | Info | bin-farm | — | Documentation only |
| 22 | v2-I-01..06 | Info | various | — | Monitoring / docstrings |
| — | v1-C-02 / KI-2 | Critical | keypair | — | **Blocked on Ledger hardware** |
| — | v2-C-02 | Critical | bin-farm | — | Dismissed 2026-04-17 (24hr timelock + no-theft) |
| — | v1-M-09 | Med | price-syncer | — | Deferred until swap execution re-enabled |

### Build items (non-audit)

| # | ID | Component | Effort | Status |
|---|----|-----------|--------|--------|
| B1 | BUILD-01 | relay-server / new `/api/pipeline` | 1 hr | Open — observability gap; see Build items section below |
| B2 | BUILD-02 | epoch-computer / gauge-voter integration | 1 hr | **Code shipped** — wires on-chain `PoolGauge.weight_bps` into BANK distribution |

---

## Ship log

### BUILD-02 — gauge-voter → BANK distribution integration
- **Code shipped:** 2026-04-17
- **Problem:** `/vote` wrote `PoolGauge.weight_bps` on-chain but the epoch-computer distributed BANK flat by total fee contribution, ignoring gauge weights entirely. Header comment literally said `BANK holder weighting deferred to v2 (gauge-voter integration)`. Votes had zero effect.
- **Changes:**
  - `bot/epoch-computer.ts` — `computeShares` gained optional `gaugeWeights: Record<string, bigint>` param. When present, each harvest's `fee_taken` is multiplied by `weight_bps / 10000` keyed on `h.lb_pair`. Pools not in the map (or with zero weight) drop their fee contribution to 0. Empty/missing map → flat fallback (preserves pre-integration behavior).
  - New helper `loadGaugeWeights(connection)` — reads `loadGauges()` from curator.json, batch-fetches `PoolGauge` PDAs via `getMultipleAccountsInfo`, deserializes `weight_bps` (u64 LE @ offset 40), honors `enabled` flag at offset 48. Returns `{ lb_pair → weight_bps }`.
  - Wired into both `runEpoch` (SOL tree) and `runBankEpoch` (BANK tree). Gauge weights fetched immediately before `computeShares` each run — always fresh.
  - Updated file-header comment + BANK-section comment to reflect that integration is live, not deferred.
- **Tests:** 55/55 pass. 6 new tests cover: basic weighted scaling, zero-weight exclusion, ungauged-pool exclusion, multi-user proportional split, all-zero-weights → empty shares, empty-map flat fallback.
- **Deploy:** bot-only. `./scripts/deploy.sh`.
- **Verification (post-deploy):**
  1. `pm2 logs crank-harvester` during next keeper daily sequence, look for `[epoch] Loaded N gauge weight(s)` and `[bank-epoch] Loaded N gauge weight(s)`.
  2. If any wallet previously held active vote weight on pools with live harvest activity, their next BANK share should differ from a pure-flat split. Spot-check `epoch-N-bank.json` leaves vs. raw `harvests[].fee_taken` sum per user.
  3. If all gauges are at 0 bps (nobody has voted), bank-epoch will produce empty shares and skip — same defensive behavior as "no fees generated."
- **Known behavioral shift:** users trading on ungauged pools no longer get BANK. Was already expected behavior per the deferred-integration comment, but worth calling out in any user-facing release note.
- **Deployed:** ☐



Per-fix status of code + deploy. Updated as we go.

### v2-H-05 — `registerUser` duplicate owner check
- **Code shipped:** 2026-04-17
  - `packages/core-sdk/wallet-service.ts` — added `WalletAlreadyClaimedError`, guard in `registerUser`.
  - `packages/discord-bot/src/commands/start.ts` — catches error, surfaces clean message.
- **Tests:** 43/43 pass.
- **Deploy step:** `./scripts/deploy.sh` (bot-only change, no on-chain).
- **Verification:** tail `pm2 logs crank-harvester`, no startup errors. Optional sanity: temp-edit `crankbot.json` to add a duplicate owner entry, run `/start` from a second Discord account, confirm graceful error.
- **Deployed:** ☐

### v2-H-04 — cumulative-claim reconciliation
- **Code shipped:** 2026-04-17
  - `bot/epoch-computer.ts` — new `reconcileEntitlementsAgainstOnChain(conn, dist, distProgId, entitlements, tree)` helper. Batches `getMultipleAccountsInfo` (100/chunk) for every wallet's `claim_status` PDA. For each, reads `cumulative_claimed` (u64 LE at offset 8). If local `updatedEntitlements[wallet] < onChain`, bumps local to match. Logs warn + fires `alertEntitlementDrift` on ops channel with sample bumps. Logs info + skips alert when no drift.
  - SOL tree path: reconciles immediately after computing `updatedEntitlements` and before tree build. Reconciled map flows into leaves + `progress.updatedEntitlements` (so resume uses reconciled values) + `state.cumulativeEntitlements` on final persist.
  - BANK tree path: same reconcile wedge before tree build; reconciled map flows into leaves + final `state.cumulativeEntitlements`.
  - `bot/alerter.ts` — added `alertEntitlementDrift(tree, bumpCount, sample)` routing to ops channel with key `entitlement_drift_<tree>`.
- **Tests:** 49/49 pass. Added 6 reconciler tests in `bot/epoch-computer.test.ts`: no-drift, drift bump, null claim_status (treated as 0), empty entitlements (short-circuits RPC), >100 wallets across 2 batches, truncated data skipped. Exported `reconcileEntitlementsAgainstOnChain` for test access.
- **Deploy steps:** `./scripts/deploy.sh` (bot-only change).
- **Verification (post-deploy):**
  1. Tail `pm2 logs crank-harvester` during the next keeper daily sequence (14:00 UTC).
  2. Look for `[epoch] reconcile: N wallet(s) checked, no drift` (healthy case) OR `[epoch] RECONCILE: N wallet(s) had local < on-chain claimed — bumped …` (drift detected).
  3. Repeat for `[bank-epoch]` lines.
  4. If drift alert fires, check ops Discord channel for `entitlement_drift_sol` or `entitlement_drift_bank` alert and investigate via runbook.
- **Canary plan:** first epoch after deploy will run the reconciliation across the full user base. Since current on-chain state is clean (no observed drift to date), expect "no drift" on first run. The guard is now in place for any future DB restore event.
- **Residual:** still worth pairing with v2-M-09 (atomic JSON writes for `saveProgress` / `saveEpochState`) to reduce the probability of needing the reconciler to kick in.
- **Deployed:** ☐

### v2-M-01 — `vault_vote` pre-CPI owner check (bin-farm side)
- **Code shipped:** 2026-04-17
  - `programs/bin-farm/src/lib.rs` — before forwarding `remaining_accounts` to gauge-voter CPI in `vault_vote`, loop each account and `require!(acc.owner == &GAUGE_VOTER_PROGRAM_ID, CoreError::InvalidGaugeAccount)`. Added the error variant.
- **Tests:** cargo check clean. No new unit test (10-line require guard, behavior covered by paired gauge-voter M-03 tests).
- **Deploy:** bundles with next bin-farm program upgrade (alongside v1-M-02 trader-dest timelock).
- **Pairs with:** already-shipped v1-M-03 on gauge-voter. Two independent checks across the CPI boundary.
- **Deployed:** ☐

### v2-M-09 — atomic JSON writes for checkpoints
- **Code shipped:** 2026-04-17
  - `bot/epoch-computer.ts` — new `atomicWriteJson(filePath, obj)` helper: writes to `${path}.tmp` then `fs.renameSync(tmp, path)`. POSIX `rename` is atomic on same filesystem, so crash mid-write leaves old file intact rather than a half-written JSON that fails to parse on restart.
  - Applied to all 5 checkpoint writes: `saveEpochState` (SOL), `saveProgress`, SOL tree file (`epoch-N.json`), `saveBankEpochState` (BANK), BANK tree file (`epoch-N-bank.json`).
  - Intentionally NOT adding silent fallback to `loadEpochState` / `loadBankEpochState` on parse failure — corrupt state should crash loud so operator restores from backup, not silently zero-reset cumulative entitlements.
- **Tests:** 49/49 pass. No new tests (file-write code is trivial; behavior verified by rename being atomic at OS level).
- **Deploy steps:** `./scripts/deploy.sh` (bot-only change).
- **Verification (post-deploy):**
  1. Normal operation: tail `pm2 logs crank-harvester` during daily keeper sequence, confirm no errors writing epoch-state / epoch-progress / tree files.
  2. Look in `data/epoch/` — should see no lingering `.tmp` files after a successful epoch. A lingering `.tmp` indicates either an in-flight write or a crash between tmp-write and rename.
  3. Optional soak test on a dev droplet: `kill -9` the bot during `saveProgress`, then restart — `epoch-progress.json` should still parse cleanly (the old version is preserved).
- **Pairs with v2-H-04:** reconciler protects against actual cumulative-count drift; atomic writes reduce how often drift can be introduced in the first place.
- **Deployed:** ☐

### v1-M-02 — `set_trader_dest` timelock
- **Code shipped:** 2026-04-17
  - `programs/bin-farm/src/lib.rs` — legacy `pending_revenue_dest` / `revenue_dest_change_at` fields renamed to `pending_trader_dest` / `trader_dest_change_at` (byte layout preserved). Deleted `propose/apply/cancel_revenue_dest`. Added `propose/apply/cancel_pending_trader_dest` with 24h timelock. `set_trader_dest` now one-shot (only callable while unset). `TraderDestAlreadySet` error added. `ApplyRevenueDest` → `ApplyTraderDest` context rename.
- **Tests:** `cargo check` clean. 43/43 TS pass.
- **Deploy steps:**
  1. `PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor build -p bin_farm`
  2. `anchor deploy --program-name bin_farm --provider.cluster mainnet`
  3. `npm run generate-clients` (regenerate Codama + IDL)
  4. Commit `packages/core-sdk/generated/` + `bot/idl/bin_farm.json`
  5. `./scripts/deploy.sh` (bot restart with new IDL)
- **Pre-deploy check:** confirm `rover.trader_dest != Pubkey::default()` on mainnet (it is — set at Capture-the-Bag amendment). After upgrade, `set_trader_dest` will revert; changes flow via `propose_trader_dest` → 24h → `apply_trader_dest`.
- **Layout safety:** field renames only; existing mainnet `RoverAuthority` has `pending_revenue_dest`/`revenue_dest_change_at` bytes already zero (never proposed), so the rename is non-migratory.
- **Verification:** after upgrade, try `setTraderDest(X)` from bot → should revert `TraderDestAlreadySet`. Try `proposeTraderDest(Y)` → succeeds, sets change_at. Try `applyTraderDest` immediately → reverts `FeeTimelockNotExpired`.
- **Deployed:** ☐

---

## High-priority detail

### 1. v2-H-05 — `registerUser` duplicate owner check (30 min)
`packages/core-sdk/wallet-service.ts:118` — before writing `ownerIndex[ownerStr]`, reject if already set to a different `userId`. Companion fix to the dismissed v2-C-01 squatting class. Also covers v2-L-09.

### 2. v1-M-02 — `set_trader_dest` timelock (1 hr)
`programs/bin-farm/src/lib.rs:1393` — add 24h propose/apply to match `set_revenue_dest`. Without it, `set_trader_dest` is the fastest post-compromise drain vector (40% of sweep → attacker-chosen address, instant).

### 3. v2-H-04 — Cumulative-claim reconciliation before publish (4 hrs)
`bot/epoch-computer.ts` + `programs/merkle-distributor/src/lib.rs` — before each new tree, fetch `claim_status.cumulative_claimed` for every leaf; raise leaf's `cumulative_amount` to `max(computed, on_chain_claimed)` OR abort. Prevents DB-rollback → permanent partial claim lockout. Pairs with v2-M-09 (atomic writes).

### 4. v2-M-09 — Atomic JSON writes (1 hr)
`bot/epoch-computer.ts:142,178` (+ `353`, `667`, `745`) — switch to `writeFileSync('.tmp') + renameSync` pattern from `tools/protocol-lp/state.ts:45–57`.

### 5. v2-M-05 — Wallet DB atomic + schema (1 hr)
`packages/core-sdk/wallet-service.ts:70–81, 93–97, 127, 143` — tmp+rename, Zod schema on load, quarantine records where PDA mismatch.

### 6. v2-M-11 — Local IPFS CID verification (30 min)
`bot/epoch-computer.ts:355–379` — compute CID locally via `ipfs-only-hash`, assert match against Pinata response before publishing on-chain.

---

## Bundling recommendations

- **Next bin-farm upgrade** should include: v1-M-02, v2-M-01, v2-M-02, v2-M-03, v2-M-12, v1-M-01, NEW-01, NEW-02. All are small, additive, and share deploy cost.
- **Next gauge-voter upgrade** should include: v1-M-04.
- **Wallet-service pass** (one PR): v2-H-05, v2-M-05, v2-L-11 `/start` compensation.
- **Epoch-computer pass** (one PR): v2-H-04, v2-M-09, v2-M-11, v2-L-07 (per-epoch keccak self-test).
- **Relay-server pass** (one PR): v2-M-06, v2-I-03.

---

## Build items (non-audit)

Things we want that aren't security findings — build to improve observability / ops.

### BUILD-01 — `/api/pipeline` single-read state endpoint

**Why:** `/api/fees` today shows rover_authority + bridge_vault + SOL-distributor only. It's missing the exact things you need to answer "what's the pipeline doing right now":

- `burn_sol_vault` balance (the staging SOL before buy-bids) — **biggest gap**
- Progress toward `ROVER_BID_MIN_LAMPORTS` (2 SOL) deploy threshold
- Rover CRANK ATA balance (direct-burn queue)
- Curve state (`burn_ratio_ppb`, `protocol_skim_ppb`, `burn_enabled`, current vs initial CRANK supply, CRANK-remaining-until-curve-rotates)
- Bank-distributor state (BANK side of pipeline, not just SOL)
- Lifetime counters: CRANK burned, BANK minted
- Bin ranges per active rover position (not just aggregate TVL)

**Endpoint shape (JSON):**

```jsonc
{
  "stages": {
    "roverAuthority":   { "address": "...", "sol": 0, "wsol": 0, "crank": 0 },
    "burnSolVault":     { "address": "...", "sol": 0, "sweepable": 0,
                          "deployThreshold": 2000000000,
                          "progressPct": 0.0,
                          "gapLamports": 2000000000 },
    "bridgeVault":      { "address": "...", "sol": 0 },
    "solDistributor":   { "vaultAta": "...", "wsol": 0,
                          "currentEpoch": "0", "totalFunded": "0", "totalClaimed": "0", "paused": false },
    "bankDistributor":  { "vaultAta": "...", "bank": 0,
                          "currentEpoch": "0", "totalFunded": "0", "totalClaimed": "0", "paused": false }
  },
  "curve": {
    "burnEnabled": true,
    "initialCrankSupply": "1935388154207285",
    "currentCrankSupply": "1935386248149453",
    "burnRatioPpb": 1000000000,
    "protocolSkimPpb": 0,
    "traderFractionPpb": 0,
    "breakpointCrankRemaining": "483847095052", // CRANK yet to burn before curve rotates
    "pctOfInitialRemaining": 99.9999
  },
  "totals": {
    "crankBurnedLifetime": "1906057832",    // from bank-mint Config.total_burned
    "bankMintedLifetime":  "64402100000000" // from BANK mint.supply
  },
  "rovers": [
    {
      "pool": "<lb_pair>",
      "tokenXSymbol": "CRANK",
      "tokenYSymbol": "SOL",
      "tvl": 0,
      "status": "active",
      "positions": [
        { "nft": "<mint>", "binFarmPosition": "<pda>", "minBin": 0, "maxBin": 0, "activeBin": 0 }
      ]
    }
  ],
  "timestamp": 0
}
```

**Implementation plan:**

1. **New file `bot/pipeline-state.ts`** — exports `getPipelineState(ctx): Promise<PipelineState>`. Single `getMultipleAccounts` batch of:
   - `rover_authority` PDA (`[b"rover_authority"]` on bin-farm)
   - `burn_sol_vault` PDA (`[b"burn_sol_vault"]` on bin-farm)
   - `bridge_vault` PDA (`[b"bridge_vault"]` on epoch-vault)
   - `rover` WSOL ATA + CRANK ATA (derive via `getAssociatedTokenAddressSync`, CRANK is SPL not Token-2022 per rover path)
   - SOL distributor PDA (`[b"distributor"]` on merkle-distributor) + its WSOL ATA
   - BANK distributor PDA (`[b"distributor"]` on bank-distributor) + its BANK ATA
   - CRANK mint (`Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump`) — for current supply
   - `bank-mint.Config` PDA (`[b"bank_config"]`) — for `total_burned`
   - `bin-farm.Config` PDA (`[b"config"]`) — if needed for any cross-checks
2. **Curve mirror call:** import `computeCurve` from `packages/core-sdk/burn-curve.ts` (TS mirror of on-chain `compute_curve`) — feed it `currentCrankSupply` + `initialCrankSupply` + `burnEnabled` (latter two come from deserializing rover_authority).
3. **Threshold progress:** pull `ROVER_BID_MIN_LAMPORTS` + `ROVER_BID_RESERVE_LAMPORTS` from `packages/core-sdk/constants.ts`. `sweepable = burnSolVault.lamports - ROVER_BID_RESERVE_LAMPORTS`. `progressPct = sweepable / ROVER_BID_MIN_LAMPORTS * 100`. `gapLamports = max(0, ROVER_BID_MIN_LAMPORTS - sweepable)`.
4. **Rover positions enrichment:** reuse `this.roverTvl` (already populated by keeper PnL flow in `anchor-harvest-bot.ts:535`). Extend `RoverTvlEntry` to include `positions: [{ nft, binFarmPosition, minBin, maxBin, activeBin }]`. Fetching bin range requires reading each bin-farm `Position` PDA — batch with `getMultipleAccounts`.
5. **Wire into relay-server:**
   - Add `handlePipeline(res)` after `handleFees` in `bot/relay-server.ts`.
   - Add route `/api/pipeline` in the switch at `:568`.
   - Accept an optional `pipelineProvider: () => Promise<PipelineState>` constructor param (same pattern as `feeProvider`).
6. **Wire into anchor-harvest-bot.ts:**
   - Add `async getPipelineState()` method (delegates to `bot/pipeline-state.ts`).
   - Pass `() => this.getPipelineState()` in the `RelayServer` ctor call next to `() => this.getFeePipelineState()`.
7. **Type:** export `PipelineState` interface from `bot/relay-server.ts` (keeps symmetry with `FeePipelineState`).
8. **Deprecate** `/api/fees` or leave both — `/api/pipeline` is the superset. Recommend: leave `/api/fees` as-is for back-compat, mark superseded in comment.

**Files touched:**
- `bot/pipeline-state.ts` (new, ~150 lines)
- `bot/relay-server.ts` (+type export, +route, +handler, ~30 lines)
- `bot/anchor-harvest-bot.ts` (+method, +wire-up, ~10 lines)
- `packages/core-sdk/burn-curve.ts` (verify it exports the TS mirror — already does)

**Tests:**
- Add `bot/pipeline-state.test.ts` — mock RPC responses, verify curve math + threshold math.

**Deploy:**
- Bot-only change. `./scripts/deploy.sh`.
- Verification: `curl -H "Authorization: Bearer $RELAY_AUTH_TOKEN" https://bot.crank.money/api/pipeline | jq .` — confirm all stages populated, `curve.burnRatioPpb` = 1e9 (magnesium), `burnSolVault.sweepable` matches manual query.

**Effort:** ~1 hour of focused work, a bit more with tests.

**Status:** Open.

---

## Closed items (for reference)

Shipped 2026-04-15 → 2026-04-17: v2-H-01, v2-H-02, v2-H-03, v2-H-06, v2-H-07, v2-H-09, v1-M-03, v1-L-03, v1-L-04.
Mitigated by 2026-04-13 non-custodial rewrite: v2-H-08.
Dismissed 2026-04-17: v2-C-01, v2-C-02.

Full dispositions in `audit-v2.md`.
