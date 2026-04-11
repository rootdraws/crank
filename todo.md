# crank.money — TODO

> GTM strategy lives in `gtm.md` — this file is what to build, that file is who to talk to.

---

## IMMEDIATE — Ops Steps (No Code Needed)

Verified on droplet 2026-04-11. Bot online, healthy, gRPC connected.

1. ~~Deploy bin-farm + merkle-distributor upgrades to mainnet~~ — DONE 2026-04-09
2. ~~Dry-run + live E2E epoch test~~ — DONE 2026-04-09 (Epoch 1 distributed end-to-end)
3. ~~Set PINATA_JWT on droplet~~ — DONE 2026-04-11. Merkle trees now pinned to IPFS.
4. ~~Set gas_lamports~~ — DONE 2026-04-11. Set to 125,000 lamports ($0.01/op at $80 SOL). Bot recoups vault creation rent after ~10 user operations. Each full position cycle (open → harvest chunks → close → withdraw) reimburses bot ~$0.12.
5. ~~Set RELAY_AUTH_TOKEN~~ — DONE 2026-04-11. All `/api/*` endpoints (except `/api/health`) require `Authorization: Bearer <token>`. Token stored in local `.env` and droplet `bot/.env`.
6. ~~Stale pending_emergency_close~~ — DONE 2026-04-11. Overwritten with `Pubkey::default` via `proposeEmergencyClose`. Old target `EQzqS7Pg…` cleared. New proposal targets nothing, expires harmlessly.

---

## NEXT SESSION — Resume Notes

### Context for next Claude

**HACKATHON MODE (April 2026).** Colosseum hackathon ~1 month window.

**2026-04-09 session: First epoch distribution on mainnet. Custodial era retired.**
- Upgraded bin-farm on mainnet (binary `358bc9dc…`, +104KB for PDA vault instructions)
- Skipped merkle-distributor upgrade — hash-compared local and chain, already identical
- Upgraded epoch-vault on mainnet (fixed `drain_vault` runtime bug: it tried direct lamport mutation on a system-owned PDA, which the runtime rejects; now uses `system_program::transfer` via `invoke_signed` with vault PDA seeds)
- Force-closed 4 rover positions before the bin-farm upgrade (required before program swap)
- Ran Epoch 1 end-to-end: drain → WSOL wrap → new_epoch → claim → manual WSOL close → 0.023 SOL landed in Root's wallet `E9Zuou7Mr…`. Full pipeline exercised for the first time.
- **Custodial wallet DB wiped.** Deleted `data/crankbot.json` + all `pre-*` sidecars + `positions-cache.json` + `feed-cache.json` on droplet. Removed `WALLET_ENCRYPTION_KEY` from `bot/.env`. Scrubbed all 5434 historical wallet DB snapshots from `s3://crank-backups/`. Bot runs against an empty DB; Root must re-register via `/start wallet:<his_wallet>` to create a fresh `UserVault` PDA in the new format.
- **Fee rover system redesigned.** Value-based threshold using DexScreener (`MIN_FEE_ROVER_USD=10`) + adaptive bin width (`FEE_ROVER_BIN_USD=0.50`, clamped 5-70). Dust accumulates instead of being deployed to gas-wasteful rovers. Verified live: keeper correctly skipped a $0.08 USDC balance with "Fee rover below USD floor — accumulating".
- **Bot keypair NOT rotated** — still `FFwqCuYTw7DF…`, still holds upgrade authority for all 5 programs + Config.bot + signs every bot tx. Scope was "only custodial user-keypair cruft".

**Latent issues / things to know:**
- **Abandoned CRANK rover** (`9mfjS4o6…`) — 264 CRANK (~$0.26) locked in a 70-bin BidAskImBalanced position on CRANK/SOL. Opened accidentally by the keeper before today's fee-rover threshold fix. Gas on the open is sunk cost. Will close naturally via keeper's exhausted-close step when price eventually rips through bins -1115 to -1046. Not worth engineering time to force-recover.
- **Historical harvest records had units ambiguity** — `amount_out` was stored in token units of whichever side was converted (CRANK for Buys, SOL for Sells). A backfill that treated them all as SOL inflated the "expected bridge_vault inflow" by ~100x. This is moot now — the backfill was only used to bootstrap Epoch 1, and the wallet DB that contained those records was wiped. Post-wipe enrichment is correct: `harvest-executor` now computes `feeTaken` from the nonzero delta side, and `notifier` threads it through to `saveHarvest`.
- **Auto-claim bundle was wired to call `unwrap_wsol_in_vault` after `claim()` in a single tx.** In Epoch 1 this bundle failed because the user's claimant was the old custodial wallet, not a vault PDA, and PDA seed verification rejected the unwrap. Once all users are on the new flow (vault PDAs), the bundle should work correctly on its own. No code fix needed.

**2026-04-08 session: PDA vault migration COMPLETE.**
Replaced all custodial keypairs with on-chain PDA vaults. Biggest session in project history.

**2026-04-08 session: Epoch-computer hardened + test infrastructure built.**
- Exported internals for testing (`computeShares`, `buildMerkleTree`, `hashLeaf`, `hashPair`)
- Added configurable `minEpochLamports` to `EpochComputerConfig` (vault has ~0.003 SOL, below default 0.01)
- Changed `runEpoch()` return from `boolean` to `EpochResult { ran, epoch, amountSol, userCount }`
- Fixed BN precision — `new BN(progress.drainAmount)` instead of lossy `Number()` intermediate
- Dynamic rent-exempt via `getMinimumBalanceForRentExemption(0)` (was hardcoded 890,880)
- Added harvest skip warning (was silent `continue`)
- Added 500ms throttle between auto-claims (prevents RPC rate limiting at scale)
- Added `lastEpochTimestamp` to `EpochState` for epoch-miss detection
- Created `scripts/test-epoch.ts` — standalone epoch trigger with `--dry-run` and `--min-lamports`
- Created `bot/epoch-computer.test.ts` — 27 unit tests (Merkle proof verification, share computation, hashing)
- Added `alertEpochMiss()` + `alertEpochSuccess()` to `bot/alerter.ts`
- Wired epoch alerting into `bot/keeper.ts` (miss detection at sequence start, success after epoch)

**What still needs doing:**
1. ~~**Deploy bin-farm + merkle-distributor upgrades to mainnet**~~ — DONE 2026-04-09 (bin-farm upgraded, merkle-distributor already matched)
2. ~~**Run epoch E2E test**~~ — DONE 2026-04-09 (Epoch 1 distributed 0.021 SOL end-to-end)
3. ~~**Set PINATA_JWT**~~ — DONE 2026-04-11
4. ~~**Set gas_lamports**~~ — DONE 2026-04-11 (125,000 lamports)
5. **$BANK metadata** — Metaplex registration
6. **Web rebrand** — "community-first market making tool"
7. **Activate @libraryofCrank + CRM**
8. **Root re-onboards via `/start`** — wallet DB is empty post-wipe, needs one `/start wallet:E9Zuou7Mr…` to create his new UserVault PDA in the clean format. Fixed 2026-04-11: `/start` wallet option was missing from Discord command registration (`deploy-commands.ts`), and `this.botKeypair` was undefined in `anchor-harvest-bot.ts` (should be module-level `botKeypair`). Both fixed and deployed.
9. ~~**Audit H-09: enable encrypted backups**~~ — DONE 2026-04-10. `/root/.keys/backup.key` generated (`openssl rand -hex 32`, mode 0600). Note: backup script has been silently skipping with "No wallet DB found" since the custodial wipe — `data/crankbot.json` doesn't exist, so no encryption is being exercised yet. Will activate naturally on first user `/start`.

**Build commands:**
```bash
# Check compilation
RUSTUP_TOOLCHAIN=1.84.1-sbpf-solana-v1.51 cargo check -p bin-farm
# Build SBF binary (Homebrew cargo doesn't work — need rustup's)
PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml
# IDL + Codama
PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor idl build -p bin_farm -o bot/idl/bin_farm.json
node scripts/generate-clients.mjs
# Run epoch tests
npx vitest run bot/epoch-computer.test.ts
# Epoch dry-run
npx tsx scripts/test-epoch.ts --dry-run --min-lamports 1000000
```

---

## GTM BLOCKERS — Priority Order

### 1. Epoch-Computer — End-to-End Test (GTM BLOCKER #1)
The epoch-computer code exists (`bot/epoch-computer.ts`) and is wired into the keeper's daily sequence. It has NEVER run a real epoch. Code hardened + test infrastructure built (2026-04-08).

**Remaining work:**
- [x] ~~Install `@noble/hashes`~~ — DONE (audit C-01: direct dep + self-test)
- [x] ~~Crash recovery~~ — DONE (audit H-03: staged progress, resume on restart)
- [x] ~~Deterministic leaf ordering~~ — DONE (audit M-11: wallets sorted before tree build)
- [x] ~~Unit tests~~ — DONE (27 tests: Merkle proof verification, share computation, hashing)
- [x] ~~Manual test script~~ — DONE (`scripts/test-epoch.ts` with `--dry-run` and `--min-lamports`)
- [x] ~~Epoch miss alerting~~ — DONE (`alertEpochMiss` + `alertEpochSuccess` in alerter.ts, wired into keeper)
- [x] ~~Configurable threshold~~ — DONE (`minEpochLamports` in EpochComputerConfig)
- [x] ~~BN precision fix~~ — DONE (was losing precision via Number() intermediate)
- [x] ~~Dynamic rent-exempt~~ — DONE (was hardcoded 890,880)
- [ ] Dry-run: `npx tsx scripts/test-epoch.ts --dry-run --min-lamports 1000000`
- [ ] Live E2E: `npx tsx scripts/test-epoch.ts --min-lamports 1000000`
- [ ] Verify drain_vault → WSOL wrap → new_epoch → auto-claim cycle end-to-end
- [ ] Verify the Merkle proof passes on-chain `claim()` verification
- [ ] Add IPFS pinning (set PINATA_JWT in bot/.env)

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
- [x] `/buy` — mcap/price/pct input, k/m/b suffixes, error messages, examples updated
- [x] `/sell` — quote auto-resolve, k/m/b suffixes, examples updated
- [x] `/positions` — mcap display, fill bars, range status text fixed
- [x] `/close` — bare shows positions with IDs, `/close all` rage quits
- [x] `/withdraw` — bare shows dashboard, `/withdraw SOL .5` executes
- [ ] `/pools` — price display, examples
- [x] `/vote` — gauge voting (PoolGauge PDAs created, tested)
- [ ] `/burn` — CRANK → BANK
- [x] `/help` — command list updated, examples use k suffix

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

### PDA Vault Migration (DONE — 2026-04-08)
Replaced custodial keypairs with on-chain PDA vaults. Users' funds live in program-owned accounts. Bot is stateless operator.

- [x] Design PDA vault account structure (seeds: `[b"user_vault", owner_wallet]`)
- [x] Implement 8 vault instructions (create, withdraw_sol/token, wrap/unwrap WSOL, burn, vote, gas config)
- [x] Modify 5 existing instructions (open, harvest, close_position, user_close, claim_fees)
- [x] Migrate wallet-service from AES-encrypted keypairs to PDA vault references
- [x] Update all 12 Discord bot commands for vault flow
- [x] Gas model: 9 instructions reimburse bot from vault via deduct_gas
- [x] Epoch claims bundled with WSOL unwrap — vault pays
- [x] IDL + Codama regenerated, SBF binary built
- [ ] **Deploy to mainnet** — force-close existing positions first, then `anchor upgrade`
- [ ] **Set gas_lamports** — call `update_gas_lamports()` after deploy

### Keypair Separation (Audit C-02)
Single keypair controls everything. Server compromise = total loss. (Lower priority than PDA migration — PDA vaults solve the user-side trust problem first.)

- [ ] Generate a new minimal bot-signer keypair
- [ ] Call `update_bot(NEW_BOT_PUBKEY)` on bin-farm
- [ ] Transfer program admin authority to cold wallet (Ledger)
- [ ] Transfer SPL stake pool manager to cold wallet
- [ ] Deploy new bot keypair to droplet
- [ ] Old keypair becomes cold admin only

### Deploy Audit Fixes — Server-Side Activation
Code is in the repo. These items need server actions to take effect.

**Relay auth (audit H-04):**
- [x] ~~Generate token~~ — DONE 2026-04-11
- [x] ~~Add `RELAY_AUTH_TOKEN` to `bot/.env`~~ — DONE 2026-04-11
- [x] ~~Restart PM2~~ — DONE 2026-04-11. Verified: unauthenticated `/api/stats` → 401, with token → 200, `/api/health` → 200 (always open)
- [ ] Update any external dashboards/scripts that hit the relay

**Backup encryption (audit H-09):**
- [x] ~~Generate backup key~~ — DONE 2026-04-10 (`/root/.keys/backup.key`, mode 0600)
- [x] ~~Deploy updated `scripts/backup-wallet-db.sh`~~ — already on droplet
- [ ] Verify encrypted upload — blocked: `data/crankbot.json` doesn't exist post-wipe, backup script skips with "No wallet DB found". Will activate on first `/start`.
- [ ] Test restore — same blocker

**Service user (audit H-08):**
- [ ] Re-provision droplet with updated `scripts/setup-droplet.sh` (creates `crankbot` user)
- [ ] Or manually: `useradd -r -m -s /bin/bash crankbot`, move app + keys + data, `chown -R crankbot:crankbot /home/crankbot`
- [ ] Update PM2 to run as `crankbot`: `pm2 startup systemd -u crankbot --hp /home/crankbot`
- [ ] Verify bot runs as `crankbot` not `root`: `ps aux | grep tsx`

**Local .env cleanup (audit C-03):**
- [x] `WALLET_ENCRYPTION_KEY` no longer needed anywhere (PDA vaults have no encrypted keypairs)
- [ ] Remove `DISCORD_TOKEN` from local `.env` if present

### On-Chain Program Upgrades (Audit Fixes)
Three programs have code fixes that require `anchor build` + `anchor upgrade` to deploy.

**gauge-voter** (audit M-03):
- [ ] Build: `anchor build -p gauge_voter`
- [ ] Upgrade: `anchor upgrade --program-id DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA --provider.cluster mainnet target/deploy/gauge_voter.so`
- Change: owner check on `remaining_accounts` in `vote()` — prevents cross-program account spoofing

**bin-farm** (audit L-03):
- [ ] Build: `anchor build -p bin_farm`
- [ ] Upgrade: `anchor upgrade --program-id 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia --provider.cluster mainnet target/deploy/bin_farm.so`
- Change: `total_positions` decremented on all 3 close paths (close_position, user_close, apply_emergency_close)
- Note: existing counter may be inflated from positions closed before this fix — `saturating_sub` handles gracefully

**merkle-distributor** (audit L-04):
- [ ] Build: `anchor build -p merkle_distributor`
- [ ] Upgrade: `anchor upgrade --program-id DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV --provider.cluster mainnet target/deploy/merkle_distributor.so`
- Change: `update_mint` now requires `old_vault` account with `amount == 0` — prevents stranding funds
- Note: off-chain callers of `update_mint` must now pass the current vault as `old_vault`

**Deployment order:** gauge-voter first (standalone), then bin-farm (test harvest/close after), then merkle-distributor (test epoch after). IDLs should be regenerated after each build: `anchor idl build -p <program>`.

### Harvest & Rover Minimums
- [ ] Harvest minimum — skip harvest tx if pending fees are below threshold (avoid burning gas on dust)
- [x] ~~Rover deposit minimum~~ — DONE (2026-04-09). Replaced `MIN_FEE_ROVER_VALUE` raw-unit threshold with value-based `MIN_FEE_ROVER_USD` (default $10) + adaptive bin width `FEE_ROVER_BIN_USD` (default $0.50 per bin, clamped 5-70). Uses `fetchDexScreenerPrice` in `keeper.ts`. Dust accumulates instead of being deployed to gas-wasteful rovers.

### close_vault — Reclaim Vault Rent
- [ ] Add `close_vault` instruction to bin-farm — reclaim rent from vault accounts when position is fully closed/exhausted

### Gas Model — Remaining
- [x] Auto-claim at epoch: keeper claims for all users via epoch-computer
- [x] Vault reimburses bot via deduct_gas (9 instructions)
- [x] Epoch claims bundled with unwrap — vault pays
- [ ] Minimum vault SOL balance check before harvesting — DM notification if user is dry

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
- [x] ~~Pin critical deps to exact versions~~ — DONE (audit I-09: all deps pinned in package.json)

### Bot Code Dedup
- [ ] Remove inline `withRetry` copies
- [ ] Extract `buildPriorityFeeIxs` to shared module

### Droplet Operations
- [ ] Register external uptime monitor (UptimeRobot) hitting `/api/health`
- [ ] Document recovery runbook

---

## DONE

- [x] **Epoch-computer hardening + test infra (2026-04-08)** — Exported internals, configurable threshold, BN precision fix, dynamic rent, harvest skip logging, claim throttle, lastEpochTimestamp. Created `scripts/test-epoch.ts` (standalone trigger with --dry-run). Created `bot/epoch-computer.test.ts` (27 tests: Merkle proof verification, share computation, hashing). Added `alertEpochMiss` + `alertEpochSuccess` to alerter + keeper. Return type `EpochResult { ran, epoch, amountSol, userCount }`.
- [x] **PDA vault migration (2026-04-08)** — Replaced custodial keypairs with UserVault PDAs. 8 new instructions, 5 modified. Gas model: vault reimburses bot (9 deduct_gas sites). Epoch claims bundled with unwrap. All commands updated. Scripts audited. IDL + Codama regenerated. SBF binary built.
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
- [x] **Security audit executed** — `audit.md` at repo root. 53 findings, 33 remediated.
- [x] Audit C-01: keccak256 fixed — `@noble/hashes` direct dep, sha3-256 fallback removed, startup self-test
- [x] Audit H-02: Priority fee cap — 500K micro-lamports/CU in executor + keeper
- [x] Audit H-03: Epoch crash recovery — staged progress file, resume on restart, vault balance check before drain replay
- [x] Audit H-04: Relay auth — Bearer token gate on all `/api/*` except `/api/health` (needs RELAY_AUTH_TOKEN in .env)
- [x] Audit H-05: WebSocket limit — MAX_WS_CLIENTS=100, rejects with 1013
- [x] Audit H-06: Sybil-resistant epochs — equal distribution fallback removed
- [x] Audit H-07: Silent catches fixed — warn-level logging in executor, relay, epoch-computer
- [ ] ~~Audit H-08: Service user~~ — REVERTED: deploy script back to `root`, `crankbot` user never provisioned
- [x] Audit H-09: Encrypted backups — AES-256-CBC + SHA-256 integrity check (needs backup.key on server)
- [x] Audit M-03: gauge-voter owner check on remaining_accounts (needs program upgrade)
- [x] Audit M-05: Withdraw address — largest depositor wins, threshold raised to 0.01 SOL
- [x] Audit M-06: Wallet DB file permissions — mode 0o600
- [x] Audit M-07: DexScreener deviation guard — rejects >50% price spikes
- [ ] ~~Audit M-08: Secret key buffer zeroing~~ — REVERTED: `Keypair.fromSecretKey` in web3.js 1.98.x shares buffer, `fill(0)` destroyed live keypairs
- [x] Audit M-10: PM2 death alerting — alertProcessDeath + uncaught exception handlers
- [x] Audit M-11: Deterministic Merkle leaf ordering — wallets sorted before tree build
- [x] Audit M-12: gRPC routing — bin-farm Position discriminator check before handlePositionUpdate
- [x] Audit M-13: Key rotation — script auto-updates bot/.env, verification before write
- [x] Audit M-14: Backup integrity — SHA-256 checksum verification after upload
- [x] Audit L-03: total_positions decrement on close (needs program upgrade)
- [x] Audit L-04: update_mint requires old vault drained (needs program upgrade)
- [x] Audit L-07: Sync flush on wallet creation (prevents keypair loss on hard kill)
- [x] Audit L-08: BigInt-native amount conversion in /buy
- [x] Audit L-09: Pyth staleness check — 60s max age
- [x] Audit L-10: Startup byte offset validation — SDK cross-check on first pool
- [x] Audit L-11: Sanitized error messages in /buy — no raw logs to Discord users
- [x] Audit L-12: Keeper 20-hour cooldown — prevents double-fire near midnight
- [x] Audit L-13+L-14: nginx hardened — localhost removed from CORS, security headers added
- [x] Audit L-15: Certbot email registration — ops@crank.money
- [x] Audit L-16: Rotation backup cleanup — keeps latest 3, verifies before write
- [x] Audit I-09: npm deps pinned to exact versions
- [x] Audit I-10: PM2 runs tsx directly (not via npx) — reliable SIGTERM propagation
- [x] **2026-04-02 hotfixes:**
- [x] Reverted M-08 secretKey.fill(0) — was destroying live keypairs (web3.js buffer sharing)
- [x] Fixed deploy.sh — reverted to root user, handle /root vs /home path
- [x] Fixed harvest enrichment — getTransaction retry (3 attempts, 2s delay) for RPC indexing lag
- [x] Fixed position display — "Range is above/below current price" (was "Currently above range")
- [x] Fixed range parser — plain numbers + k/m/b suffixes treated as mcap for mc-display pools
- [x] Fixed epoch-computer — drainVault uses BN not BigInt (Anchor borsh serialization)
- [x] Fixed epoch-computer — crash recovery checks vault balance before replaying drain
- [x] Created PoolGauge PDAs on-chain for SOL and CRANK (add_pool)
- [x] Voted 100% CRANK with bot keypair (64.4M BANK)
- [x] Patched zero-amount harvest records in crankbot.json from on-chain tx data
- [x] Updated /help + /buy + /sell examples to use k suffix (CRANK 15k to 20k)
- [x] Fixed deploy-commands.ts dotenv path (bot/.env not root .env)
- [x] Updated claude.md, audit.md, gtm.md, todo.md
- [x] **2026-04-11 session: Ops cleanup + bug fixes**
- [x] Committed 85 uncommitted files (PDA vault migration, audit, npm patches, epoch computer) — commit `3599816`
- [x] Set PINATA_JWT on droplet — Merkle tree IPFS pinning active
- [x] Set gas_lamports to 125,000 on-chain — users reimburse bot ~$0.01/op at $80 SOL
- [x] Set RELAY_AUTH_TOKEN on droplet — all `/api/*` endpoints locked behind Bearer auth
- [x] Cleared stale `pending_emergency_close` on Config PDA (was `EQzqS7Pg…` from March 29)
- [x] Fixed `/start` command: added missing `wallet` string option to `deploy-commands.ts`
- [x] Fixed `this.botKeypair` → `botKeypair` in `anchor-harvest-bot.ts` — Discord bot was receiving `undefined` for keypair, breaking all on-chain commands (`/start`, `/buy`, etc.)
