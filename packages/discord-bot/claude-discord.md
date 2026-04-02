# packages/discord-bot — CrankBot Discord slash command bot

12 slash commands for trading, wallet management, and governance. Runs inside the harvester process when `DISCORD_TOKEN` is set, or standalone via `tsx src/index.ts`.

## Files

| File | What it does |
|------|-------------|
| `src/index.ts` | `DiscordBot` class — wires discord.js client to command handlers. `BotContext` carries connection, programs, wallet service, subscriber. Standalone entry point at bottom. |
| `src/formatter.ts` | All bot output formatting. Plain text, no embeds. ASCII fill bars, Solscan links. Pools grouped by pair. |
| `src/notifier.ts` | DMs + feed channel posts on harvest/close events. Uses pool registry for labels and decimals. |
| `src/deploy-commands.ts` | One-time script to register 12 slash commands with Discord API. Guild-scoped (instant) or global (1hr propagate). |
| `src/deposit-detect.ts` | Auto-detect first SOL depositor and lock as withdraw address. Called by /balance and /withdraw. |

## Commands

| Command | What it does |
|---------|-------------|
| `/start` | Create custody wallet, show deposit address. "Deposit 0.5 SOL from your withdraw wallet to start." |
| `/balance` | Show SOL + all token balances. Solscan-linked deposit + withdraw addresses. Auto-detects depositor. |
| `/deposit` | Show deposit address + withdraw address if set. |
| `/buy` | Open buy position. Multi-pool routing, mcap/price/pct input, auto-split up to 5 positions. |
| `/sell` | Open sell position. Same routing as /buy. |
| `/positions` | List open positions with ASCII fill bars, pool labels, current price. |
| `/close` | Bare: show positions with IDs. `/close <id>`: close one. `/close all`: rage quit. |
| `/withdraw` | Bare: show balances + withdraw wallet + examples. `/withdraw SOL .5`: execute. |
| `/pools` | Show covered pairs with current price/mcap. |
| `/vote` | On-chain gauge vote. `/vote SOL 50 CRANK 50`. |
| `/burn` | Burn CRANK → mint BANK 1:1. |
| `/help` | List all commands. |

## How it integrates with the harvester

When running inside `anchor-harvest-bot.ts`:
- Subscriber is passed to `BotContext` — `/pools` reads real-time prices from gRPC memory
- Executor events (`harvestExecuted`, `positionClosed`) piped to notifier for DMs + feed
- User's custody keypair used for all commands — user pays gas
- Epoch-computer auto-claims SOL for users daily (no /claim command needed)

## Key design decisions

- **Withdraw address auto-detection** — first wallet that deposits SOL becomes the permanent withdraw address. No `/setwithdraw` command needed.
- **One gauge per pair** — users vote on pairs (SOL, CRANK), not individual DLMM pools.
- **Gas offloading** — all user-initiated actions use user's custody wallet SOL.
- **0.25 SOL gate** on `/buy` and `/sell` — prevents wallet drain.
- **Pool registry as source of truth** — all pool names, decimals, symbols from `curator.json`.
- **SOL price from Pyth oracle** — not DexScreener. Eliminates FOGO contamination.
