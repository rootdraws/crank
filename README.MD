# crank.money

Execution layer for cross-venue delta-neutral funding-rate arbitrage. Selective Meteora DLMM as the spot leg's smart-execution surface; protocol revenue routes on-chain via the Hopper program; treasury matching is gated by SPL Governance + a custom voter-weight addin so a compromised bot cannot drain protocol funds.

## Programs (mainnet)

| Program | Address |
|---------|---------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| hopper (routing) | `2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF` |
| proposal-whitelist-addin | `9Tpa3wZwm21yPFvZtDQYnJic5UGKPNQKqQqCiC6tkUnv` |

## Tokens

| Token | Mint | Decimals | Program |
|-------|------|----------|---------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 | Token-2022 |

## Governance (mainnet)

Realm `crank.money` runs on SPL Governance + the proposal-whitelist-addin. The Native Treasury PDA owns the treasury vault; community-side proposals are addin-gated (off-whitelist proposals get voter weight 0).

| Artifact | Address |
|---------|---------|
| Realm | `Y62sT9Xdqa2gFxZVBykWLAgPYdFnYneE3Xq2Dk9sSBC` |
| Governance | `EkNgm2mUHGbPK6WG9HLwCQKPKVAn3oKuvMmKpqtRNYud` |
| Native Treasury PDA (NTP) | `A9Ko5BBnobV82WDukujNYo9BcC5YiFqBY148BH5JKsdn` |
| Treasury UserVault (bin-farm) | `DgSDbnE2hPAE6AofJaMLCRGi96p7FRQsna6WmyM85kU5` |
| Council mint | `Z8qs4GLpPQBMp8RDXASCYSywkxsBbJB8gPfesDhKeBt` |
| Proposal-perm mint | `H2AkWcqYoubEZUZSNv65kecRE5SSL3PjQBgo6nZnoG4t` |

## Fee model

- **bin-farm exec fee** — 1% on harvested LP yield, routed to HopperVault. Hopper sweeps 4-way: 25% treasury (NTP) / 25% admin / 25% ops / 25% tax reserve.
- **bin-farm settle** — on treasury-matched closes (Path B): 25% proposer / 25% tax reserve / 50% treasury (NTP). Combined cap `payout_bps + tax_bps ≤ 5000`.

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

- `claude.md` — architecture, PDA seeds, runtime invariants, fee model, ix surface
- `runbooks/` — droplet recovery, keypair separation

## License

MIT
