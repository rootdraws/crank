# crank.money

**Limit orders that earn fees. Burn $CRANK, earn SOL and BANK.**

Managed Meteora DLMM positions with sub-second bin harvesting via Helius LaserStream. Non-custodial PDA vaults. Revenue shared via $BANK governance + daily Merkle distributions of SOL and BANK.

## How it works

Set your range as a single-sided LP. Price moves through it → bins convert → Crank's Harvester pulls the yield into your vault.

- **Sell the Rips:** deposit token above price. As price rips, bins convert to SOL.
- **Buy the Dips:** deposit SOL below price. As price dips, bins convert to token.

**Fee:** 0.5% on converted output only. Zero fee on deposit. LP fees claimable at zero cost anytime.

**Custody:** user funds live in on-chain UserVault PDAs seeded by `[b"user_vault", owner_wallet]`. Bot is a stateless operator — server compromise cannot steal funds. Withdrawals are PDA-enforced to the vault's original owner.

**Permissionless:** every harvest, sweep, and distribution can be cranked by anyone if the bot goes stale.

## Programs

| Program | Address |
|---------|---------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| bank-mint | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` |
| gauge-voter | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` |
| merkle-distributor | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` |
| bank-distributor | `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M` |
| epoch-vault | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` |

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |

## Burn curve

`sweep_rover` reads `crank_mint.supply` and splits SOL:

```
remaining     = crank_mint.supply / initial_crank_supply
burn_ratio    = min(1.0, remaining / 0.75)
protocol_skim = 0.20 × (1 − burn_ratio)
trader_frac   = 1 − burn_ratio − protocol_skim
```

Three phases: **Magnesium** (100% burn while ≥ 75% supply) → **Dimming** (burn fades, yield emerges) → **Embers** (80 traders / 20 protocol indefinitely).

## Build

```bash
npm install
anchor build
node scripts/generate-clients.mjs
```

## Run

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, DISCORD_TOKEN, RELAY_AUTH_TOKEN
npm run bot
```

## Deeper reading

- `claude.md` — full architecture, file map, PDA seeds, fee flow, runtime invariants
- `audit-v2.md` + `auditv1.md` — security audits with current disposition
- `runbooks/` — droplet recovery, keypair separation
- `capturethebag.md` — 2026-04-13 amendment ship log

## License

MIT
