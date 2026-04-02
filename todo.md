# crank.money — TODO

> Living task list. Updated as work progresses.
> Last reviewed: 2026-04-01
>
> GTM strategy lives in `gtm.md` — this file is what to build, that file is who to talk to.

---

## NEXT SESSION — Resume Notes

### Context for next Claude

Major architecture changes landed 2026-03-31 → 2026-04-01:

**$PEGGED is dead.** Revenue distribution is now SOL via WSOL through Merkle distributor.
Both 80% fee shares (holder + trader) flow to `bridge_vault` PDA → epoch-computer drains daily → wraps WSOL → funds distributor → auto-claims to user custody wallets.

**What shipped:**
- epoch-vault program deployed (was pegged-bridge — same ID `7oHSUP...`, renamed module to `epoch_vault`, folder to `programs/epoch-vault/`)
- merkle-distributor upgraded with `update_mint` — mint changed to WSOL on-chain
- `trader_dest` on RoverAuthority changed to `bridge_vault` (verified on-chain)
- `epoch-computer.ts` built + wired into keeper daily sequence as step 3
- `/claim`, `/unstake`, `/setwithdraw` commands killed
- `/withdraw` redesigned (bare = dashboard, with param = execute)
- `/close` redesigned (bare = show positions, `all` = rage quit)
- Deposit auto-detection for withdraw address (`deposit-detect.ts`)
- Droplet resized to s-2vcpu-4gb, 1GB swap added

**What needs verification / finishing:**
1. **Epoch-computer end-to-end test** — the code is deployed but has never run a real epoch. Needs manual trigger with test amount to verify: drain_vault → wrap WSOL → new_epoch → auto-claim. The keccak256 hash function in epoch-computer.ts needs `@noble/hashes` installed (currently falls back to sha3-256 which produces WRONG proofs).
2. **`sweep_rover` with new `trader_dest`** — keeper logged `InvalidTraderDest` error during the transition. Verify the next sweep works now that trader_dest is set to bridge_vault on-chain. Check if the Anchor account constraint is satisfied.
3. **Anchor IDL for epoch_vault** — built and deployed to `bot/idl/epoch_vault.json`. Verify the orchestrator loads it without error.
4. **`bridgeProgram` references** — removed from orchestrator + keeper. Grep for any remaining `bridgeProgram` or `BRIDGE_PROGRAM_ID` references in bot/ that could crash.
5. **Discord command registration** — 12 commands registered globally. Old commands (setwithdraw, claim, unstake) may take up to 1 hour to disappear from autocomplete.
6. **claude.md, README.MD, gtm.md** — partially updated this session but need full review for remaining $PEGGED/pegged-bridge references.
7. **Docs: claude-bot.md, claude-discord.md, claude-core-sdk.md** — still have stale PEGGED references.

**Key files changed:**
- `programs/epoch-vault/src/lib.rs` — stripped pegged-bridge, added `drain_vault`
- `programs/merkle-distributor/src/lib.rs` — added `update_mint` instruction
- `bot/epoch-computer.ts` — NEW: full epoch distribution pipeline
- `bot/keeper.ts` — removed bridge/PEGGED code, added `crankEpochDistribution`
- `bot/anchor-harvest-bot.ts` — removed bridge program, added epoch-vault program
- `packages/discord-bot/src/deposit-detect.ts` — NEW: auto withdraw address detection
- `packages/discord-bot/src/commands/withdraw.ts` — redesigned (dashboard + execute)
- `packages/discord-bot/src/commands/close.ts` — redesigned (show positions + close all)
- `packages/core-sdk/price-source.ts` — SOL price from Pyth, DexScreener hardened with stablecoin + symbol consensus filters
- `packages/discord-bot/src/commands/start.ts` — simplified deposit prompt
- `packages/core-sdk/constants.ts` — PEGGED_MINT removed from exports + KNOWN_TOKENS

---

## GTM BLOCKERS — Priority Order

### 1. Epoch-Computer — End-to-End Test (GTM BLOCKER #1)
The epoch-computer code exists (`bot/epoch-computer.ts`) and is wired into the keeper's daily sequence. It has NEVER run a real epoch.

**Remaining work:**
- [ ] Install `@noble/hashes` on droplet (keccak256 for Merkle proofs — current fallback uses sha3-256 which won't match on-chain verification)
- [ ] Manual test: trigger `runEpoch()` with the 0.003 SOL in bridge_vault
- [ ] Verify drain_vault → WSOL wrap → new_epoch → auto-claim cycle end-to-end
- [ ] Verify the Merkle proof passes on-chain `claim()` verification
- [ ] Add IPFS pinning (set PINATA_JWT in bot/.env)
- [ ] Add epoch miss alerting (feed channel alert if keeper doesn't fire within 10 min)

### 2. Token Metadata (GTM BLOCKER #2)
$BANK has zero metadata. Looks like a scam token in Phantom. Fix before any outreach.

- [ ] Create $BANK logo image
- [ ] Host $BANK off-chain metadata JSON + image (Arweave or GitHub)
- [ ] Register Metaplex token metadata on $BANK mint
- [ ] Verify renders correctly in Phantom / Solflare / Jupiter

### 3. Analytics — `#crank-stats` + `/stats` (GTM BLOCKER #3)
When pitching — point at real numbers.

- [ ] Add `/stats` slash command — user count, volume, harvests, fees, uptime
- [ ] Add daily cron that posts formatted stats to `#crank-stats` Discord channel
- [ ] Track volume: log USD value of every `/buy` and `/close`
- [ ] Track daily active users

### 4. UI Command Review (Polish Before Users)
Go through each command. Test, fix formatting, error messages, edge cases.

- [x] `/start` — simplified to deposit prompt
- [x] `/setwithdraw` — replaced by auto-detection from first deposit
- [ ] `/deposit` — address display + withdraw address
- [ ] `/balance` — WSOL auto-unwrap, solscan links, withdraw address
- [ ] `/buy` — mcap/price/pct input, error messages, position opened format
- [ ] `/sell` — quote auto-resolve, deposit symbol display
- [ ] `/positions` — mcap display, fill bars, harvest totals
- [x] `/close` — bare shows positions with IDs, `/close all` rage quits
- [x] `/withdraw` — bare shows dashboard, `/withdraw SOL .5` executes
- [ ] `/pools` — price display, examples
- [ ] `/vote` — gauge voting
- [ ] `/burn` — CRANK → BANK
- [ ] `/help` — command list (updated, no claim/unstake/setwithdraw)

### 5. Price Sync Bot (Arb Bot)
Detection deployed. Swap execution needs direct Meteora DLMM instructions.

- [ ] Replace Jupiter swap with direct Meteora DLMM `swap` instruction
- [ ] Build swap instruction targeting specific LbPair address
- [ ] Handle bin array account resolution for the swap range
- [ ] Profitability check
- [ ] Test with small amounts on mainnet
- [ ] Enable live swaps (`SYNC_ENABLED=true`)

### 6. GSD Community Launch (First GTM Target)
- [ ] Build gsd.crank.money landing page
- [ ] Test mobile frontend
- [ ] Record video demo
- [ ] Share in GSD X community + Telegram

---

## HIGH PRIORITY (Ship When Possible)

### Keypair Separation
Single keypair controls everything. Server compromise = total loss.

- [ ] Generate a new minimal bot-signer keypair
- [ ] Call `update_bot(NEW_BOT_PUBKEY)` on bin-farm
- [ ] Transfer program admin authority to cold wallet (Ledger)
- [ ] Transfer SPL stake pool manager to cold wallet
- [ ] Deploy new bot keypair to droplet
- [ ] Old keypair becomes cold admin only

### Gas Offloading — Remaining
- [x] Auto-claim at epoch: keeper claims for all users via epoch-computer
- [ ] Minimum SOL balance check before harvesting — DM notification if user is dry

### Dynamic Supply Refresh for curator.json
- [ ] Add `refreshTokenSupplies()` — reads CRANK mint supply via RPC
- [ ] Call on bot startup + periodic timer

---

## MEDIUM PRIORITY

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

## LOW PRIORITY / NICE-TO-HAVE

### Telegram Adapter
Core-SDK is platform-agnostic. ~300-400 lines. After Discord is proven.

### LP Bot Skill / API Layer
Offer crank.money's harvester as a skill/API for other LP bots.

### Bittensor Subnet (Seby)
Continue conversation. Ship epoch-computer + analytics first.

### Dependency Hygiene
- [ ] Pin critical deps to exact versions

### Bot Code Dedup
- [ ] Remove inline `withRetry` copies
- [ ] Extract `buildPriorityFeeIxs` to shared module

### Droplet Operations
- [ ] Register external uptime monitor (UptimeRobot) hitting `/api/health`
- [ ] Document recovery runbook

---

## DONE

- [x] All 5 active Solana programs deployed and initialized on mainnet
- [x] epoch-vault program deployed (was pegged-bridge — same program ID, repurposed)
- [x] merkle-distributor upgraded with `update_mint` instruction
- [x] Distributor mint changed from $PEGGED → WSOL on-chain
- [x] `trader_dest` changed to `bridge_vault` (both 80% fee shares → one PDA)
- [x] $PEGGED killed — unstaked all holdings, closed ATAs, removed from codebase
- [x] `/claim` and `/unstake` commands removed (auto-claim via epoch-computer replaces them)
- [x] `/setwithdraw` replaced by auto-detection (deposit-detect.ts)
- [x] `/withdraw` redesigned — bare shows dashboard, with param executes
- [x] `/close` redesigned — bare shows positions with IDs, `/close all` rage quits
- [x] `/start` simplified — deposit address + one-line prompt
- [x] `/balance` updated — solscan links, withdraw address display
- [x] epoch-computer.ts built + wired into keeper daily sequence
- [x] Droplet resized to s-2vcpu-4gb + 1GB swap added
- [x] 12 slash commands registered (down from 15)
- [x] Bot deployed on DO droplet (bot.crank.money)
- [x] PM2 + nginx + SSL configured
- [x] deploy.sh operational (rsync + restart + health check)
- [x] Geyser subscriber (Helius LaserStream gRPC)
- [x] Harvest executor (job queue, dedup, priority fees)
- [x] Relay server (REST + WebSocket)
- [x] Daily keeper sequencer (5-step fee processing)
- [x] $BANK mint system (burn $CRANK → mint $BANK)
- [x] Revenue split 40/40/20 in bin-farm harvest/close
- [x] Protocol PnL aggregator (10-min cycle)
- [x] Bot wallet balance tracking endpoint
- [x] Removed frontend, monke-bananas, stale scripts, ref/, docs/
- [x] Updated all stale 50/50 comments to 40/40/20
- [x] Cleaned core-sdk: constants, PDAs, pool routing, range parser
- [x] Populated curator.json with 6 real Meteora DLMM pools + examples
- [x] Built pool routing layer in core-sdk
- [x] Wired all 12 slash commands
- [x] Fixed /withdraw — Token-2022 transfer_checked, per-mint decimals
- [x] Wired Discord bot into harvester orchestrator (harvest/close → DMs + feed)
- [x] Deployed Discord bot — crankbot#8555, feed channel resolved
- [x] Installed fail2ban + hardened SSH + UFW on droplet
- [x] Fixed deploy.sh — rsync excludes data/, pre-deploy backup added
- [x] Encryption key backed up to /root/.keys/wallet.key (chmod 600)
- [x] Wallet DB auto-backup: per-minute cron to DO Spaces
- [x] Daily DO droplet snapshots enabled
- [x] Nginx rate limiting: 10 req/s per IP + 2 WS conn per IP
- [x] Gas offloading — two-signer: bot=authorized bot, user=fee payer
- [x] Harvest enrichment — token deltas from confirmed tx
- [x] WSOL auto-unwrap — /balance, executor, /buy
- [x] Safety poll 30s interval
- [x] DexScreener price fix — base-token filter + volume sort (original fix)
- [x] SOL price from Pyth Hermes oracle — eliminates FOGO contamination permanently
- [x] DexScreener hardened — stablecoin pair preference + symbol consensus filter for non-SOL tokens
- [x] Token-2022 hook guards
- [x] Price syncer detection loop deployed (swap execution pending)
