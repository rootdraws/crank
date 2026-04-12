# crank.money

**Limit orders that earn fees. Burn $CRANK, earn SOL.**

Managed Meteora DLMM positions with sub-second bin harvesting via Helius LaserStream. Revenue shared via $BANK token governance and daily Merkle SOL distribution on Solana.

## The Problem

Your market buys and sells are clumsy. They slam the orderbook, and slippage eats away at your profits.

Your LP positions get bled out by Impermanent Loss.

You need Automations, but Jupiter charges you 0.12% as a platform fee, plus LP fees and slippage on execution.

## The Solution

### Yield Bearing, Ranged Limit Orders.

Set your range as a single-sided LP. If price moves through your range, Crank's Harvester captures that profit, or accumulation, and pulls it into your wallet.

**Sell the Rips.** Crank's Harvester pulls your SOL before the chart reverses.

**Buy the Dips.** Crank's Harvester lets you build a position over a range of lows.

**How it works:**

1. User deposits SOL or TOKEN into bins above/below current price.
2. Position acts as a limit order, earning LP fees as the position fills.
3. Price sweeps through bins, and your tokens are converted via Meteora DLMM.
4. Crank's Harvester detects fully-converted bins via Helius LaserStream gRPC (sub-second).
5. Harvester calls `harvest_bins` with those specific bin IDs.
6. Anchor program CPIs to Meteora `removeLiquidity` for only those bins.
7. Harvested tokens flow directly into the owner's wallet.
8. Remaining bins stay open, waiting to be filled.

### Performance Fee

Zero fee on deposit. 0.3% on converted output only. LP fees can be claimed anytime at zero cost.

### Non-Custodial PDA Vaults

User funds live in on-chain program-derived accounts (PDAs), not bot-held keypairs. Server compromise cannot steal funds — withdrawals are enforced to the user's registered wallet by PDA seed derivation. The bot is a stateless operator.

### Permissionless Harvesting

Every step in the revenue pipeline is permissionless. Harvest, close, sweep, distribute — all crankable by anyone. The system is resilient without our infrastructure.

## Programs

| Program | Address | Description |
|---------|---------|-------------|
| **bin-farm** (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` | Position wrapper on Meteora DLMM. Harvest, close, rovers. `sweep_rover` splits 40/40/20. |
| **bank-mint** | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` | Burn $CRANK to mint $BANK 1:1. Supply cap: `bank_supply + crank_supply <= 2B`. |
| **gauge-voter** | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` | BANK holders vote on global pool weights. Admin-curated pool registry. |
| **merkle-distributor** | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` | Cumulative SOL (WSOL) distribution via Merkle proofs. Daily epoch. Auto-claimed. |
| **epoch-vault** | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` | SOL fee accumulator. Receives 80% from sweep_rover. Drained daily by epoch-computer. |

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |

## $BANK Token — Burn $CRANK, Earn SOL

Burn $CRANK to mint $BANK at a 1:1 ratio. Supply cap enforced on-chain.

**Revenue flow:**

1. Protocol fees (0.3% on converted output) collected by the rover system.
2. `sweep_rover` splits 40/40/20:
   - **80% to bridge_vault** — accumulated SOL for daily distribution
   - **20% Operations** — self-funding bot infrastructure
3. Daily epoch-computer drains vault, wraps SOL → WSOL, funds Merkle distributor.
4. Auto-claimed to user custody wallets (user pays gas). SOL just shows up.
5. Trees pinned to IPFS for transparency.

**Gauge voting:** BANK holders call `vote()` to influence how rewards are allocated across curated pools.

## Project Structure

```
crank-money/
├── programs/           # Anchor workspace (5 active programs)
│   ├── bank-mint/
│   ├── bin-farm/
│   ├── gauge-voter/
│   ├── merkle-distributor/
│   └── epoch-vault/
├── bot/                # Crank's Harvester (off-chain infrastructure)
├── packages/
│   ├── core-sdk/       # Shared SDK (pool routing, range parsing, wallet service)
│   └── discord-bot/    # 12 slash commands (buy, sell, vote, burn, withdraw, etc.)
├── public/             # On-chain referenced assets (token logos, metadata)
├── scripts/            # Deploy, diagnostics, admin utilities
├── curator.json        # Pool registry + gauge map (read by bot at runtime)
└── deploy/nginx/       # Production nginx config
```

## Build & Deploy

```bash
npm install
anchor build
solana program deploy target/deploy/bin_farm.so \
  --program-id 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia
```

IDL generation: `anchor idl build -p bin_farm` (repeat for each program). Codama clients: `node scripts/generate-clients.mjs`. Pin `blake3` and `borsh` to 1.5.5 after `cargo update`.

## Run Crank's Harvester

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — set RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, program IDs
# Optional: add DISCORD_TOKEN + DISCORD_CLIENT_ID to enable Discord bot
npm run bot
```

## Testing

```bash
npm test                               # Unit tests (65 tests: bin detection, Merkle proofs, share computation)
curl http://localhost:8080/api/fees    # Live fee pipeline snapshot (rover + bridge vault + distributor WSOL)
npx tsx scripts/preflight-check.ts     # Verify all programs + PDAs on-chain
npx tsx scripts/test-epoch.ts --dry-run --min-lamports 1000000  # Epoch dry-run (no on-chain action)
npx tsx scripts/test-epoch.ts --min-lamports 1000000            # Epoch live E2E test
```

## Deployment

| Component | URL |
|-----------|-----|
| Bot Relay | `wss://bot.crank.money` |

## Security

Adversarial security audit completed 2026-04-01 (`audit.md`). 53 findings, 33 remediated in-session.

**On-chain:**
- All harvests, sweeps, and distributions are permissionless. Anyone can crank them if the bot goes stale — no fund lock-up.
- Fee split (40/40/20) is hardcoded in the program. Cannot be changed without a program upgrade.
- All arithmetic uses `checked_*` operations. `clippy::integer_arithmetic` deny enforced at crate level in bin-farm.
- Programs can be upgraded (upgrade authority held by deployer). Keypair separation to cold wallet (Ledger) planned.

**Custody (PDA Vaults — shipped 2026-04-08):**
- No custodial keypairs. User funds live in UserVault PDAs: `[b"user_vault", owner_wallet]`.
- Withdraw destination = vault.owner (PDA seed), immutable. Server compromise cannot redirect withdrawals.
- Bot is a stateless operator. DB loss = inconvenience (re-register), NOT fund loss.
- All user-facing operations reimburse bot gas from vault via on-chain `deduct_gas`.
- Wallet metadata DB backed up every minute to off-server object storage. Daily full-server snapshots.

**Infrastructure:**
- SSH key-only authentication, fail2ban, UFW firewall, automatic security updates.
- Bot runs as `root` (service user migration planned). SSH key-only, no password auth.
- API rate-limited (10 req/s per IP). Bearer token auth on all endpoints except `/api/health`.
- WebSocket connections capped (2 per IP via nginx, 100 total server-side).
- Priority fees capped at 500K micro-lamports/CU (prevents RPC fee inflation attacks).
- Health endpoint (`/api/health`) with automated alerting on gRPC disconnect, low balance, keeper failures, and process death.
- npm dependencies pinned to exact versions. No caret ranges.

## Dependencies

- Solana CLI 3.0+ (Agave)
- Anchor 0.31.1
- Rust (via rustup)
- Node.js 18+
- Meteora DLMM SDK (`@meteora-ag/dlmm`)
- Helius LaserStream gRPC (`helius-laserstream`)
- tsx (TypeScript execution for bot)

## License

MIT
