# claude.md — crank.money codebase context

**Limit orders that earn fees. Burn $CRANK, earn $PEGGED.**

crank.money wraps Meteora DLMM positions on Solana. Set your range as a single-sided LP — **sell the rips** or **buy the dips**. If price moves through your range, Crank's Harvester pulls each bin the moment it converts.

Performance fee on converted output only (0.3%). `sweep_rover` splits **40/40/20**: 40% to bridge_vault (→ staked via SPL stake pool → $PEGGED for BANK holders), 40% to trader_dest (→ $PEGGED for traders via gauge-weighted distribution), 20% to `Config.bot` (operations). Hardcoded on-chain. Revenue distribution via daily Merkle tree at 4:20 PM CST — unified tree combining both holder and trader shares. BANK holders vote on pool weights via gauge-voter (global-state mutation, votes stick permanently).

**Direction:** Pivoting from web frontend to Telegram/Discord bot. Users type `/buy GSD 900kmc to 1.1mmc SOL 10` — bot maps tickers to curated pools (via gauge-voter `add_pool`), converts mcap/price to bin ranges, opens positions. Community doc pages per subdomain (e.g. `gsd.crank.money`).

## Architecture

Five active on-chain programs:

- **bin-farm** (core) — Position management (open, harvest, close, claim fees) + rover system. All CPI via V2 variants (Token-2022 native). 40/40/20 fee split in `sweep_rover`. Permissionless fallback on all operations (heartbeat + staleness pattern, `keeper_tip_bps`). Side derived on-chain from `active_id`.
- **bank-mint** — Burn $CRANK → mint $BANK 1:1. Supply cap: `bank_supply + crank_supply <= 2B`. BankConfig PDA is sole mint authority.
- **gauge-voter** — Global-state pool weight voting. BANK holders blend weights via `vote()`. Admin curates pools via `add_pool`. Max 32 pools. Votes stick permanently. Also serves as the ticker → pool registry for the Telegram bot.
- **merkle-distributor** — Cumulative $PEGGED distribution via Merkle proofs. Daily epoch. IPFS-pinned trees. `claim()` is permissionless (payer != claimant). Supports ~1M leaves.
- **pegged-bridge** — SOL → Sanctum SPL stake pool (Helius + LP Army + MonkeDAO validators) → $PEGGED → Merkle distributor vault. Single permissionless `stake_and_forward` crank.

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
  → Permissionless. SOL → 40% bridge_vault + 40% trader_dest + 20% Config.bot.

stake_and_forward()  [pegged_bridge]
  → Permissionless. bridge_vault SOL → SPL stake pool → $PEGGED → Merkle vault.

burn_and_mint(amount)  [bank_mint]
  → Burn $CRANK, mint $BANK 1:1. Supply cap enforced.

vote(desired_allocations)  [gauge_voter]
  → Blend global pool weights. No per-user state.

add_pool(lb_pair)  [gauge_voter]
  → Admin curates tradeable pools.

new_epoch(root, ipfs_cid, amount)  [merkle_distributor]
  → Bot uploads Merkle root + funds vault. Daily.

claim(index, cumulative_amount, proof)  [merkle_distributor]
  → Claim accumulated $PEGGED. Cumulative accounting.
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
  merkle-distributor/src/lib.rs  — Cumulative $PEGGED Merkle claims + IPFS CID
  pegged-bridge/src/lib.rs       — SOL → SPL stake pool → $PEGGED → Merkle vault

bot/
  anchor-harvest-bot.ts          — Orchestrator, health server :8080, graceful shutdown
  geyser-subscriber.ts           — Helius LaserStream gRPC, raw LbPair byte parsing,
                                   position registry, persistent cache, auto-reconnect
  harvest-executor.ts            — Job queue, Token-2022 aware, dedup, max 5 concurrent
  keeper.ts                      — Daily fee sequencer (6 steps: close WSOL → sweep →
                                   stake_and_forward → fee rovers → new_epoch → close exhausted)
  relay-server.ts                — REST API + WebSocket relay (stats, pools, positions,
                                   fees, rovers, PnL, feed)
  meteora-accounts.ts            — Shared Meteora CPI account resolution + DLMM cache
  logger.ts                      — pino logger
  retry.ts                       — Shared withRetry (exponential backoff)
  bot.test.ts                    — Unit tests (vitest): bin detection, byte parsing, dedup
  ecosystem.config.cjs           — PM2 config (512MB, auto-restart)
  idl/                           — Anchor IDL JSON files (5 programs)
  claude-bot.md                  — Bot folder documentation

public/                          — On-chain referenced assets only
  crank-token.png                — $CRANK token logo
  pegged-logo.png                — $PEGGED token logo
  pegged-metadata.json           — $PEGGED off-chain metadata JSON

scripts/
  deploy.sh                      — Rsync + npm install + PM2 restart + health check
  setup-droplet.sh               — One-time server provisioning
  fee-dashboard.ts               — Query fee pipeline checkpoints
  preflight-check.ts             — Verify all programs + PDAs on-chain
  generate-clients.mjs           — Codama client generation from IDL
  recycle-fee-rover.ts           — Manual fee rover opener
  update-pegged-metadata.ts      — Set $PEGGED logo/URI on-chain

packages/
  core-sdk/                      — Shared SDK for chat bot
    constants.ts                 — All program IDs, mints, layout offsets (SOURCE OF TRUTH)
    pda.ts                       — All PDA derivation (bin-farm, Meteora, Metaplex)
    math.ts                      — binToPrice, priceToBin, percentRangeToBins, formatPrice
    wallet-service.ts            — Custodial keypair mgmt (AES-256-GCM), position/vote/harvest tracking
    signer.ts                    — Custodial tx signing (keypair-based, replaces Phantom)
    meteora.ts                   — Meteora pool resolution helpers
    transactions.ts              — Transaction building utilities
  discord-bot/                   — Discord slash command bot
    src/index.ts                 — DiscordBot class, wires commands, standalone + embedded modes
    src/parse-range.ts           — Range parser: "SOL 84 to 74 1000 USDC" → structured data
    src/notifier.ts              — DM + feed channel notifications on harvest/close events
    src/formatter.ts             — Message formatting
    src/deploy-commands.ts       — Register slash commands with Discord API
    src/commands/                 — 13 handlers: start, balance, deposit, buy, sell,
                                   positions, close, withdraw, pools, vote, burn, claim, help
  docs/                          — Design docs from crankclank (architecture, pool-routing,
                                   curator guide, migration plan, minimalist spec)
  WIRING.md                      — Discord bot integration pattern for anchor-harvest-bot.ts

deploy/nginx/
  bot.crank.money.conf           — Production nginx (SSL + WebSocket + CORS)

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
| BridgeConfig | `[b"bridge_config"]` | pegged-bridge |
| BridgeVault | `[b"bridge_vault"]` | pegged-bridge |

## Program IDs

| Program | ID |
|---------|------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| bank-mint | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` |
| gauge-voter | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` |
| merkle-distributor | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` |
| pegged-bridge | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` |

## Token addresses

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |
| $PEGGED (crankSOL) | `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1` | 9 |

## Key PDAs (live)

| PDA | Address | Program |
|-----|---------|---------|
| Core Config | `MeTGCG86PTWhnN52yV9ie8oJkgfSLGyuRCFxhDd97i2` | bin-farm |
| RoverAuthority | `56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR` | bin-farm |
| Trader Dest | `FFwqCuYTw7DFWWRQD3tYcPBPpmaAQjT1JV5kqG15QPsL` | (on RoverAuthority) |
| BankConfig | `HxvvyJtscUTmUhkvz6D5gidGEfmatuSmFgcxxRzexwKF` | bank-mint |
| GaugeConfig | `AqdJmiDvUj6DWKt48QCMEqWSnh2a2qjExidhbrMw9z17` | gauge-voter |
| Distributor | `Hwra7Rz8ZfBVuJYqyGz5PL9Bj21jSvw2qbxkg2uoE7xQ` | merkle-distributor |
| Distributor Vault | `52MUiETNoF6YmBGA6LNfrAdTdkJDmCR95arg7wntZzwB` | ATA ($PEGGED) |
| BridgeVault | `B9gTfeCbN1oSXKCKgog5gGTH3VGNr3U5SYH4mL3gtqxK` | pegged-bridge |
| SPL Stake Pool | `9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg` | Sanctum |
| Stake Pool Withdraw Auth | `AnmuhSsKondKVDAWTLc57joeMA7K6vHNNxrnLkjyTJLJ` | (mint auth for $PEGGED) |

## Fee flow

```
harvest/close → 0.3% fee → rover_authority ATAs
  SOL fees: WSOL ATA → close_rover_token_account (unwrap) → sweep_rover
  Token fees: rover ATA → open_fee_rover (BidAskImBalanced DLMM) → natural conversion → SOL

sweep_rover splits 40/40/20:
  40% → bridge_vault → stake_and_forward → $PEGGED → Merkle distributor vault (BANK holders)
  40% → trader_dest → stake → $PEGGED → Merkle distributor vault (traders, gauge-weighted)
  20% → Config.bot (self-funding operations)

Daily epoch at 4:20 PM CST: unified Merkle tree, IPFS pinned.
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

**Yellowstone gRPC v5:** Requires explicit `await client.connect()` before `client.subscribe()`.

**Sanctum SPL Stake Pool epoch updates.** Required before every `stake_and_forward` (error `0x11 = StakeListAndPoolOutOfDate` otherwise). Both instructions fully permissionless. Keeper calls `updateSanctumPool()` automatically.

- **UpdateValidatorListBalance (variant 6):** Data = `[6, start_index: u32 LE, no_merge: bool]` (6 bytes).
- **UpdateStakePoolBalance (variant 7):** Data = `[7]` (1 byte). Must run after variant 6.
- **ValidatorStakeInfo:** 73 bytes per entry. Status 2 = ReadyForRemoval (skip).
- **ValidatorList:** Header 5 bytes, entries start at offset 9.
- **PDA seeds:** Validator stake = `[vote_account, stake_pool]` (no prefix if suffix == 0). Transient = `[b"transient", vote_account, stake_pool, seed_u64_le]`. Withdraw auth = `[stake_pool, b"withdraw"]`.
- **StakePool offsets:** `validator_list`@98, `reserve_stake`@130, `pool_mint`@162, `manager_fee_account`@194, `token_program_id`@226.

**$PEGGED on-chain metadata.** name=`crankSOL`, symbol=`PEGGED`. Metadata PDA: `4jAz3CwfR9MPNsagtUDoah3AZ3v1Lr1SB7BZVx3LjySc`. Logo/URI not yet set. To add: host off-chain JSON, call `UpdateTokenMetadata` (variant 18) via Sanctum program, signed by pool manager. Script: `scripts/update-pegged-metadata.ts`.

**$BANK metadata not yet registered.** Needs Metaplex token metadata: name, symbol, image, off-chain JSON.

## DigitalOcean / Bot deployment

**Droplet:** `159.223.133.9` (NYC1, s-1vcpu-2gb, Ubuntu 22.04)
**Domain:** `bot.crank.money` (A record on Vercel DNS)
**SSL:** Let's Encrypt via certbot (auto-renewing)
**SSH key:** `~/.ssh/id_ed25519_deploy`

```
/root/crank-money/           — App code (rsynced)
/root/crank-money/bot/.env   — Bot environment (persists across deploys)
/root/.keys/bot-keypair.json — Bot wallet keypair (chmod 600)
```

```bash
./scripts/deploy.sh              # Deploy (default IP 159.223.133.9)
ssh -i ~/.ssh/id_ed25519_deploy root@159.223.133.9
pm2 logs crank-harvester --lines 50
curl http://localhost:8080/api/stats
```

**Bot security:** The bot keypair is the deployer/admin. Holds authority for all programs + SPL stake pool manager + Config.bot fee recipient (20%). Regularly sweep fees to a hardware wallet.

**DO account:** `doctl compute droplet get 555127833`

## Relay endpoints

All served via `https://bot.crank.money`:

| Endpoint | Description |
|----------|-------------|
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
| `WSS /ws` | Real-time: activeBinChanged, harvestNeeded, harvestExecuted, positionClosed, roverTvlUpdated, feedHistory |

## Known issues

- **Token-2022 transfer hooks unsupported** — V2 CPI but hook extra accounts not resolved. `RemainingAccountsInfo::empty_hooks()` everywhere.
- **DataPI portfolio endpoints unusable for user positions** — keyed by wallet, but crank.money positions owned by per-position vault PDAs. Rover portfolio works (single `rover_authority` PDA).
- **Epoch-computer not built yet** — keeper's `crankNewEpoch()` reads `epoch-data.json` but the service that computes the Merkle tree doesn't exist. Daily distributions no-op until built. See `todo.md`.
