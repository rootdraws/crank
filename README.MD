# crank.money

**Execution layer for cross-venue delta-neutral funding-rate arbitrage.**

Selective Meteora DLMM is the smart-execution layer for the spot leg of a funding-rate-arb trade — laddered fills, auto-withdraw on completion, no market orders. Pre-set perp limit closes (Hyperliquid, planned) handle squeeze risk on the short side.

## Spot leg (live)

Set a range as a single-sided LP. Price moves through it → bins convert → the harvester pulls the yield into the user's PDA vault.

- **Sell the Rips:** deposit token above price. As price rips, bins convert to SOL.
- **Buy the Dips:** deposit SOL below price. As price dips, bins convert to token.

**Fee:** 0.5% on converted output only. Zero fee on deposit. LP fees claimable at zero cost anytime.

**Custody:** user funds live in on-chain `UserVault` PDAs seeded by `[b"user_vault", owner_wallet]`. The bot is a stateless operator — server compromise cannot steal funds. Withdrawals are PDA-enforced to the vault's original owner.

**Real-time:** Helius LaserStream gRPC drives sub-second bin-change → harvest. (Alchemy gRPC migration in flight — see `conversion.md`.)

## Perp leg (in flight)

Hyperliquid integration for the short side of the delta-neutral pair. Pre-set limit closes for squeeze risk. Targeting tokens with elevated funding rates (zerebro, lighter, anthropic, griffain, pump, fartcoin, SOL, CRANK).

## Token

CRANK is exposure to the operator's strategy yield, expressed mechanically through a SOL-side DLMM bid ladder. Customers (traders) and investors (CRANK holders) are decoupled — the product is open to anyone paying fees, the token is pure economic exposure to the desk.

No claim function. No buyback schedule. No burn schedule. No yield. The buy ladder is a standing exit. See `pivot.md` for the full thesis and operating model.

## Programs

| Program | Address |
|---------|---------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |

## Status

- **Shipped:** PDA-vault custody, gas/rent passthrough, bin-farm core, harvester, Discord bot (~13 commands), relay (Bearer-gated REST + WS), per-minute wallet-DB backups.
- **In flight:** Alchemy gRPC migration, hopper wallet topology (W-Buy / W-Sell / Treasury / Personal + weekly sweep), Hyperliquid perp leg, per-tribe pool funnels.

## Build

```bash
npm install
anchor build -p bin_farm
node scripts/generate-clients.mjs
```

## Run

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, DISCORD_TOKEN, RELAY_AUTH_TOKEN
npm run bot
```

## Deeper reading

- `claude.md` — full architecture, file map, PDA seeds, runtime invariants
- `pivot.md` — operating thesis + 4-wallet hopper topology
- `conversion.md` — Helius → Alchemy gRPC migration prep
- `runbooks/` — droplet recovery, keypair separation

## License

MIT
