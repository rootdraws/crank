# crank.money — TODO

> GTM strategy lives in `gtm.md` — this file is what to build, that file is who to talk to.

---

## GTM BLOCKERS — Priority Order

### 1. $BANK Token Metadata (BLOCKS ALL OUTREACH)
$BANK has zero metadata. Looks like a scam token in Phantom. Fix before any outreach.

- [ ] Create $BANK logo image
- [ ] Host $BANK off-chain metadata JSON + image (Arweave or GitHub)
- [ ] Register Metaplex token metadata on $BANK mint (`BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA`)
- [ ] Verify renders correctly in Phantom / Solflare / Jupiter

### 2. Analytics — `/stats` + `#crank-stats`
When pitching — point at real numbers.

- [ ] Add `/stats` slash command — user count, volume, harvests, fees, uptime
- [ ] Add daily cron that posts formatted stats to `#crank-stats` Discord channel
- [ ] Track volume: log USD value of every `/buy` and `/close`
- [ ] Track daily active users

### 3. GSD Community Launch (First GTM Target)
- [ ] Build gsd.crank.money landing page
- [ ] Test mobile frontend
- [ ] Record video demo
- [ ] Share in GSD X community + Telegram

---

## HIGH PRIORITY

### Audit-v2 Follow-ups (post 2026-04-13 amendment)
Several HIGH findings from `audit-v2.md` remain open after the Capture the Bag amendment. Non-custodial distribution mitigated v2-H-08 but the rest still apply. See audit-v2.md addendum for per-finding status.

**v2-C-01** (critical): `/start` accepts any wallet address with no ownership proof.
- [ ] Require signed nonce — user signs `"crank.money:start:<userId>:<nonce>"` with wallet
- [ ] Verify via `nacl.sign.detached.verify` before calling `createVault`
- [ ] Short-term mitigation: dedupe-owner check in `registerUser` (also closes v2-H-05)

**v2-H-01**: `update_gas_lamports` is unbounded and has no timelock.
- [ ] Cap: `require!(gas_lamports <= 10_000_000)` (0.01 SOL)
- [ ] Per-op cap in `deduct_gas` itself: `MAX_PER_OP_GAS` const
- [ ] 24hr timelock (propose/apply) matching `set_revenue_dest`

**v2-H-02**: `wrap_sol_in_vault` destination WSOL ATA not constrained.
- [ ] Add `constraint = vault_wsol_ata.owner == user_vault.key() && mint == NATIVE_MINT`

**v2-H-03**: Permissionless `harvest_bins` fires `deduct_gas` on zero-yield calls.
- [ ] Gate `deduct_gas` on `amount_out > 0`, or skip when `keeper_tip_bps` path triggers

**v2-H-05**: `wallet-service.registerUser` allows multiple Discord IDs to bind the same owner wallet.
- [ ] Add `ownerIndex` reverse lookup, reject if already bound

**v2-H-06**: Relay Bearer auth fails open if `RELAY_AUTH_TOKEN` unset + non-constant-time compare.
- [ ] Require env var set at startup (fail-closed)
- [ ] Use `crypto.timingSafeEqual` for token comparison

**v2-H-07**: `/ws` WebSocket has zero auth.
- [ ] Require Bearer token on upgrade request

**v2-H-09**: `apply-emergency-close.ts` reads non-existent `data.owner` field.
- [ ] Fix to `data.userVault` + refresh accounts context

**v2-C-02**: `propose_emergency_close` can target any user position (still open).
- [ ] Restrict to positions on pools flagged `is_deprecated` OR require user co-sign

### On-Chain Program Upgrades (v1 carryover)
**gauge-voter** (audit v1 M-03):
- [ ] Build: `anchor build -p gauge_voter`
- [ ] Upgrade: `anchor upgrade --program-id DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA --provider.cluster mainnet target/deploy/gauge_voter.so`
- Change: owner check on `remaining_accounts` in `vote()`

**merkle-distributor** (audit v1 L-04):
- [ ] Verify L-04 (`update_mint` drain check) is in the 2026-04-13 non-custodial deploy. If not, include in next build.

**bin-farm** (audit v1 L-03 — remaining):
- [ ] Add `total_positions` decrement on all 3 close paths
- [ ] Build + deploy

### Keypair Separation (Audit C-02)
Single keypair controls all 6 program upgrade authorities + `Config.bot`. Non-custodial distribution pipeline eliminates reward-token custody, but upgrade authority and skim destination are still single-key. Server compromise = protocol loss.

- [ ] Generate a new minimal bot-signer keypair (tx signing only, no upgrade authority)
- [ ] Call `update_bot(NEW_BOT_PUBKEY)` on bin-farm
- [ ] Transfer all 6 program upgrade authorities to cold wallet (Ledger)
- [ ] Deploy new bot keypair to droplet
- [ ] Old keypair becomes cold admin only

### Harvest & Position Improvements
- [ ] Harvest minimum — skip harvest tx if pending fees are below threshold (avoid burning gas on dust)
- [ ] `close_vault` instruction in bin-farm — reclaim rent from vault accounts when fully closed
- [ ] Minimum vault SOL balance check before harvesting — DM notification if user is dry

### ~~Price Sync Bot (Arb)~~ — REMOVED
Jupiter routes buys through DLMM organically. Pools track within ~2 bins. Syncer was comparing DLMM price against itself (Jupiter routed the probe through DLMM). Removed 2026-04-12.

---

## MEDIUM PRIORITY

### Web Rebrand
- [ ] Rebrand site as "community-first market making tool"

### Activate @libraryofCrank + CRM
- [ ] Outreach targets, responses, opportunities tracking
- [ ] Path to 100 communities
- [ ] `Publisher` abstraction (Discord webhook + X) — deferred until `/crank-crm` actually exists; no point abstracting vaporware

### Community Gating Follow-Ups
- [ ] Flip `CRANK_ROLE_PRUNE_DRY_RUN=false` once candidate list is trustworthy (currently 0 candidates)
- [ ] Auto-grant crank role on first `/buy` or `/sell` (replace manual role-granting)
- [ ] `/leaderboard` — add filter by pool/token and per-user rank stripe at bottom

### Dexter / x402 Integration
- [ ] Evaluate Dexter SDK
- [ ] Build demo
- [ ] Share with BranchM

### Community Doc Pages
- [ ] Design doc page template
- [ ] Deploy per-community subdomains

### ~~Arbitrage Health Evaluation~~ — N/A
Jupiter routes through DLMM. Organic arb handles sync.

---

## LOW PRIORITY

### Ops Hardening
- [ ] Service user (audit H-08) — bot still runs as root, not `crankbot` user
- [ ] Register external uptime monitor (UptimeRobot) hitting `/api/health`
- [ ] Document recovery runbook
- [ ] Verify encrypted backup upload (wallet DB now exists)
- [ ] Test backup restore
- [ ] Update any external dashboards/scripts that hit the relay (now requires Bearer token)

### Dynamic Supply Refresh
- [ ] Add `refreshTokenSupplies()` — reads CRANK mint supply via RPC
- [ ] Call on bot startup + periodic timer

### Bot Code Dedup
- [x] `fixBitmapWritable()` shared helper in `bot/meteora-accounts.ts` — all Meteora CPI callsites use it
- [ ] Remove inline `withRetry` copies
- [ ] Extract `buildPriorityFeeIxs` to shared module

### Telegram Adapter
Core-SDK is platform-agnostic. ~300-400 lines. After Discord is proven.

### LP Bot Skill / API Layer
Offer crank.money's harvester as a skill/API for other LP bots.

### Bittensor Subnet (Seby)
Continue conversation. Ship analytics first.

---

## DONE (2026-04-13 Session — Capture the Bag Amendment + Non-Custodial Distribution)

- [x] **Curve-driven `sweep_rover`** — replaced 40/40/20 hardcoded split with supply-responsive curve. Reads `crank_mint.supply` + `RoverAuthority.initial_crank_supply` + `burn_enabled`. `burn_ratio = min(1.0, (supply/initial)/0.75)`, `protocol_skim = 0.20×(1−burn_ratio)`. Three destinations: `burn_sol_vault` / `bridge_vault` / `Config.bot`.
- [x] **Fee bump 30 → 50 bps** via new direct `set_fee_bps(u16)` admin setter. Old `propose_fee`/`apply_fee`/`cancel_pending_fee` timelock instructions deleted.
- [x] **New bin-farm instructions:** `initialize_burn_curve` (one-shot snapshot + creates `burn_sol_vault` PDA), `set_burn_enabled` (kill switch), `wrap_burn_sol` (move SOL from burn_sol_vault → rover WSOL ATA), `open_rover_bid_position` (buy-side BidAsk on CRANK/SOL), `rover_burn_and_mint` (CPI bank-mint + forward BANK to distributor vault).
- [x] **`RoverAuthority` struct extended in-place** — added `initial_crank_supply: u64` + `burn_enabled: bool` carved from `_reserved: [u8; 32]`. No realloc needed.
- [x] **`BurnSolVault` account type + PDA** — `[b"burn_sol_vault"]`, bin-farm-owned, holds staged SOL between sweep and bid placement.
- [x] **`bank-distributor` program deployed** at `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M` — byte-identical to merkle-distributor with different `declare_id!`. Parallel BANK distribution to the SOL distributor.
- [x] **Non-custodial `new_epoch` rewrite (both distributors)** — removed `funder_ata`, `mint`, `token_program`, `epoch_amount` param. Computes `epoch_amount = vault.amount + total_claimed − total_funded` on-chain. Authority signs intent only; no transfer. Reward tokens never touch operator keypair.
- [x] **SOL pipeline non-custodial** — `drain_vault(destination = distributor WSOL vault)` + SPL `sync_native` in place. Bot WSOL ATA no longer created or closed.
- [x] **BANK pipeline non-custodial** — `rover_burn_and_mint` forwards BANK directly to bank-distributor vault ATA. No bot BANK ATA intermediary.
- [x] **Keeper 6-step → 8-step sequence** — added `crankOpenRoverBids` (wrap_burn_sol + open_rover_bid_position) and `crankRoverBurnAndMint` between sweep and epoch distribution. `crankEpochDistribution` now runs both SOL + BANK trees. `crankOpenFeeRovers` skips CRANK mint (handled by rover_burn_and_mint).
- [x] **`runBankEpoch` in epoch-computer.ts** — mirrors runEpoch shape for BANK. Separate state file `epoch-state-bank.json`. Same `computeShares` weighting as SOL tree.
- [x] **`compute_curve` ppb helper** in bin-farm + TS mirror in `packages/core-sdk/burn-curve.ts`. 16 new vitest cases (reference values, invariants, kill switch, edge cases) — all passing.
- [x] **`/burn status` Discord subcommand** — `/burn` (no args) or `/burn status` renders live curve state: CRANK supply, initial supply, burn_ratio, protocol_skim, trader_sol_frac, kill switch.
- [x] **`scripts/init-burn-curve.ts`** — one-shot bootstrap (`--execute`). Calls initialize_burn_curve, set_fee_bps(50), bank-distributor init + vault ATA, creates rover + bot BANK ATAs.
- [x] **Mainnet activation** — all of the above shipped and verified. Curve live with `initial_crank_supply = 1,935,388,154,207,285`, `burn_enabled = true`. First BANK epoch fired (64.4M BANK distributed to lone trader, auto-claimed).
- [x] **UX polish:** `/start` auto-creates vault CRANK ATA (Token-2022) so new users can deposit CRANK immediately without hitting the "Enable $TOKEN" button. Minimum SOL copy in `/start` + `/deposit` lowered 0.25 → 0.05 SOL (on-chain floor unchanged at 0.01 SOL).

## DONE (2026-04-13 Session — Community Gating)

- [x] **@handle attribution in feed** — every `harvested`/`closed` feed line prepends `<@user_id>`. `allowedMentions.parse: []` renders clickable handle without pinging (owner already DMs). `notifier.ts` + `formatter.ts` + `commands/close.ts`.
- [x] **`/leaderboard [days]`** — top 10 by harvest volume in a rolling window (default 7d). New `walletService.getLeaderboard(sinceMs)` aggregates harvests + open positions by vault PDA, reverse-maps to user IDs via `vaultIndex`. Slash command registered.
- [x] **Daily crank-role pruner** — keeper step 6. Strips `DISCORD_CRANK_ROLE_ID` from registered users inactive for `CRANK_ROLE_PRUNE_WINDOW_DAYS` (default 7d). Grace period: users registered within the window are treated as active. Dry-run flag `CRANK_ROLE_PRUNE_DRY_RUN=true` logs candidates without removing. `GuildMembers` intent gated behind `DISCORD_ENABLE_MEMBER_INTENT=true` — without the portal toggle, bot refuses login.
- [x] **`#cash-out` channel allowlist** — in `DISCORD_CASHOUT_CHANNEL_ID`, only `/close /withdraw /positions /balance /help` dispatch; everything else gets an ephemeral "cash-out only" reply.
- [x] **Deployed to mainnet droplet** — env vars set, slash commands re-registered (13 total, global propagation ≤1hr), dry-run first keeper tick: 17 role members, 0 prune candidates. Pruner verified working before being flipped live.

## DONE (2026-04-12 Session)

- [x] **gRPC sub-second harvest detection confirmed** — measured ~180ms from activeId change to harvest execution via `[geyser] activeId changed` log. Safety poll now redundant (5s interval, was 30s).
- [x] **gRPC migrated to `helius-laserstream` SDK** — old `@triton-one/yellowstone-grpc` was silently not delivering data (subscription format mismatch). New SDK has built-in reconnect + 24h replay.
- [x] **`close_rover_position` instruction added to bin-farm** — rovers couldn't be closed via `close_position` (expects UserVault, rover has RoverAuthority). New instruction deployed to mainnet.
- [x] **Dust rover closed** — 264 CRANK across 70 bins ($0.003) manually closed via new instruction. CRANK returned to rover_authority.
- [x] **Fee rover opening fixed** — $10/bin minimum (was $0.50). No more dust spread across 70 bins. Min 1 bin (was 5).
- [x] **Fee rover pricing uses PumpSwap reserves** — reads on-chain AMM reserves directly. No DexScreener dependency. `pumpswapPool` field in curator.json.
- [x] **Rover exhaustion check improved** — closes positions with <5% of initial amount remaining.
- [x] **Price syncer removed** — Jupiter routes through DLMM organically. Syncer was comparing pool against itself. All syncer code, alerts, and relay endpoint removed.
- [x] **Positions API returns amounts** — `initialAmount` and `harvestedAmount` in `/api/positions`.
- [x] **Single-bin positions tracked** — `MIN_POSITION_BINS` default changed from 2 to 1.
- [x] **Buy/sell boundary nudge** — bin range landing on activeId nudges 1 bin instead of rejecting.

## DONE (2026-04-11 Session)

- [x] **open_position_v2 fixed** — `user_vault` missing `#[account(mut)]` in OpenPositionV2 + ClaimFees. Deployed to mainnet.
- [x] **Bitmap extension writable fix** — all 10 Meteora CPI callsites (bot, discord, scripts) now use `fixBitmapWritable()`. No more "writable privilege escalated".
- [x] **WSOL unwrap-on-failure** — if open_position_v2 fails after wrapping, WSOL is unwrapped back to SOL.
- [x] **Amount parser** — `1m CRANK` now parses as 1,000,000. Supports k/m/b suffixes.
- [x] **Opt-in token enablement** — "Enable $TOKEN?" button prompt on first trade. Bot creates ATA on click. No upfront ATA cost.
- [x] **Close UX** — `/close 1` instead of PDA fragments. Mcap display. Correct token symbols. Clean amount formatting.
- [x] **Close shows actual amount returned** — reads `postTokenBalances` from confirmed tx.
- [x] **Enable token shows deposit address** — tells user where to send tokens after enabling.
- [x] **Vault minimum lowered** — 0.25 SOL → 0.01 SOL.
- [x] **`/deposit` killed** — redundant with `/balance`. Redirects to `/balance`.
- [x] **Harvest executor fixed** — `data.owner` → `data.userVault` (PDA vault field rename), added missing `owner` account to harvestBins.
- [x] **Safety poll reads fresh activeId** — reads on-chain bytes directly instead of stale DLMM SDK cache (was up to 10min stale).
- [x] **Amount parser accepts `.5`** — regex required leading digit, now accepts `\d*\.?\d+`.
- [x] **gRPC datasize filter removed** — was silently breaking Yellowstone v5 subscription (type mismatch). Subscription works without it.
- [x] **Price syncer confirmed correct** — 6.83% divergence was real (DLMM lagging PumpSwap, no arb bots). Math verified end-to-end.
