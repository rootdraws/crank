# packages/discord-bot — CrankBot Discord slash command bot

14 slash commands for trading, wallet management, governance, and revenue claims. Runs inside the harvester process when `DISCORD_TOKEN` is set, or standalone via `tsx src/index.ts`.

## Files

| File | What it does |
|------|-------------|
| `src/index.ts` | `DiscordBot` class — wires discord.js client to command handlers. `BotContext` carries connection, programs, wallet service, subscriber. Standalone entry point at bottom. |
| `src/formatter.ts` | All bot output formatting. Plain text, no embeds. ASCII fill bars, Solscan links. Pools grouped by pair. Orangutan voice on errors. |
| `src/notifier.ts` | DMs + feed channel posts on harvest/close events. `onEpochComplete` stubbed for auto-claim. Uses pool registry for labels and decimals. |
| `src/deploy-commands.ts` | One-time script to register 14 slash commands with Discord API. Guild-scoped (instant) or global (1hr propagate). |

## Commands

| Command | What it does |
|---------|-------------|
| `/start` | Create custody wallet, show deposit address. Suggests 0.5 SOL. |
| `/balance` | Show SOL + all token balances (SPL Token + Token-2022). |
| `/deposit` | Show deposit address. |
| `/buy` | Open buy position. Multi-pool routing, mcap/price/pct input, auto-split up to 5 positions. 0.25 SOL minimum gate. |
| `/sell` | Open sell position. Same routing as /buy. |
| `/positions` | List open positions with ASCII fill bars, pool labels, current price. |
| `/close` | Close a position by ID prefix. Decimals and labels from pool registry. |
| `/withdraw` | Withdraw token or SOL to external address. Token-2022 support, "all" amount, transfer_checked. |
| `/pools` | Show covered pairs with current price/mcap. Uses gRPC subscriber data (no RPC), falls back to RPC in standalone mode. |
| `/vote` | On-chain gauge vote. One gauge per pair. `/vote SOL` = 100%, `/vote SOL 50 CRANK 50` = split. Reads from `curator.json` gauges map. |
| `/burn` | Burn CRANK (Token-2022) → mint BANK (SPL Token) 1:1. Raw instruction from IDL discriminator. |
| `/claim` | Claim $PEGGED from merkle-distributor. Reads IPFS CID from distributor PDA, fetches tree, builds proof. |
| `/unstake` | Unstake $PEGGED → SOL via SPL Stake Pool WithdrawSol. Instant from reserve. |
| `/help` | List all commands with examples. |

## How it integrates with the harvester

When running inside `anchor-harvest-bot.ts`:
- Subscriber is passed to `BotContext` — `/pools` reads real-time prices from gRPC memory
- Executor events (`harvestExecuted`, `positionClosed`) piped to notifier for DMs + feed
- User's custody keypair used for all commands — user pays gas
- `onEpochComplete` (stubbed) will auto-claim $PEGGED for users after daily epoch

## Key design decisions

- **One gauge per pair** — users vote on pairs (SOL, CRANK), not individual DLMM pools. Bin steps are abstracted away.
- **Gas offloading** — all user-initiated actions use user's custody wallet SOL. Bot wallet only pays for protocol-level keeper operations.
- **0.25 SOL gate** on `/buy` and `/sell` — prevents users from draining their wallet and getting stuck.
- **Pool registry as source of truth** — all pool names, decimals, token symbols resolved from `curator.json` via `loadPoolRegistry()`. No hardcoded values in command handlers.
- **No Codama for bank-mint / merkle-distributor / gauge-voter** — raw instructions from IDL discriminators. Codama only used for bin-farm (open_position_v2, user_close).
