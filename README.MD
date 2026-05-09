# crank.money

Execution layer for cross-venue delta-neutral funding-rate arbitrage. Selective Meteora DLMM as the spot leg's smart-execution surface; protocol revenue routes on-chain via the Hopper program; treasury matching is gated by SPL Governance + a custom voter-weight addin so a compromised bot cannot drain protocol funds.

## Programs

| Program | Address |
|---------|---------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| hopper (routing) | `2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF` |
| proposal-whitelist-addin | `9Tpa3wZwm21yPFvZtDQYnJic5UGKPNQKqQqCiC6tkUnv` (devnet only — mainnet pending) |

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |

## Fee model

- **bin-farm exec fee** — 1% on harvested LP yield, routed to HopperVault. Hopper sweeps 4-way: 25% treasury / 25% admin / 25% ops / 25% tax reserve.
- **bin-farm settle** — on treasury-matched closes: 25% proposer / 25% tax reserve / 50% treasury (NTP).

## Build

```bash
npm install
PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor build
node scripts/generate-clients.mjs
```

## Run

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit: RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, DISCORD_TOKEN, RELAY_AUTH_TOKEN
npm run bot
```

## Docs

- `claude.md` — architecture, PDA seeds, runtime invariants, fee model
- `HANDOFF.md` (repo root) — current deploy state + next-session work
- `runbooks/` — droplet recovery, keypair separation

## License

MIT
