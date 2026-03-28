# crank.money — TODO

> Living task list. Updated as work progresses.
> Last reviewed: 2026-03-28

---

## 🟣 NEXT SESSION — Immediate Focus

The repo is clean. The Discord bot draft code is migrated into `packages/`.
The harvester bot is production-ready. Next step: get the Discord bot running.

**Suggested order:**

1. **Clean core-sdk** (~30 min) — Remove monke_bananas from constants.ts and pda.ts.
   Add bank-mint, gauge-voter, merkle-distributor program IDs and PDAs. This unblocks
   everything else since all commands import from core-sdk.

2. **Populate curator.json** (~15 min) — Replace REPLACE_WITH_REAL_ADDRESS with actual
   Meteora LbPair addresses for CRANK/SOL and SOL/USDC pools. These are on-chain and
   live. Without real addresses, /buy and /sell can't route.

3. **Wire /burn and /claim** (~1 hr) — /burn calls bank-mint `burn_and_mint`. /claim
   calls merkle-distributor `claim`. Both are stubbed in the command handlers. The
   on-chain programs are deployed — just need the instruction builders wired. Read
   `packages/docs/migration.md` for the planned approach.

4. **Add mcap mode to parse-range.ts** (~30 min) — The parser handles price mode
   ("SOL 84 to 74") but has a TODO for mcap mode ("CRANK 45mmc to 22mmc"). This is
   critical — most users will think in mcap, not price. curator.json already has
   `displayMode: "mc"` and `supply` fields ready.

5. **Wire Discord bot into harvester** (~30 min) — Pattern is in `packages/WIRING.md`.
   Add the conditional import block to `bot/anchor-harvest-bot.ts` run() method. Add
   env vars to bot/.env. This connects harvest/close notifications to Discord DMs.

6. **Test the full flow** — /start → fund wallet → /buy → wait for harvest → check
   DM notification → /positions → /close → /withdraw. This is the moment of truth.

**Read before starting:** `packages/docs/architecture.md` (full context doc),
`packages/docs/pool-routing.md` (command syntax + display modes),
`packages/docs/curator.md` (how pool config works).

---

## 🔴 HIGH PRIORITY

### Keypair Separation
The single keypair on the droplet (`/root/.keys/bot-keypair.json`) is admin authority
for all 5 programs, SPL stake pool manager, Config.bot fee recipient, AND the tx signer.
Server compromise = total loss.

- [ ] Generate a new minimal bot-signer keypair (only needs to sign harvest/close/sweep/keeper txs)
- [ ] Call `update_bot(NEW_BOT_PUBKEY)` on bin-farm to point Config.bot to new keypair
- [ ] Transfer program admin authority to a cold wallet (Ledger) via `transfer_authority` → `accept_authority` on each program
- [ ] Transfer SPL stake pool manager to the cold wallet
- [ ] Deploy new bot keypair to droplet, update `bot/.env`
- [ ] Fund new bot keypair with ~1 SOL (20% revenue share replenishes it)
- [ ] Old keypair becomes cold admin only — never on a server

### Discord / Telegram Bot
Draft code exists in `packages/discord-bot/` + `packages/core-sdk/` (migrated from
crankclank repo). 13 slash commands implemented, custodial wallet service with
AES-256-GCM encryption, range parser, notifier. Needs cleanup and wiring.

**What works (per build.md):** `/start`, `/deposit`, `/help`, `/pools`, `/vote`,
`/balance`, `/positions`, `/withdraw` — functional or near-functional.
**What needs real pool addresses + RPC:** `/buy`, `/sell`, `/close`.
**Stubbed:** `/burn`, `/claim` (were waiting for bCRANK, now use bank-mint + merkle-distributor).

- [ ] Clean `packages/core-sdk/constants.ts` — remove monke_bananas, add bank-mint/gauge-voter/distributor IDs
- [ ] Clean `packages/core-sdk/pda.ts` — remove monke_bananas PDAs, add bank/gauge/distributor PDAs
- [ ] Update `curator.json` with real pool addresses (currently REPLACE_WITH_REAL_ADDRESS)
- [ ] Add mcap mode to `parse-range.ts` (marked TODO — "45mmc to 22mmc" syntax)
- [ ] Wire `/burn` to bank-mint `burn_and_mint` instruction
- [ ] Wire `/claim` to merkle-distributor `claim` instruction
- [ ] Wire Discord bot into harvester orchestrator (`anchor-harvest-bot.ts` — pattern exists in crankclank)
- [ ] Add `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `WALLET_ENCRYPTION_KEY`, `DISCORD_FEED_CHANNEL_ID` to bot/.env
- [ ] Register slash commands: `npm run bot:deploy-commands`
- [ ] Test full flow: /start → /deposit → /buy → harvest notification → /close → /withdraw
- [ ] Future: Telegram adapter (`packages/telegram-bot/` — core-sdk is platform-agnostic)

### Epoch-Computer Service
The bot's `crankNewEpoch()` in `keeper.ts` reads pre-computed epoch data from
`EPOCH_DATA_PATH` — but the service that actually computes the tree doesn't exist
yet. Without it, daily Merkle distributions no-op.

**Daily epoch cycle (4:20 PM CST / 22:20 UTC):**

1. **Snapshot BANK holders** — `getProgramAccounts` filtered by BANK mint, parse
   owner + amount. Include LP-attributed BANK from DAMM v2 pool reserves.
2. **Read trader fees** — accumulated `HarvestEvent` logs since last epoch
   (gRPC subscription). Key fields: `owner`, `lb_pair`, `fee_amount`.
3. **Read gauge weights** — all `PoolGauge` PDAs → `Map<lbPair, weightBps>`.
4. **Compute per-wallet rewards** — holder 40% (pro-rata by BANK balance),
   trader 40% (fee-weighted per pool, scaled by gauge weight). Skip dust < `MIN_REWARD`.
   Cumulative accounting: `previous_cumulative + epoch_reward`.
5. **Build Merkle tree** — leaf = `keccak256(index || wallet || cumulative_amount)`.
   Include wallets from previous tree that didn't earn this epoch (cumulative unchanged).
6. **Pin to IPFS** — full tree JSON with epoch metadata, per-leaf breakdown.
7. **Write epoch-data.json** → `{ merkle_root: number[32], epoch_amount: string, ipfs_cid: string }`
   Keeper's `crankNewEpoch()` reads this and uploads on-chain.

**Events to index:**
- `HarvestEvent` — `owner`, `lb_pair`, `fee_amount` (trader reward metric)
- `RoverSweptEvent` — `holder_share`, `trader_share`, `operator_share`
- `NewEpochEvent` — `epoch`, `merkle_root`, `epoch_amount`, `ipfs_cid`
- `ClaimEvent` — `claimant`, `cumulative_amount`, `claimed_this_tx`

**Missed epoch handling:** No $PEGGED is lost — funds sit in accumulation accounts.
Next run covers the full period. Larger window, same math.

- [ ] Build epoch-computer (standalone service or integrated into keeper)
- [ ] Real-time HarvestEvent accumulation via gRPC
- [ ] IPFS pinning integration
- [ ] Wire into daily cron trigger
- [ ] Test full epoch cycle end-to-end on mainnet (small amount)
- [ ] Add epoch miss alerting (Telegram ping if cron doesn't fire within 10 min)

### Alerting System
No external alerting exists. If the bot crashes, nobody knows.

- [ ] Create `bot/alerter.ts` — Discord/Telegram webhook module with rate-limiting + dedup
- [ ] Wire into: gRPC disconnect/reconnect, harvest failures, keeper failures, low balance
- [ ] Add `/api/health` endpoint with staleness detection (last successful harvest timestamp,
  gRPC connected, keeper last run — returns 503 if stale beyond threshold)
- [ ] Register external uptime monitor (BetterStack or UptimeRobot) hitting `/api/health`
- [ ] Add `DISCORD_WEBHOOK_URL` to bot/.env

---

## 🟡 MEDIUM PRIORITY

### Community Doc Pages
Subdomains per community (e.g. `gsd.crank.money`) become landing/docs pages.
Explains the product, links to add the bot to Discord/Telegram.

- [ ] Design doc page template
- [ ] Deploy per-community subdomains
- [ ] Communities earn their spot by producing volume

### Token Metadata
**$BANK** (`BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA`) — no metadata registered.
**$PEGGED** (`GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1`) — name/symbol set, no logo/URI.

- [ ] Create $BANK logo image
- [ ] Host $BANK + $PEGGED off-chain metadata JSON + images (Arweave or GitHub)
- [ ] Register Metaplex token metadata on $BANK mint
- [ ] Call `UpdateTokenMetadata` via Sanctum program to set $PEGGED URI
- [ ] Verify both render correctly in Phantom / Solflare / Jupiter

### Dependency Hygiene
Bot uses `@coral-xyz/anchor@^0.30.1` but programs built with Anchor 0.31.1. All deps
use `^` ranges — risky for a financial protocol. `@meteora-ag/dlmm` especially iterates
fast and could pull breaking account layout changes.

- [ ] Pin critical deps to exact versions: `@coral-xyz/anchor`, `@meteora-ag/dlmm`,
  `@triton-one/yellowstone-grpc`, `@solana/web3.js`
- [ ] Evaluate Anchor 0.30 → 0.31 bot SDK upgrade (IDL compat)
- [ ] Run `npm install` to regenerate lockfile after package.json cleanup
- [ ] Add `npm audit` step to `scripts/deploy.sh`

### Bot Code Dedup
Duplicated utilities across bot files increase maintenance burden.

- [ ] Remove inline `withRetry` from `keeper.ts` (line ~84, uses different BASE_DELAY=2000) —
  import from `retry.ts`, pass delay as parameter
- [ ] Remove inline `withRetry` from `anchor-harvest-bot.ts` — import from `retry.ts`
- [ ] Extract `buildPriorityFeeIxs` to shared `bot/priority-fees.ts` (accept optional `cuLimit`
  param — keeper needs 1M for fee rovers, everything else uses 400K)
- [ ] Extract PDA derivation to shared `bot/pdas.ts` (coreConfigPDA, vaultPDA,
  roverAuthorityPDA duplicated across executor, keeper, orchestrator)

### Byte Parser Hardening
Raw byte parsers have no discriminator validation. If Meteora changes their LbPair
account layout, the bot silently reads garbage and harvests wrong bins.

- [ ] Add Anchor discriminator check (first 8 bytes) to `parseLbPairData()` in
  `geyser-subscriber.ts` — extract expected discriminator from DLMM IDL
- [ ] Add Sanctum `account_type` byte check (byte 0 == 1 for StakePool, 2 for ValidatorList)
  to `updateSanctumPool()` in `keeper.ts`
- [ ] Add tests for discriminator validation failures in `bot.test.ts`

### Droplet Hardening
- [ ] Set up log rotation for PM2 logs
- [ ] Add `kill_timeout: 10000` to ecosystem.config.cjs (give shutdown time to drain)
- [ ] Document recovery runbook (droplet dies → what to do)

---

## 🟢 LOW PRIORITY / NICE-TO-HAVE

### Rover TVL Computation
`keeper.ts` — currently hardcoded `tvl: 0`.

- [ ] Query DLMM bin values for each rover position
- [ ] Compute real TVL per rover
- [ ] Surface in `/api/rovers` endpoint

### Keeper Step-Level Retry
If the daily sequence fails mid-way (e.g. `stake_and_forward` fails due to epoch
staleness), the entire sequence re-runs from step 1 next tick. Steps 1-2 that already
succeeded re-execute unnecessarily (idempotent but wastes tx fees).

- [ ] Persist last successful step to disk (JSON file or SQLite)
- [ ] Resume from last successful step on next tick
- [ ] Expose keeper state via `/api/keeper` endpoint (current step, last run, errors)

### Relay Rate Limiting
The API is publicly exposed with no rate limiting. `/api/fees` and `/api/protocol-pnl`
make RPC calls that could be abused.

- [ ] Add per-IP rate limiting to relay REST endpoints
- [ ] Consider API key auth for sensitive endpoints

### Token-2022 Transfer Hooks
All CPI is V2 but transfer hook extra accounts are not resolved.
`RemainingAccountsInfo::empty_hooks()` used everywhere. Tokens with active transfer
hooks will revert.

- [ ] Resolve transfer hook extra accounts in Meteora CPI calls
- [ ] Requires IDL regen + on-chain program upgrade (bin-farm, pegged-bridge)

### On-Chain Test Suite
Zero program tests. CPI bugs only caught on mainnet.

- [ ] LiteSVM test harness for bin-farm (harvest, close, fee split, rover lifecycle)
- [ ] LiteSVM tests for bank-mint, gauge-voter, merkle-distributor
- [ ] Add to CI

### Testing (Bot)
- [ ] Integration test: full harvest → fee split → rover → sweep → stake → deposit cycle
- [ ] Add keeper unit tests (daily sequencer steps)
- [ ] Add relay-server endpoint tests

### Cleanup
- [ ] Redeploy pegged-bridge with updated comments (monke_bananas → Merkle distributor)
- [ ] Finalize crank-lend removal (if still staged)

---

## ✅ DONE

- [x] All 5 active Solana programs deployed and initialized on mainnet
- [x] Bot deployed on DO droplet (159.223.133.9 / bot.crank.money)
- [x] PM2 + nginx + SSL configured
- [x] deploy.sh operational (rsync + restart + health check)
- [x] Geyser subscriber (Helius LaserStream gRPC)
- [x] Harvest executor (job queue, dedup, priority fees)
- [x] Relay server (REST + WebSocket)
- [x] Daily keeper sequencer (6-step fee processing)
- [x] $BANK mint system (burn $CRANK → mint $BANK)
- [x] $PEGGED / crankSOL LST via Sanctum SPL stake pool
- [x] Merkle distributor program + vault ATA funded
- [x] Bridge vault → stake → $PEGGED pipeline
- [x] Revenue split 40/40/20 in bin-farm harvest/close
- [x] Protocol PnL aggregator (10-min cycle)
- [x] Bot wallet balance tracking endpoint
- [x] `crankNewEpoch()` plumbing in keeper (reads epoch-data.json)
- [x] Removed AddressBookStore (replaced by curated pool registry)
- [x] Removed frontend (src/frontend/, src/generated/, dist/, public frontend files)
- [x] Removed monke-bananas program, IDL, and all references
- [x] Removed stale scripts (18 deleted), ref/ directory, docs/
- [x] Removed frontend-specific relay endpoints
- [x] Updated all stale 50/50 comments to 40/40/20
- [x] Saturday keeper → daily keeper
- [x] Made BRIDGE_PROGRAM_ID + PEGGED_MINT required
- [x] Rewrote claude.md, README.MD, package.json, .gitignore
- [x] Cleaned fee-dashboard.ts, preflight-check.ts, generate-clients.mjs
