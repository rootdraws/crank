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

### On-Chain Program Upgrades (2 Remaining Audit Fixes)
**bin-farm deployed 2026-04-11** — `user_vault` mut fix on OpenPositionV2 + ClaimFees. IDL + Codama regenerated. Deploy sig: `44uPp47eWPc3BeKwGdUV9kSB2iYsCdaePuqg8DxUqe4HVwtr7ZNCeLy6cKJCBwh1tgyEqmHED2wMBM8r4xHrLgKp`. Audit L-03 (`total_positions` decrement) still needs a separate deploy.

**gauge-voter** (audit M-03):
- [ ] Build: `anchor build -p gauge_voter`
- [ ] Upgrade: `anchor upgrade --program-id DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA --provider.cluster mainnet target/deploy/gauge_voter.so`
- Change: owner check on `remaining_accounts` in `vote()`

**merkle-distributor** (audit L-04):
- [ ] Build: `anchor build -p merkle_distributor`
- [ ] Upgrade: `anchor upgrade --program-id DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV --provider.cluster mainnet target/deploy/merkle_distributor.so`
- Change: `update_mint` now requires `old_vault` account with `amount == 0`

**bin-farm** (audit L-03 — remaining):
- [ ] Add `total_positions` decrement on all 3 close paths
- [ ] Build + deploy

### Keypair Separation (Audit C-02)
Single keypair controls everything. Server compromise = total loss.

- [ ] Generate a new minimal bot-signer keypair
- [ ] Call `update_bot(NEW_BOT_PUBKEY)` on bin-farm
- [ ] Transfer program admin authority to cold wallet (Ledger)
- [ ] Deploy new bot keypair to droplet
- [ ] Old keypair becomes cold admin only

### Harvest & Position Improvements
- [ ] Harvest minimum — skip harvest tx if pending fees are below threshold (avoid burning gas on dust)
- [ ] `close_vault` instruction in bin-farm — reclaim rent from vault accounts when fully closed
- [ ] Minimum vault SOL balance check before harvesting — DM notification if user is dry

### Price Sync Bot (Arb)
Detection deployed. Swap execution needs direct Meteora DLMM instructions.

- [ ] Replace Jupiter swap with direct Meteora DLMM `swap` instruction
- [ ] Build swap instruction targeting specific LbPair address
- [ ] Handle bin array account resolution for the swap range
- [ ] Profitability check
- [ ] Test with small amounts on mainnet
- [ ] Enable live swaps (`SYNC_ENABLED=true`)

---

## MEDIUM PRIORITY

### Web Rebrand
- [ ] Rebrand site as "community-first market making tool"

### Activate @libraryofCrank + CRM
- [ ] Outreach targets, responses, opportunities tracking
- [ ] Path to 100 communities

### Dexter / x402 Integration
- [ ] Evaluate Dexter SDK
- [ ] Build demo
- [ ] Share with BranchM

### Community Doc Pages
- [ ] Design doc page template
- [ ] Deploy per-community subdomains

### Arbitrage Health Evaluation
- [ ] Who is arbing each pool? How many bots? How fast?
- [ ] Is the sync bot needed per pool, or do arb bots handle it?

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
