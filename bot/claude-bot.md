# bot/ — crank.money harvester

The off-chain infrastructure that monitors and executes on Solana. Runs on a DigitalOcean droplet at `bot.crank.money`.

## What it does

Watches all crank.money DLMM positions via Helius LaserStream gRPC. When price moves through a user's bin range, the bot harvests those bins — pulling converted tokens back to the owner's wallet before the chart reverses. It also runs the daily fee pipeline: sweep fees, distribute SOL via Merkle tree, and auto-claim for users.

When `DISCORD_TOKEN` is set, the harvester also starts the Discord bot — 12 slash commands for trading, wallet management, burn, and governance. Harvest and close events are piped to the Discord notifier for DMs and feed channel posts. Gas model: bot is the sole signer + fee payer; `deduct_gas` reimburses the bot from each user's vault PDA on every user-facing instruction.

## Files

| File | What it does |
|------|-------------|
| `anchor-harvest-bot.ts` | Orchestrator / main entry point. Wires modules together, boots the process, runs health server on :8080, manages graceful shutdown. Conditionally starts Discord bot if `DISCORD_TOKEN` is set. |
| `geyser-subscriber.ts` | Helius LaserStream gRPC subscriber. Parses raw 904-byte LbPair accounts for activeId changes. Maintains in-memory position registry grouped by pool. Emits `harvestNeeded` events. Auto-reconnect with exponential backoff. |
| `harvest-executor.ts` | Job queue that submits harvest/close transactions. Deduplicates jobs, confirms bin balances via RPC before submitting, handles Token-2022. Max 5 concurrent. Bot-signed, fee payer; vault PDAs reimburse via `deduct_gas`. Enrichment: reads token deltas from confirmed tx via `getTransaction`. Auto-unwraps WSOL after harvest/close via `unwrap_wsol_in_vault`. |
| `keeper.ts` | Daily fee sequencer (runs once per UTC day). 8 steps: close WSOL → sweep rover (curve-driven split) → open rover bids → rover burn+mint → dual epoch distribution (SOL + BANK) → open fee rovers → close exhausted rovers → prune inactive crank-role members. |
| `epoch-computer.ts` | Daily SOL distribution engine. Computes per-user shares from harvest fees, builds Merkle tree, drains epoch-vault, wraps WSOL, funds distributor, auto-claims for all users above threshold. |
| `relay-server.ts` | REST API + WebSocket relay. Exposes bot state: pools, positions, pending harvests, fee pipeline, rovers, protocol PnL, activity feed. `/api/health` returns 503 when unhealthy. |
| `alerter.ts` | Discord feed channel alerts with 5-min cooldown + dedup. Fires on: gRPC disconnect/reconnect, low bot balance, keeper failures. |
| `meteora-accounts.ts` | Shared Meteora CPI account resolution + DLMM instance cache (10-min TTL, LRU eviction). Used by executor and keeper. |
| `price-syncer.ts` | RETIRED. Jupiter routes through DLMM organically. |
| `logger.ts` | pino logger. |
| `retry.ts` | Shared `withRetry()` — 3 retries, exponential backoff. |
| `bot.test.ts` | Unit tests (vitest): LbPair byte parsing, safe bin detection, job dedup, bin contiguity. No RPC deps. |
| `ecosystem.config.cjs` | PM2 config for the droplet. 512MB max memory. |
| `idl/` | Anchor IDL JSON files (bin_farm, merkle_distributor, epoch_vault, etc.). |

## Architecture

```
GeyserSubscriber (gRPC stream)
  ├─ activeBinChanged → check positions → harvestNeeded
  │                                          │
  │                                    HarvestExecutor (job queue)
  │                                          ├─ harvest_bins tx
  │                                          └─ close_position tx
  │                                          │
  │                                    ┌─────┴─────┐
  │                                    │            │
  │                              RelayServer   DiscordNotifier
  │                              (broadcast)   (DMs + feed)
  │
  └─ positionChanged → registry update

Keeper (daily timer)
  ├─ close WSOL on rover_authority
  ├─ sweep_rover → curve-driven split (burn_sol_vault + bridge_vault + bot)
  ├─ open rover bids (wrap_burn_sol → buy-side CRANK/SOL)
  ├─ rover_burn_and_mint (CRANK → BANK → bank-distributor vault)
  ├─ dual epoch distribution (SOL + BANK Merkle → auto-claim)
  ├─ open fee rovers (non-CRANK token fees → DLMM positions)
  ├─ close exhausted rovers
  └─ prune inactive crank-role members

DiscordBot (conditional — requires DISCORD_TOKEN)
  ├─ 14 slash commands: start, balance, deposit, buy, sell,
  │   positions, close, withdraw, pools, vote, burn, help,
  │   leaderboard, stats
  ├─ Pool routing: multi-pool selection, auto-split, mcap/price/pct input
  ├─ Vault PDAs: user wallet → UserVault PDA (seeded by owner wallet), no keypairs
  └─ Notifier: DM on harvest/close, feed channel posts

RelayServer (HTTP :8080)
  ├─ REST: /api/stats, /api/pools, /api/positions, /api/fees, etc.
  └─ WebSocket: /ws (real-time events)
```

## Fee split

Curve-driven `sweep_rover` (50 bps fee, reads `crank_mint.supply` on-chain):
- `burn_ratio × total` → `burn_sol_vault` PDA → buy-side CRANK bids → burn → mint BANK → bank-distributor
- `trader_sol_frac × total` → `bridge_vault` → drain → WSOL → merkle-distributor → auto-claim
- `protocol_skim × total` → `Config.bot` (self-funding ops)

where `burn_ratio = min(1.0, (supply/initial)/0.75)`, `protocol_skim = 0.20×(1−burn_ratio)`.

## Deployment

```bash
# Deploy to droplet
./scripts/deploy.sh

# SSH in (IP and key from env / secrets)
pm2 logs crank-harvester --lines 50
curl http://localhost:8080/api/stats
```

## Running locally

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Fill: RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, all program IDs
# Optional: DISCORD_TOKEN + friends (see below)
npm run bot
```

## Required env vars

| Var | What |
|-----|------|
| `RPC_URL` | Helius Pro RPC |
| `GRPC_ENDPOINT` | Helius LaserStream gRPC (with `?api-key=`) |
| `BOT_KEYPAIR_PATH` | Path to bot wallet keypair JSON |
| `CORE_PROGRAM_ID` | bin_farm program |
| `DISTRIBUTOR_PROGRAM_ID` | merkle_distributor program |

## Discord env vars (optional — bot starts only if DISCORD_TOKEN is set)

| Var | What |
|-----|------|
| `DISCORD_TOKEN` | Bot token from discord.com/developers |
| `DISCORD_CLIENT_ID` | Application client ID |
| `DISCORD_FEED_CHANNEL_ID` | Channel ID for public activity feed |
| `DB_PATH` | Path to vault PDA mapping / position DB (default: `./data/crankbot.json`) |
