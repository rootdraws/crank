# bot/ — crank.money harvester

The off-chain infrastructure that monitors and executes on Solana. Runs on a DigitalOcean droplet at `bot.crank.money`.

## What it does

Watches all crank.money DLMM positions via Helius LaserStream gRPC. When price moves through a user's bin range, the bot harvests those bins — pulling converted tokens back to the owner's wallet before the chart reverses. It also runs the daily fee pipeline: sweep fees, stake SOL into $PEGGED, and upload Merkle distributions.

When `DISCORD_TOKEN` is set, the harvester also starts the Discord bot — 15 slash commands for trading, wallet management, burn/claim, and governance. Harvest and close events are piped to the Discord notifier for DMs and feed channel posts. Gas offloading: harvests and closes are signed with the user's custody keypair (user pays gas), with bot keypair as permissionless fallback.

## Files

| File | What it does |
|------|-------------|
| `anchor-harvest-bot.ts` | Orchestrator / main entry point. Wires modules together, boots the process, runs health server on :8080, manages graceful shutdown. Conditionally starts Discord bot if `DISCORD_TOKEN` is set. |
| `geyser-subscriber.ts` | Helius LaserStream gRPC subscriber. Parses raw 904-byte LbPair accounts for activeId changes. Maintains in-memory position registry grouped by pool. Emits `harvestNeeded` events. Auto-reconnect with exponential backoff. |
| `harvest-executor.ts` | Job queue that submits harvest/close transactions. Deduplicates jobs, confirms bin balances via RPC before submitting, handles Token-2022. Max 5 concurrent. Gas offloading: signs with user's custody keypair when available. Enrichment: reads token deltas from confirmed tx via `getTransaction`. Auto-unwraps WSOL after harvest/close. |
| `keeper.ts` | Daily fee sequencer (runs once per UTC day). 6 steps: close WSOL → sweep rover (40/40/20 split) → stake_and_forward ($PEGGED) → open fee rovers → new_epoch (Merkle) → close exhausted rovers. |
| `relay-server.ts` | REST API + WebSocket relay. Exposes bot state: pools, positions, pending harvests, fee pipeline, rovers, protocol PnL, activity feed. `/api/health` returns 503 when unhealthy. |
| `alerter.ts` | Discord feed channel alerts with 5-min cooldown + dedup. Fires on: gRPC disconnect/reconnect, low bot balance, keeper failures. |
| `meteora-accounts.ts` | Shared Meteora CPI account resolution + DLMM instance cache (10-min TTL, LRU eviction). Used by executor and keeper. |
| `logger.ts` | pino logger. |
| `retry.ts` | Shared `withRetry()` — 3 retries, exponential backoff. |
| `bot.test.ts` | Unit tests (vitest): LbPair byte parsing, safe bin detection, job dedup, bin contiguity. No RPC deps. |
| `ecosystem.config.cjs` | PM2 config for the droplet. 512MB max memory. |
| `idl/` | Anchor IDL JSON files for all 5 active programs. |

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
  ├─ sweep_rover → 40% bridge_vault + 40% trader_dest + 20% bot
  ├─ stake_and_forward → SOL → $PEGGED → Merkle vault
  ├─ open fee rovers (token fees → DLMM positions)
  ├─ new_epoch (upload Merkle root + fund vault)
  └─ close exhausted rovers

DiscordBot (conditional — requires DISCORD_TOKEN)
  ├─ 15 slash commands: start, balance, deposit, buy, sell,
  │   positions, close, setwithdraw, withdraw, pools, vote, burn, claim, unstake, help
  ├─ Pool routing: multi-pool selection, auto-split, mcap/price/pct input
  ├─ Custodial wallets: AES-256-GCM encrypted keypairs
  └─ Notifier: DM on harvest/close, feed channel posts

RelayServer (HTTP :8080)
  ├─ REST: /api/stats, /api/pools, /api/positions, /api/fees, etc.
  └─ WebSocket: /ws (real-time events)
```

## Fee split

40/40/20 — hardcoded on-chain in `sweep_rover`:
- 40% to `bridge_vault` → staked → $PEGGED → Merkle distributor (BANK holders)
- 40% to `trader_dest` → staked → $PEGGED → Merkle distributor (traders, gauge-weighted)
- 20% to `Config.bot` (operations, self-funding)

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
| `BRIDGE_PROGRAM_ID` | pegged_bridge program |
| `PEGGED_MINT` | $PEGGED / crankSOL mint |

## Discord env vars (optional — bot starts only if DISCORD_TOKEN is set)

| Var | What |
|-----|------|
| `DISCORD_TOKEN` | Bot token from discord.com/developers |
| `DISCORD_CLIENT_ID` | Application client ID |
| `DISCORD_FEED_CHANNEL_ID` | Channel ID for public activity feed |
| `WALLET_ENCRYPTION_KEY` | 32 bytes hex for custodial wallet encryption (`openssl rand -hex 32`) |
| `DB_PATH` | Path to wallet/position DB (default: `./data/crankbot.json`) |
