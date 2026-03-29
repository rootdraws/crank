# crank.money — TODO

> Living task list. Updated as work progresses.
> Last reviewed: 2026-03-29

---

## 🟣 NEXT SESSION — Priority Order

Discord bot is code-complete (15 commands, routing, gauges, harvester integration).
Everything below is ordered by dependency chain — later tiers are blocked by earlier ones.

### Tier 0 — Security [DONE]

See `security.md` for full checklist.

- [x] Reset Discord bot token
- [x] Replace WALLET_ENCRYPTION_KEY (fresh key, no migration needed — no funded wallets)
- [x] Encryption key backed up: password manager + `/root/.keys/wallet.key`
- [x] Wallet DB backed up: DO Spaces (per-minute cron) + local copy + daily DO snapshots
- [x] deploy.sh hardened: pre-deploy backup of wallet DB before rsync
- [x] setup-droplet.sh rebuilt: fail2ban, unattended-upgrades, SSH hardening, PM2 log rotation
- [x] Nginx rate limiting: 10 req/s per IP (API), 2 concurrent WS connections per IP
- [x] `/setwithdraw` — one-time withdrawal address lock per user
- [ ] Keypair separation — needs a fresh Ledger (cold admin + hot bot-signer). See Tier 4.

### Tier 1 — Go Live

Bot deployed and running as `crankbot#8555`. 15 slash commands registered (global).
Env vars configured. Feed channel `#crank-feed` resolved.

**Remaining:**
1. **Test the full command flow** — /start → /setwithdraw → fund wallet → /buy → wait for
   harvest → DM notification → /positions → /close → /withdraw → /burn → /claim → /unstake

### Tier 2 — Before Real Users

- **Harvest Event Enrichment** — DMs currently show "0 SOL harvested" (no vault balance deltas). Embarrassing.

### Tier 3 — Before Scaling

- **Gas Offloading** — sign harvests/auto-close with user's custody keypair. Without this, 10 active users drain the bot wallet.
- **Epoch-Computer** — the entire revenue distribution (40% holders + 40% traders via Merkle tree) is a no-op until this exists. The flywheel doesn't turn.

### Tier 4 — Quality of Life

- Keypair separation (requires fresh Ledger — cold admin + hot bot-signer)
- RPC optimization (priority fee cache, batch reads)
- Dynamic CRANK supply refresh
- Tx simulation guard (don't burn user gas on reverts)
- Bot code dedup + program ID drift fix
- Token metadata ($BANK logo, $PEGGED URI)

### Tier 5 — Growth

- Community doc pages (gsd.crank.money)
- Competitive analysis (Trojan, Bonkbot, Maestro, etc.)
- Telegram adapter

---

## 🔴 HIGH PRIORITY

### Gas Offloading — User-Paid Harvests + Auto-Close + Auto-Claim
The bot holds every custody keypair. All per-user operations can be signed with
the user's keypair, using the user's SOL for gas instead of the bot wallet.
This is critical for scaling — without it, the 20% operations cut must cover
gas for every harvest of every user, which doesn't scale.

**User pays gas for (their custody wallet SOL):**
- `harvest_bins` — bot signs with user's custody keypair
- `close_position` (auto-close on fully filled) — same
- `claim` (auto-claim at epoch) — program supports payer != claimant, but
  easier to just sign as the user since we hold the keypair
- All Discord commands (already the case: /buy, /sell, /close, /burn, /vote, /withdraw)

**Bot pays gas for (protocol-level only):**
- `sweep_rover` — 40/40/20 fee split
- `stake_and_forward` — SOL → $PEGGED pipeline
- `open_fee_rover` — token fee conversion
- `new_epoch` — Merkle root upload
- `close_exhausted_rovers` — rent recovery
- Sanctum pool updates

**Implementation:**
- [ ] In harvest-executor: look up position owner → `walletService.getOrCreate(userId)` → sign with user keypair
- [ ] In auto-close path: same — use owner's custody keypair
- [ ] Add auto-claim at epoch: for each user in the Merkle tree, claim using their custody keypair.
  Stubbed as `notifier.onEpochComplete()` — wire from keeper after `crankNewEpoch()`.
  If user has SOL: auto-claim + DM "Claimed X $PEGGED". If dry: DM "deposit SOL to auto-claim or /claim manually".
- [ ] Add minimum SOL balance check before harvesting — if user is dry, queue a DM notification ("fund your wallet to keep harvesting")
- [ ] Fallback: if user has no SOL, bot keypair can still harvest as permissionless fallback (existing path, uses keeper_tip_bps)

### Keypair Separation
The single keypair on the droplet (`/root/.keys/bot-keypair.json`) is admin authority
for all 5 programs, SPL stake pool manager, Config.bot fee recipient, AND the tx signer.
Server compromise = total loss. Requires a fresh Ledger (never seeded into software).

- [ ] Generate a new minimal bot-signer keypair (only needs to sign harvest/close/sweep/keeper txs)
- [ ] Call `update_bot(NEW_BOT_PUBKEY)` on bin-farm to point Config.bot to new keypair
- [ ] Transfer program admin authority to a cold wallet (Ledger) via `transfer_authority` → `accept_authority` on each program
- [ ] Transfer SPL stake pool manager to the cold wallet
- [ ] Deploy new bot keypair to droplet, update `bot/.env`
- [ ] Fund new bot keypair with ~1 SOL (20% revenue share replenishes it)
- [ ] Old keypair becomes cold admin only — never on a server

### Epoch-Computer Service
The bot's `crankNewEpoch()` in `keeper.ts` reads pre-computed epoch data from
`EPOCH_DATA_PATH` — but the service that actually computes the tree doesn't exist
yet. Without it, daily Merkle distributions no-op.

**Daily epoch cycle (4:20 PM CST / 22:20 UTC):**

1. **Snapshot BANK holders** — `getProgramAccounts` filtered by BANK mint, parse
   owner + amount. Include LP-attributed BANK from DAMM v2 pool reserves.
2. **Read trader fees** — accumulated `HarvestEvent` logs since last epoch
   (gRPC subscription). Key fields: `owner`, `lb_pair`, `fee_amount`.
3. **Read gauge weights** — one PoolGauge per pair → `Map<pair, weightBps>`. Aggregate fees across all bin step pools for each pair.
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
- [ ] Add epoch miss alerting (feed channel alert if cron doesn't fire within 10 min)

---

## 🟡 MEDIUM PRIORITY

### Dynamic Supply Refresh for curator.json
`curator.json` has a static `supply` field for CRANK used in mcap ↔ price conversion.
Burns reduce supply over time, so this drifts. Bot should read on-chain mint supply
on startup and refresh periodically (e.g. every keeper tick or on a 1-hour timer).

- [ ] Add `refreshTokenSupplies()` — reads CRANK mint supply via RPC, updates in-memory pool registry
- [ ] Call on bot startup + periodic timer
- [ ] Keep `curator.json` static value as fallback if RPC fails

### Competitive Analysis — Telegram/Discord Trading Bots
Before selling to communities, understand the landscape. Go through each one at a time:
Trojan, Bonkbot, Maestro, Banana Gun, Unibot, Sol Trading Bot, GMGN, Photon, BullX.

For each:
- [ ] Fee structure (per-swap fee, spread, hidden fees)
- [ ] Revenue share model (do they share with users? token holders?)
- [ ] Security model (custodial? how do they handle keys? any rugs?)
- [ ] What they offer vs what crank.money offers (swaps vs ranged limit orders)
- [ ] Their volume / market position

**Pitch angle:** They charge 0.5-1% on simple swaps. You charge 0.3% on converted
output only, with ranged limit orders that earn LP fees while waiting. Plus 80% rev
share back to holders and traders. Build the comparison table for sales materials.

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

### Harvest Event Enrichment
Executor emits `harvestExecuted` and `positionClosed` with `txSig` (fixed) but without
token amounts. Notifier falls back to '0' for `tokenXAmount`, `tokenYAmount`, `feeAmount`,
`totalHarvested` — harvest DMs show zero amounts. Need vault balance deltas.

- [ ] In harvest-executor: read vault token balances before and after harvest CPI
- [ ] Compute `x_received`, `y_received` from deltas (same pattern as on-chain program)
- [ ] Compute fee amount: `received * fee_bps / 10_000`
- [ ] Track cumulative `totalHarvested` per position in walletService
- [ ] Include all fields in emitted events

---

## 🟢 LOW PRIORITY / NICE-TO-HAVE

### Dependency Hygiene
- [ ] Pin critical deps to exact versions
- [ ] Evaluate Anchor 0.30 → 0.31 bot SDK upgrade

### Bot Code Dedup
- [ ] Remove inline `withRetry` copies — import from `retry.ts`
- [ ] Extract `buildPriorityFeeIxs` to shared module
- [ ] Unify PDA derivation (core-sdk vs bot/ env vars)

### RPC Optimization
- [ ] Cache `getRecentPrioritizationFees()` for 10 seconds
- [ ] Use `getMultipleAccountsInfo()` for batch reads

### Tx Simulation Guard
- [ ] `connection.simulateTransaction()` before `signAndSend` in user commands

### Rover TVL Computation
- [ ] Query DLMM bin values for each rover position

### Keeper Step-Level Retry
- [ ] Persist last successful step, resume on next tick

### Token-2022 Transfer Hooks
- [ ] Resolve transfer hook extra accounts in Meteora CPI calls

### On-Chain Test Suite
- [ ] LiteSVM test harness for all 5 programs

### Droplet Operations
- [ ] Add `kill_timeout: 10000` to ecosystem.config.cjs
- [ ] Document recovery runbook
- [ ] Register external uptime monitor (UptimeRobot) hitting `/api/health`

---

## ✅ DONE

- [x] All 5 active Solana programs deployed and initialized on mainnet
- [x] Bot deployed on DO droplet (bot.crank.money)
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
- [x] Removed frontend, monke-bananas, stale scripts, ref/, docs/
- [x] Updated all stale 50/50 comments to 40/40/20
- [x] Saturday keeper → daily keeper
- [x] Made BRIDGE_PROGRAM_ID + PEGGED_MINT required
- [x] Rewrote claude.md, README.MD, package.json, .gitignore
- [x] Cleaned fee-dashboard.ts, preflight-check.ts, generate-clients.mjs
- [x] Cleaned core-sdk: constants, PDAs, pool routing, range parser
- [x] Populated curator.json with 6 real Meteora DLMM pools + examples
- [x] Built pool routing layer in core-sdk
- [x] Wired all 15 slash commands (buy, sell, vote, burn, claim, unstake, setwithdraw, etc.)
- [x] Fixed /withdraw — Token-2022 transfer_checked, per-mint decimals, "all" amount
- [x] Wired Discord bot into harvester orchestrator (harvest/close → DMs + feed)
- [x] Added priceSource field — DexScreener for CRANK/SOL mcap with 10s cache
- [x] Fixed Codama import paths — regenerated clients
- [x] Fixed harvest-executor event shape — txSig included
- [x] Deployed Discord bot — crankbot#8555, feed channel resolved
- [x] Installed fail2ban + hardened SSH + UFW on droplet
- [x] Fixed deploy.sh — rsync excludes data/, pre-deploy backup added
- [x] Scrubbed droplet IP from public-facing files
- [x] Reset Discord bot token (leaked in chat)
- [x] Replaced WALLET_ENCRYPTION_KEY (leaked in chat, no funded wallets)
- [x] Encryption key backed up to /root/.keys/wallet.key (chmod 600)
- [x] Wallet DB auto-backup: per-minute cron to DO Spaces (s3://crank-backups)
- [x] Daily DO droplet snapshots enabled
- [x] Nginx rate limiting: 10 req/s per IP + 2 WS conn per IP
- [x] setup-droplet.sh rebuilt: fail2ban, unattended-upgrades, SSH hardening, PM2 log rotation
- [x] deploy.sh hardened: pre-deploy wallet DB backup + rollback instructions
- [x] `/setwithdraw` — one-time withdrawal address lock (15th command)
- [x] Fixed keeper `sweep_rover` — missing `traderDest` account
- [x] Fixed CRANK price in /buy and /sell — DexScreener with 10s per-mint cache
- [x] `fetchDexScreenerPrice` extracted to core-sdk/price-source.ts (shared)
- [x] Built alerter — gRPC disconnect/reconnect, low balance, keeper failures → feed channel
- [x] Added `/api/health` endpoint — returns 503 when gRPC disconnected or balance critical
- [x] Wired gRPC subscriber disconnect/reconnect events for alerting
- [x] Fixed mcap-to-bin conversion for non-USD quote pools (CRANK/SOL) — USD prices divided by quoteTokenUsdPrice before priceToBin
- [x] Fixed setup tx CU limit — 800K for bin array init (was 200K, exceeded on binStep 80 pools)
- [x] Improved /buy error messages — extracts simulation log failure reason, logs full error server-side
