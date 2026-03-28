# bot/ — crank.money harvester

The off-chain infrastructure that monitors and executes on Solana. Runs on a DigitalOcean droplet at `bot.crank.money`.

## What it does

Watches all crank.money DLMM positions via Helius LaserStream gRPC. When price moves through a user's bin range, the bot harvests those bins — pulling converted tokens back to the owner's wallet before the chart reverses. It also runs the daily fee pipeline: sweep fees, stake SOL into $PEGGED, and upload Merkle distributions.

## Files

| File | What it does |
|------|-------------|
| `anchor-harvest-bot.ts` | Orchestrator / main entry point. Wires modules together, boots the process, runs health server on :8080, manages graceful shutdown. |
| `geyser-subscriber.ts` | Helius LaserStream gRPC subscriber. Parses raw 904-byte LbPair accounts for activeId changes. Maintains in-memory position registry grouped by pool. Emits `harvestNeeded` events. Auto-reconnect with exponential backoff. |
| `harvest-executor.ts` | Job queue that submits harvest/close transactions. Deduplicates jobs, confirms bin balances via RPC before submitting, handles Token-2022. Max 5 concurrent. |
| `keeper.ts` | Daily fee sequencer (runs once per UTC day). 6 steps: close WSOL → sweep rover (40/40/20 split) → stake_and_forward ($PEGGED) → open fee rovers → new_epoch (Merkle) → close exhausted rovers. |
| `relay-server.ts` | REST API + WebSocket relay. Exposes bot state: pools, positions, pending harvests, fee pipeline, rovers, protocol PnL, activity feed. The Telegram bot will consume these endpoints. |
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
  │
  └─ positionChanged → registry update

MonkeKeeper (daily timer)
  ├─ close WSOL on rover_authority
  ├─ sweep_rover → 40% bridge_vault + 40% trader_dest + 20% bot
  ├─ stake_and_forward → SOL → $PEGGED → Merkle vault
  ├─ open fee rovers (token fees → DLMM positions)
  ├─ new_epoch (upload Merkle root + fund vault)
  └─ close exhausted rovers

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

# SSH in
ssh -i ~/.ssh/id_ed25519_deploy root@159.223.133.9
pm2 logs crank-harvester --lines 50
curl http://localhost:8080/api/stats
```

## Running locally

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Fill: RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, all program IDs
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
