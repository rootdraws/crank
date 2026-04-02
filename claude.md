# claude.md — crank.money codebase context

**Limit orders that earn fees. Burn $CRANK, earn SOL.**

crank.money wraps Meteora DLMM positions on Solana. Set your range as a single-sided LP — **sell the rips** or **buy the dips**. If price moves through your range, Crank's Harvester pulls each bin the moment it converts.

Performance fee on converted output only (0.3%). `sweep_rover` splits **40/40/20**: 80% to bridge_vault (SOL holding tank for daily distribution), 20% to `Config.bot` (operations). Hardcoded on-chain. Revenue distribution via daily Merkle tree — epoch-computer drains vault, wraps WSOL, funds distributor, auto-claims to user custody wallets. BANK holders vote on pool weights via gauge-voter.

**Interface:** Discord bot (Telegram adapter planned). Users type `/buy GSD 900kmc to 1.1mmc SOL 10` — bot maps tickers to curated pools, converts mcap/price to bin ranges, routes to best DLMM pool by bin step, opens positions. Community doc pages per subdomain (e.g. `gsd.crank.money`).

## Architecture

Five active on-chain programs:

- **bin-farm** (core) — Position management (open, harvest, close, claim fees) + rover system. All CPI via V2 variants (Token-2022 native). 40/40/20 fee split in `sweep_rover`. Permissionless fallback on all operations (heartbeat + staleness pattern, `keeper_tip_bps`). Side derived on-chain from `active_id`.
- **bank-mint** — Burn $CRANK → mint $BANK 1:1. Supply cap: `bank_supply + crank_supply <= 2B`. BankConfig PDA is sole mint authority.
- **gauge-voter** — Global-state pair weight voting. One gauge per trading pair (not per bin step). BANK holders blend weights via `vote()`. Admin registers pairs via `add_pool` using a representative LbPair address. Max 32 pairs. Votes stick permanently. Epoch-computer aggregates fees across all bin step pools for a pair, distributes trader 40% by gauge weight.
- **merkle-distributor** — Cumulative SOL (WSOL) distribution via Merkle proofs. Daily epoch. IPFS-pinned trees. `claim()` is permissionless (payer != claimant). Auto-claimed by keeper. Supports ~1M leaves.
- **epoch-vault** (was pegged-bridge) — SOL fee accumulator. Receives 80% from sweep_rover via `bridge_vault` PDA. `drain_vault` lets authority withdraw for distribution. Same program ID `7oHSUP...`.

## Key instructions

```
open_position_v2(pool, amount, min_bin, max_bin, side, max_active_bin_slippage)
  → No fee. 100% deposited. Side derived on-chain from active_id.

harvest_bins(bin_ids: Vec<i32>)
  → Fees → rover_authority → sweep_rover → 40/40/20.
  → Remainder → owner. Permissionless fallback.

close_position() / user_close()
  → Same fee mechanic. Meteora position closed, rent refunded.

sweep_rover()
  → Permissionless. SOL → 80% bridge_vault + 20% Config.bot.
  → (trader_dest now also points to bridge_vault)

burn_and_mint(amount)  [bank_mint]
  → Burn $CRANK, mint $BANK 1:1. Supply cap enforced.

vote(desired_allocations)  [gauge_voter]
  → Blend global pool weights. No per-user state.

add_pool(lb_pair)  [gauge_voter]
  → Admin curates tradeable pools.

new_epoch(root, ipfs_cid, amount)  [merkle_distributor]
  → Bot uploads Merkle root + funds vault. Daily.

claim(index, cumulative_amount, proof)  [merkle_distributor]
  → Claim accumulated SOL (WSOL). Auto-claimed by keeper daily.

drain_vault(amount)  [epoch_vault]
  → Authority drains SOL from bridge_vault for distribution.
```

## Bin detection logic

```
SELL THE RIPS (token deposited above price → SOL output):
  Safe bins = bins where binId < activeId (price ripped above them)

BUY THE DIPS (SOL deposited below price → token output):
  Safe bins = bins where binId > activeId (price dipped below them)
```

## File map

```
programs/
  bank-mint/src/lib.rs           — Burn $CRANK → mint $BANK 1:1
  bin-farm/src/
    lib.rs                       — Core: positions, harvest, close, rovers, 40/40/20 split
    meteora_dlmm_cpi.rs          — CPI module (V2 only)
  gauge-voter/src/lib.rs         — Pool weight voting + pool curation
  merkle-distributor/src/lib.rs  — Cumulative SOL (WSOL) Merkle claims + IPFS CID
  epoch-vault/src/lib.rs         — SOL fee accumulator + drain_vault instruction

bot/
  anchor-harvest-bot.ts          — Orchestrator, health server :8080, graceful shutdown
  geyser-subscriber.ts           — Helius LaserStream gRPC, raw LbPair byte parsing,
                                   position registry, persistent cache, auto-reconnect
  harvest-executor.ts            — Job queue, Token-2022 aware, dedup, max 5 concurrent
  keeper.ts                      — Daily fee sequencer (5 steps: close WSOL → sweep →
                                   epoch distribution → fee rovers → close exhausted)
  epoch-computer.ts              — Daily SOL distribution: drain vault → WSOL → Merkle → auto-claim
  relay-server.ts                — REST API + WebSocket relay (stats, pools, positions,
                                   fees, rovers, PnL, feed)
  meteora-accounts.ts            — Shared Meteora CPI account resolution + DLMM cache
  logger.ts                      — pino logger
  retry.ts                       — Shared withRetry (exponential backoff)
  alerter.ts                     — Discord feed channel alerts (gRPC, low balance, keeper failures, sync)
  price-syncer.ts                — Price divergence detection + arb bot (disabled, pending direct Meteora swap)
  bot.test.ts                    — Unit tests (vitest): bin detection, byte parsing, dedup
  ecosystem.config.cjs           — PM2 config (512MB, auto-restart)
  idl/                           — Anchor IDL JSON files (bin_farm, merkle_distributor, epoch_vault, etc.)
  claude-bot.md                  — Bot folder context doc

public/                          — On-chain referenced assets only
  crank-token.png                — $CRANK token logo
  pegged-logo.png                — $PEGGED token logo
  pegged-metadata.json           — $PEGGED off-chain metadata JSON

scripts/
  deploy.sh                      — Rsync + npm install + PM2 restart + health check (pre-deploy wallet DB backup)
  setup-droplet.sh               — One-time server provisioning (fail2ban, unattended-upgrades, SSH hardening, PM2 log rotation)
  rotate-encryption-key.ts       — Wallet encryption key rotation (decrypt/re-encrypt all custody keypairs)
  backup-wallet-db.sh            — Per-minute wallet DB backup to DO Spaces (cron)
  fee-dashboard.ts               — Query fee pipeline checkpoints
  preflight-check.ts             — Verify all programs + PDAs on-chain
  generate-clients.mjs           — Codama client generation from IDL
  recycle-fee-rover.ts           — Manual fee rover opener
  update-pegged-metadata.ts      — Set $PEGGED logo/URI on-chain
  close-wsol.ts                  — Close WSOL ATA + return SOL for a custody wallet
  reclaim-atas.ts                — Close empty token accounts + reclaim rent

packages/
  core-sdk/                      — Shared SDK for chat bot
    claude-core-sdk.md           — Core SDK context doc
    constants.ts                 — All program IDs, mints, layout offsets (SOURCE OF TRUTH)
    pda.ts                       — All PDA derivation (5 programs + Meteora + Metaplex)
    math.ts                      — binToPrice, priceToBin, percentRangeToBins, formatPrice
    pool-config.ts               — PoolConfig type + loadPoolRegistry() from curator.json
    range-parser.ts              — Price/mcap/pct range parsing + command string parser
    pool-router.ts               — Multi-pool routing with auto-split, quoteTokenUsdPrice conversion
    price-source.ts              — DexScreener price fetching with 10s per-mint cache
    wallet-service.ts            — Custodial keypair mgmt (AES-256-GCM), position/vote/harvest tracking, withdraw address lock
    signer.ts                    — Custodial tx signing (keypair-based)
    meteora.ts                   — Meteora pool resolution helpers
    transactions.ts              — Transaction building utilities
  discord-bot/                   — Discord slash command bot
    claude-discord.md            — Discord bot context doc
    src/index.ts                 — DiscordBot class, wires commands, standalone + embedded modes
    src/notifier.ts              — DM + feed channel notifications on harvest/close events
    src/formatter.ts             — Message formatting (pools grouped by pair, ASCII fill bars)
    src/deploy-commands.ts       — Register slash commands with Discord API
    src/commands/                 — 12 handlers: start, balance, deposit, buy, sell,
                                   positions, close, withdraw, pools, vote, burn, help
    src/deposit-detect.ts        — Auto-lock first SOL depositor as withdraw address

deploy/nginx/
  bot.crank.money.conf           — Production nginx (SSL + WebSocket + CORS + rate limiting)

security.md                      — Security hardening checklist (completed 2026-03-29)

curator.json                     — Pool registry (ticker → pool address + config, read by bot)
pool-info.json                   — Sanctum stake pool static addresses
Anchor.toml                      — 5 programs, mainnet cluster
todo.md                          — Living task list
```

## PDA seeds

| PDA | Seeds | Program |
|-----|-------|---------|
| Config | `[b"config"]` | bin-farm |
| Position | `[b"position", meteora_position.key()]` | bin-farm |
| Vault | `[b"vault", meteora_position.key()]` | bin-farm |
| RoverAuthority | `[b"rover_authority"]` | bin-farm |
| BankConfig | `[b"bank_config"]` | bank-mint |
| GaugeConfig | `[b"gauge_config"]` | gauge-voter |
| PoolGauge | `[b"pool_gauge", lb_pair.key()]` | gauge-voter |
| Distributor | `[b"distributor"]` | merkle-distributor |
| ClaimStatus | `[b"claim_status", distributor.key(), claimant.key()]` | merkle-distributor |
| BridgeConfig | `[b"bridge_config"]` | epoch-vault |
| BridgeVault | `[b"bridge_vault"]` | epoch-vault |

## Program IDs

| Program | ID |
|---------|------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| bank-mint | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` |
| gauge-voter | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` |
| merkle-distributor | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` |
| epoch-vault | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` |

## Token addresses

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |

## Key PDAs (live)

| PDA | Address | Program |
|-----|---------|---------|
| Core Config | `MeTGCG86PTWhnN52yV9ie8oJkgfSLGyuRCFxhDd97i2` | bin-farm |
| RoverAuthority | `56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR` | bin-farm |
| Trader Dest | `B9gTfeCbN1oSXKCKgog5gGTH3VGNr3U5SYH4mL3gtqxK` | (= bridge_vault, on RoverAuthority) |
| BankConfig | `HxvvyJtscUTmUhkvz6D5gidGEfmatuSmFgcxxRzexwKF` | bank-mint |
| GaugeConfig | `AqdJmiDvUj6DWKt48QCMEqWSnh2a2qjExidhbrMw9z17` | gauge-voter |
| Distributor | `Hwra7Rz8ZfBVuJYqyGz5PL9Bj21jSvw2qbxkg2uoE7xQ` | merkle-distributor |
| Distributor Vault | `Fr3ntupQJRsYzTAVzNerd7zQ7QHkwKtaE5fjPVx21ZSw` | ATA (WSOL) |
| BridgeVault | `B9gTfeCbN1oSXKCKgog5gGTH3VGNr3U5SYH4mL3gtqxK` | epoch-vault |

## Fee flow

```
harvest/close → 0.3% fee → rover_authority ATAs
  SOL fees: WSOL ATA → close_rover_token_account (unwrap) → sweep_rover
  Token fees: rover ATA → open_fee_rover (BidAskImBalanced DLMM) → natural conversion → SOL

sweep_rover splits 40/40/20:
  80% → bridge_vault (both revenue_dest + trader_dest point here)
  20% → Config.bot (self-funding operations)

Daily epoch-computer:
  drain_vault → wrap SOL to WSOL → fund Merkle distributor → auto-claim for all users
```

## Build

Anchor 0.31.1, Solana CLI 3.0+. `blake3` pinned to 1.5.5 (Rust 1.84 BPF compat).

```bash
anchor build                              # All 5 programs
anchor idl build -p bin_farm              # IDL generation (repeat for each program)
node scripts/generate-clients.mjs         # Codama TypeScript clients
```

**Run bot:** `npm run bot` (tsx, loads env from `bot/.env`).

**Testing:** `npx vitest run` (unit tests), `npx tsx scripts/fee-dashboard.ts` (fee pipeline snapshot).

## Implementation notes

**Do not remove `Box<>` wrappers** on `InterfaceAccount` / `Account` fields in bin-farm. BPF 4KB stack frame overflow without them.

**Rover remaining_accounts (2).** `open_rover_position` and `open_fee_rover` pass `event_authority` + `dlmm_program` via remaining_accounts (BPF stack constraint).

**Fee rover CU budget: 1M.** `open_fee_rover` uses 1M compute units (BidAskImBalanced across 69 bins). All other operations stay at 400K.

**`bitmap_ext` is NOT `#[account(mut)]`.** DLMM program ID placeholder is executable and can't be writable. CPI module uses `bitmap_meta()` helper.

**All Meteora CPI is V2.** No V1 code remains.

**Token-2022 fully supported.** All 14 outbound transfers use `transfer_checked` from `token_interface`. Decimals read at byte offset 44.

**Mcap-to-bin conversion for non-USD quote pools.** `rangeInputToPrice()` returns USD prices (`mcap / supply`). `priceToBin()` expects DLMM-native prices. For SOL-quoted pools (CRANK/SOL), `routeCommand()` divides by `quoteTokenUsdPrice` (fetched from DexScreener) to convert USD → SOL-denominated before bin calculation. Without this, bins land on the wrong side of `activeId` and the on-chain program picks the wrong token program.

**Setup tx CU budget: 800K for bin array init.** Meteora `initializeBinArray` on wide-step pools (binStep 80) exceeds the default 200K CU limit. `buildSetupTx()` auto-detects DLMM instructions and bumps to 800K.

**Yellowstone gRPC v5:** Requires explicit `await client.connect()` before `client.subscribe()`.

**Sanctum SPL Stake Pool — RETIRED.** $PEGGED killed 2026-04-01. Pool exists on-chain but is no longer used. Revenue distributed as SOL directly via Merkle distributor.

**`binIdToBinArrayIndex` uses `Math.trunc` not `Math.floor`.** For negative bin IDs, `Math.floor` rounds toward negative infinity but Meteora's SDK truncates toward zero then subtracts 1 if remainder is non-zero. The off-by-one caused bin array PDAs to mismatch what the on-chain program expected. Fixed in `pda.ts`.

**Gas offloading (two-signer).** Harvest executor uses two signers: `botKeypair` signs as the `bot` account (authorized bot path — no keeper tip, no remaining_accounts), `userKeypair` is fee payer (user pays gas). Falls back to bot-only if owner isn't a custody user. Previous approach (user-as-sole-signer) was broken — on-chain saw `bot != config.bot` → permissionless path → MissingKeeperAta error.

**Harvest enrichment via `getTransaction`.** After harvest/close, executor calls `getTransaction(txSig)` and reads `preTokenBalances`/`postTokenBalances` from the confirmed transaction metadata. Computes deltas per owner per mint. No timing issues (data comes from the validator, not stale RPC reads).

**WSOL auto-unwrap.** `/balance` closes any WSOL ATA before displaying (user pays). Executor also unwraps WSOL after harvest/close using the user's keypair. `/buy` appends a close WSOL ATA instruction to the open_position tx and auto-unwraps on failure.

**SOL price from Pyth oracle.** `fetchDexScreenerPrice(SOL_MINT)` uses Pyth Hermes API (`hermes.pyth.network`) instead of DexScreener. Eliminates FOGO contamination where DexScreener labels FOGO pairs with `baseToken.address = SOL mint` but returns FOGO's price ($0.01) instead of SOL's ($81). For non-SOL tokens, DexScreener is used with stablecoin-pair preference + symbol consensus filtering.

**Token-2022 transfer hooks unsupported — defense-in-depth guards in place.** bin-farm passes `RemainingAccountsInfo::empty_hooks()` to all Meteora CPI. Tokens with transfer hooks will fail at CPI level, locking ~0.06 SOL rent per position. Guards: (1) curator.json mint whitelist in `open_fee_rovers`, (2) `hasTransferHook()` detection in keeper + `/buy` + `/sell` — rejects Token-2022 mints with hook extensions. Full hook resolution would need a bin-farm program upgrade.

**Safety poll interval: 30 seconds.** Fallback for pools with low gRPC activity (e.g. CRANK/SOL where arb bots fire in bursts). Primary detection is still gRPC sub-second for active pools.

**Sell command auto-resolves quote token.** `/sell CRANK 25kmc to 30kmc 4000000 CRANK` detects token==quote and resolves actual quote from pool registry.

**`/withdraw` dashboard + execute.** Bare `/withdraw` shows balances + withdraw wallet + examples. `/withdraw SOL .5` or `/withdraw CRANK all` executes. No address param — sends to auto-detected deposit wallet.

**`/close` dashboard + execute.** Bare `/close` shows positions with IDs + fill bars. `/close <id>` closes one. `/close all` rage quits everything.

**$BANK metadata not yet registered.** Needs Metaplex token metadata: name, symbol, image, off-chain JSON.

## DigitalOcean / Bot deployment

**Droplet:** NYC1, s-2vcpu-4gb, Ubuntu 22.04 (+ 1GB swap)
**Domain:** `bot.crank.money` (A record on Vercel DNS)
**SSL:** Let's Encrypt via certbot (auto-renewing)

```
/root/crank-money/           — App code (rsynced)
/root/crank-money/bot/.env   — Bot environment (persists across deploys)
/root/.keys/bot-keypair.json — Bot wallet keypair (chmod 600)
```

```bash
./scripts/deploy.sh              # Deploy (reads DROPLET_IP from env or defaults)
pm2 logs crank-harvester --lines 50
curl http://localhost:8080/api/stats
```

**Bot security:** The bot keypair is the deployer/admin. Holds authority for all programs + SPL stake pool manager + Config.bot fee recipient (20%). Keypair separation planned (see todo.md).

## Relay endpoints

All served via `https://bot.crank.money`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Returns 200/503 — gRPC connected, balance, last harvest/keeper timestamps |
| `GET /api/stats` | Bot health, gRPC status, position count, harvest totals, queue depth |
| `GET /api/pools` | Watched pools with activeId, binStep, mints |
| `GET /api/pools/:address` | Single pool details |
| `GET /api/positions` | Tracked positions with fill % |
| `GET /api/pending-harvests` | Positions with harvestable bins |
| `GET /api/bot-wallet` | Balance, spend rate, estimated hours remaining |
| `GET /api/fees` | Fee pipeline state (rover, bridge vault, distributor) |
| `GET /api/rovers` | Rover positions by TVL |
| `GET /api/rovers/top5` | Top 5 rovers |
| `GET /api/feed` | Last 50 activity feed events |
| `GET /api/protocol-pnl` | Win rate, net PnL, per-pool breakdown, rover portfolio |
| `GET /api/syncer` | Price syncer stats: divergence %, activeId, change history, profit tracking |
| `WSS /ws` | Real-time: activeBinChanged, harvestNeeded, harvestExecuted, positionClosed, roverTvlUpdated, syncExecuted, divergenceDetected, feedHistory |

## Adding a new token/pool

Four things must be updated when listing a new community pair (e.g. GSD/SOL):

**1. On-chain: `add_pool` on gauge-voter**
Admin calls `add_pool(lb_pair)` with ONE representative LbPair address for the pair. This creates the PoolGauge PDA that holds the pair's vote weight. One gauge per pair — bin step pools are a routing detail, not a governance concept. Must be signed by the gauge-voter authority.

**2. `curator.json` — gauges section**
Add the pair to `"gauges"`: `"GSD": "<the same LbPair address registered on-chain>"`. This is how `/vote GSD 50` resolves to the on-chain PoolGauge. The gauge address doesn't need to be the pool users trade on — it's just the on-chain anchor for the pair's weight.

**3. `curator.json` — pools section**
Add one or more pool entries for routing (one per bin step you want to support): `id`, `label`, `address` (Meteora LbPair), `binStep`, `tokenX`/`tokenY`, `mintX`/`mintY`, `decimalsX`/`decimalsY`, `displayMode` (`price` or `mc`), `supply` (required for `mc` mode), `splitStrategy`, `maxRangePct`, `buyToken`/`quoteToken`, `example`. The router tries all pools for the pair and picks the best fit for the user's range.

**4. `KNOWN_TOKENS` in `packages/core-sdk/constants.ts`**
Add `mint_address: 'SYMBOL'`. Used by `/balance` and `/withdraw` for display. Without this, the token shows as a truncated address.

**5. Update LaserStream subscription** to watch the new LbPair address(es). Without this, the harvester won't detect bin conversions on the new pool.

**Verification checklist before adding:**
- LbPair address verified on-chain (not from frontend display)
- `binStep` read from on-chain account (offset 80, u16 LE)
- `decimalsX`/`decimalsY` read from respective mint accounts
- `mintX`/`mintY` are actual mints (not wrapped versions)
- For `mc` mode: `supply` verified against on-chain `mint.supply / 10^decimals` — write it manually, never auto-fetch. Tokens can have burned supply, minted more post-launch, or non-standard totals (CRANK is 1.9B, not 1B)
- `maxRangePct` computed: `((1 + binStep/10000)^70 - 1) * 100`
- Pool has been live >48h (new pools can have thin liquidity)

**After updating:**
- Clear pool cache or restart bot (pool registry is cached in memory)
- The pool router will automatically include the new pools in routing decisions
- Users can immediately `/buy`, `/sell`, and `/vote` using the new token symbol
- The epoch-computer aggregates fees across all bin step pools for the pair

**Removing a pool:** Remove from curator.json + LaserStream subscription. Existing open positions continue to be monitored and harvested. New positions cannot be opened on removed pools.

## Security rules

**NEVER print secrets in chat.** Generate keys directly on the server via SSH. Pipe output into files, don't read it back. Discord tokens, encryption keys, private keys — none of these should appear in conversation.

**NEVER deploy without verifying `data/` is excluded from rsync.** The wallet DB (`data/crankbot.json`) contains encrypted custodial keypairs. Deletion = permanent fund loss.

**Custody wallet architecture:** Each Discord user gets an AES-256-GCM encrypted keypair stored in `data/crankbot.json`. Encryption key backed up to `/root/.keys/wallet.key` (chmod 600) + password manager. Wallet DB backed up per-minute to DO Spaces (`s3://crank-backups`). Withdraw address auto-locked to the first wallet that deposits SOL (detected from tx history, write-once).

## Current state (2026-04-01)

- **Discord bot live** — `crankbot#8555`, 12 slash commands, feed channel `#crank-feed`
- **Harvester running** — gRPC connected, daily keeper sequence (5 steps), relay on :8080
- **Droplet** — s-2vcpu-4gb NYC1, 1GB swap, fail2ban, SSH key-only, UFW, nginx rate limiting
- **$PEGGED killed** — all holdings unstaked, ATAs closed, code gutted. Revenue distributed as SOL.
- **epoch-vault program deployed** — (was pegged-bridge, same ID). `drain_vault` instruction live.
- **merkle-distributor upgraded** — `update_mint` added, mint set to WSOL on-chain.
- **trader_dest = bridge_vault** — both 80% fee shares accumulate in one PDA.
- **epoch-computer built** — `bot/epoch-computer.ts`, wired into keeper daily sequence. Needs end-to-end test.
- **Withdraw address auto-detection** — first SOL depositor locked as withdraw wallet (`deposit-detect.ts`)
- **`/withdraw` dashboard** — bare shows balances + withdraw wallet + examples
- **`/close` dashboard** — bare shows positions with IDs, `/close all` rage quits
- **Gas offloading live** — two-signer: bot=authorized bot, user=fee payer
- **WSOL auto-unwrap** — `/balance` unwraps, executor unwraps after harvest/close
- **Price syncer deployed (disabled)** — detection works, swap execution needs direct Meteora DLMM instructions
- **SOL price from Pyth** — `fetchDexScreenerPrice(SOL)` uses Pyth Hermes, not DexScreener. Eliminates FOGO contamination.
- **DexScreener hardened** — stablecoin pair preference + symbol consensus filter for non-SOL tokens

## Known issues

- **Epoch-computer untested** — code exists in `bot/epoch-computer.ts` but has never run a real epoch. Needs `@noble/hashes` for correct keccak256 (currently falls back to sha3-256 which won't match on-chain). Needs end-to-end test with real SOL.
- **Token-2022 transfer hooks unsupported** — V2 CPI but hook extra accounts not resolved. Defense-in-depth guards reject hook-bearing tokens.
- **No arb on CRANK/SOL DLMM pool** — price syncer detection works but swap execution needs direct Meteora DLMM instructions.
- **Keypair separation pending** — single keypair controls everything. Needs fresh Ledger for cold admin.
- **$BANK metadata missing** — no logo, no URI, looks like scam token in wallets.

## Program audit notes (reviewed 2026-04-01)

**epoch-vault** (`programs/epoch-vault/src/lib.rs`) — Clean. `drain_vault` does direct lamport manipulation on the PDA (no CPI needed since vault is system-owned). The `vault_bump` is stored on config but never used in `drain_vault` — not a bug (lamport manipulation doesn't need PDA signing, only CPI invoke_signed does). `destination` is unchecked — authority-gated so only the bot can drain, but it can drain to ANY address. This is intentional (bot drains to itself for WSOL wrapping).

**merkle-distributor** (`programs/merkle-distributor/src/lib.rs`) — Clean. `update_mint` added correctly — authority-gated, validates new vault ATA is owned by distributor PDA and denominated in new mint. Mint changed to WSOL on-chain (verified). The `claim()` instruction uses `transfer_checked` via `token_interface` so it works with both SPL Token and Token-2022. Cumulative accounting is sound — delta computed from `cumulative_amount - claim_status.cumulative_claimed`.

**gauge-voter** (`programs/gauge-voter/src/lib.rs`) — Solid. The ppb (parts-per-billion) math avoids overflow with u128 intermediates. Rounding dust correction on first pool is correct. Flash-loan voting is acknowledged and accepted in comments. One note: `remove_pool` closes the PoolGauge account but does NOT redistribute the removed weight to remaining pools — the weight just disappears, shrinking total below 10000 bps. Self-heals on the next `vote()` call (rounding correction forces sum back to 10000). The epoch-computer should normalize by actual sum when reading gauge weights, not assume 10000.

**bank-mint** (`programs/bank-mint/src/lib.rs`) — Clean. Supply cap invariant `bank_supply + crank_supply <= 2B` is checked on every burn_and_mint. Uses `token_interface` so both SPL Token and Token-2022 work. The PDA is sole mint authority — verified at `initialize`.

**bin-farm** (`programs/bin-farm/src/lib.rs`) — The big one (3054 lines). `sweep_rover` 40/40/20 split is hardcoded and correct. `trader_dest` constraint validates against `rover_authority.trader_dest` — now points to `bridge_vault`, verified on-chain. The keeper's `crankSweepRover` reads RoverAuthority to get the current addresses, so it should pass the right accounts after restart. The `InvalidTraderDest` error from the transition was transient — `set_trader_dest` was called mid-keeper-cycle. The keeper reads RoverAuthority fresh each tick (no cache), so the next daily tick will pass the correct bridge_vault address.

**Cross-program note:** Both `revenue_dest` AND `trader_dest` now point to `bridge_vault` (`B9gTfe...`). sweep_rover sends 40% + 40% = 80% to the same account. This is fine — the lamport additions are sequential in the same instruction, no race condition. The remaining 20% goes to `Config.bot`.

## Next session priorities

See `todo.md` NEXT SESSION section for detailed resume notes. Key priorities:

1. **Epoch-computer end-to-end test** — install `@noble/hashes`, trigger test epoch, verify full pipeline
2. **Verify sweep_rover with new trader_dest** — keeper logged `InvalidTraderDest` during transition, should resolve after restart
3. **Remaining doc cleanup** — claude-bot.md, claude-discord.md, claude-core-sdk.md still have stale PEGGED refs
