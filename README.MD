# crank.money

**Limit orders that earn fees. Burn $CRANK, earn $PEGGED.**

Managed Meteora DLMM positions with sub-second bin harvesting via Helius LaserStream. Revenue shared via $BANK token governance and daily Merkle distribution on Solana.

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
4. Crank's Harvester detects fully-converted bins via Helius LaserStream gRPC.
5. Harvester calls `harvest_bins` with those specific bin IDs.
6. Anchor program CPIs to Meteora `removeLiquidity` for only those bins.
7. Harvested tokens flow directly into the owner's wallet.
8. Remaining bins stay open, waiting to be filled.

### Performance Fee

Zero fee on deposit. 0.3% on converted output only. LP fees can be claimed anytime at zero cost.

### Permissionless Harvesting

Every step in the revenue pipeline is permissionless. Harvest, close, sweep, stake, deposit — all crankable by anyone. The system is resilient without our infrastructure.

## Programs

| Program | Address |
|---------|---------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| bank-mint | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` |
| gauge-voter | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` |
| merkle-distributor | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` |
| pegged-bridge | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` |

| Program | Description |
|---------|-------------|
| **bin-farm** (core) | Position wrapper on Meteora DLMM. Harvest, close, rovers. `sweep_rover` splits 40/40/20: 40% BANK holders, 40% traders, 20% operations. |
| **bank-mint** | Burn $CRANK to mint $BANK 1:1. Supply cap: `bank_supply + crank_supply <= 2B`. |
| **gauge-voter** | BANK holders vote on global pool weights. Admin-curated pool registry. |
| **merkle-distributor** | Cumulative $PEGGED distribution via Merkle proofs. Daily epoch. IPFS-pinned trees. |
| **pegged-bridge** | SOL → Sanctum SPL multi-stake pool (Helius + LP Army + MonkeDAO validators) → $PEGGED → Merkle distributor vault. |

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |
| $PEGGED (crankSOL) | `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1` | 9 |
| SPL Stake Pool | `9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg` | — |

## $BANK Token — Burn $CRANK, Earn $PEGGED

Burn $CRANK to mint $BANK at a 1:1 ratio. Supply cap enforced on-chain.

**Revenue flow:**

1. Protocol fees (0.3% on converted output) collected by the rover system.
2. `sweep_rover` splits 40/40/20:
   - **40% BANK holders** — SOL → staked via SPL stake pool → $PEGGED → Merkle distributor vault
   - **40% Traders** — distributed proportional to fees paid, weighted by gauge votes
   - **20% Operations** — self-funding bot infrastructure
3. Daily Merkle tree combines both holder and trader rewards.
4. Trees pinned to IPFS for transparency.

**Gauge voting:** BANK holders call `vote()` to influence how the 40% trader reward is allocated across curated pools.

## $PEGGED (crankSOL)

The 40% holder share and 40% trader share are converted into a SOL Liquid Staking token, delegated to three validators:

- Helius Validator
- Meteora LP Army Validator
- MonkeDAO Validator

$PEGGED is Liquid Staked SOL launched on Sanctum. APR ~7% depending on Solana staking yield.

## Project Structure

```
crank-money/
├── programs/           # Anchor workspace (5 active programs)
│   ├── bank-mint/
│   ├── bin-farm/
│   ├── gauge-voter/
│   ├── merkle-distributor/
│   └── pegged-bridge/
├── bot/                # Crank's Harvester (off-chain infrastructure)
├── public/             # On-chain referenced assets (token logos, metadata)
├── scripts/            # Deploy, diagnostics, admin utilities
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
npm run bot
```

## Testing

```bash
npm test                               # Unit tests (bin detection, queue dedup, contiguity)
npx tsx scripts/fee-dashboard.ts       # Fee pipeline snapshot
npx tsx scripts/preflight-check.ts     # Verify all programs + PDAs on-chain
```

## Deployment

| Component | URL |
|-----------|-----|
| Bot Relay | `wss://bot.crank.money` |

## Security

- Programs can be upgraded (upgrade authority held by deployer).
- AI Audit using [Adversarial Spec](https://github.com/zscole/adversarial-spec) and several rounds of analysis with Opus 4.6.
- All harvests and sweeps can be cranked by anyone when the bot is stale, preventing fund lock-up.

## Dependencies

- Solana CLI 3.0+ (Agave)
- Anchor 0.31.1
- Rust (via rustup)
- Node.js 18+
- Meteora DLMM SDK (`@meteora-ag/dlmm`)
- Helius LaserStream gRPC (`@triton-one/yellowstone-grpc`)
- tsx (TypeScript execution for bot)
- esbuild (Codama client generation)

## License

MIT
