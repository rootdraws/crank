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

Zero fee on deposit. **0.5% (50 bps) on converted output only.** LP fees can be claimed anytime at zero cost.

### Non-Custodial PDA Vaults

User funds live in on-chain program-derived accounts (PDAs), not bot-held keypairs. Server compromise cannot steal funds — withdrawals are enforced to the user's registered wallet by PDA seed derivation. The bot is a stateless operator.

### Permissionless Harvesting

Every step in the revenue pipeline is permissionless. Harvest, close, sweep, distribute — all crankable by anyone. The system is resilient without our infrastructure.

### Programmatic Membership

The Discord trading floor is a members-only club. Every trade posts to the feed with the trader's `@handle` (rendered as a link, no ping). A `/leaderboard` command ranks recent volume in a rolling window. A daily keeper step prunes the crank role from registered users who go a full window without an open position or a harvest — idle wallets drop out, signal stays high. An optional `#cash-out` channel restricts command dispatch to `/close`, `/withdraw`, `/positions`, `/balance`, and `/help`.

## Programs

Six active on-chain programs:

| Program | Address | Description |
|---------|---------|-------------|
| **bin-farm** (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` | Position wrapper on Meteora DLMM. Harvest, close, rovers. `sweep_rover` is curve-driven (supply-responsive split across burn / trader / protocol). Hosts `wrap_burn_sol`, `open_rover_bid_position`, `rover_burn_and_mint`. |
| **bank-mint** | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` | Burn $CRANK to mint $BANK 1:1. Supply cap: `bank_supply + crank_supply <= 2B`. |
| **gauge-voter** | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` | BANK holders vote on global pool weights. Admin-curated pool registry. |
| **merkle-distributor** | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` | Cumulative SOL (WSOL) distribution via Merkle proofs. Daily epoch. Non-custodial `new_epoch` — vault pre-funded by `drain_vault + sync_native`. Auto-claimed. |
| **bank-distributor** | `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M` | Parallel Merkle distributor for $BANK. Vault pre-funded by `rover_burn_and_mint`. Same `claim()` semantics as merkle-distributor. |
| **epoch-vault** | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` | SOL fee accumulator. Receives the trader SOL portion from `sweep_rover`. `drain_vault` targets the merkle-distributor WSOL vault directly (non-custodial). |

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |

## $BANK Token — Burn $CRANK, Earn SOL

Burn $CRANK to mint $BANK at a 1:1 ratio. Supply cap enforced on-chain.

### Supply-driven burn curve

`sweep_rover` reads `crank_mint.supply` and a one-shot snapshot of
`initial_crank_supply` from `RoverAuthority`, then splits accumulated SOL via:

```
remaining        = crank_mint.supply / initial_crank_supply
burn_ratio       = min(1.0, remaining / 0.75)        // 100% burn while ≥ 75% supply
protocol_skim    = 0.20 × (1 − burn_ratio)           // 0 → 0.20 as supply depletes
trader_sol_frac  = 1 − burn_ratio − protocol_skim
```

**Phases:**
- **Magnesium (100% → 75% supply).** 100% burn. Every fee SOL funds CRANK buys that get burned; BANK mints to traders. Zero protocol skim.
- **Dimming (75% → 0% supply).** Burn fades linearly; direct SOL yield emerges; protocol skim grows 0 → 20%.
- **Embers (0% supply).** 100% SOL yield. 80 traders / 20 protocol. Indefinite.

**Kill switch:** `set_burn_enabled(false)` clamps `burn_ratio = 0` regardless of supply — 80 traders / 20 protocol until re-enabled.

### Revenue flow (non-custodial)

1. 50 bps fee on converted output lands in `rover_authority` ATAs.
2. `sweep_rover` splits SOL by the curve:
   - `burn_ratio × total` → `burn_sol_vault` PDA (bin-farm-owned)
   - `trader_sol_frac × total` → `bridge_vault` PDA (epoch-vault)
   - `protocol_skim × total` → `Config.bot` (operations revenue)
3. `burn_sol_vault` → `wrap_burn_sol` + `open_rover_bid_position` — bot places buy-side DLMM bids on CRANK/SOL ~70 bins below active.
4. As price dips, bids fill → CRANK accumulates on `rover_authority`.
5. `rover_burn_and_mint` burns rover CRANK via CPI to bank-mint, minting BANK directly into the bank-distributor vault.
6. Daily keeper publishes two Merkle roots:
   - **SOL tree** — vault is `drain_vault`ed straight into the merkle-distributor WSOL vault, `sync_native`d in place.
   - **BANK tree** — vault pre-funded by step 5.
7. Both `new_epoch`s take `(root, ipfs_cid)` only — no token transfer. They compute `epoch_amount = vault.amount + total_claimed − total_funded` on-chain.
8. Auto-claimed to user vault PDAs. Users' reward tokens never touch any operator keypair between mint and claim.
9. Trees pinned to IPFS for transparency.

CRANK *token* fees (from CRANK/SOL trades on the CRANK side) bypass the usual `open_fee_rover` sell-path and go straight through `rover_burn_and_mint`. Fuel is fuel.

**Gauge voting:** BANK holders call `vote()` to influence how rewards are allocated across curated pools.

## Project Structure

```
crank-money/
├── programs/           # Anchor workspace (6 active programs)
│   ├── bank-mint/
│   ├── bank-distributor/
│   ├── bin-farm/
│   ├── gauge-voter/
│   ├── merkle-distributor/
│   └── epoch-vault/
├── bot/                # Crank's Harvester (off-chain infrastructure)
├── packages/
│   ├── core-sdk/       # Shared SDK (pool routing, range parsing, wallet service, burn curve)
│   └── discord-bot/    # 13 slash commands (buy, sell, vote, burn, withdraw, leaderboard, etc.)
├── public/             # On-chain referenced assets (token logos, metadata)
├── scripts/            # Deploy, diagnostics, admin utilities (init-burn-curve.ts, etc.)
├── curator.json        # Pool registry + gauge map (read by bot at runtime)
└── deploy/nginx/       # Production nginx config
```

## Build & Deploy

```bash
npm install
anchor build                               # Builds all 6 programs
solana program deploy target/deploy/bin_farm.so \
  --program-id 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia
```

IDL generation: `anchor idl build -p bin_farm` (repeat for each program). Codama clients: `node scripts/generate-clients.mjs` (generates clients for bin-farm, epoch-vault, bank-distributor, merkle-distributor). Pin `blake3` and `borsh` to 1.5.5 after `cargo update`.

## Run Crank's Harvester

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — set RPC_URL, GRPC_ENDPOINT, BOT_KEYPAIR_PATH, program IDs
# Optional: add DISCORD_TOKEN + DISCORD_CLIENT_ID to enable Discord bot
npm run bot
```

## Testing

```bash
npm test                               # Unit tests (~60: bin detection, Merkle proofs, share computation, burn curve)
curl http://localhost:8080/api/fees    # Live fee pipeline snapshot (rover, burn_sol_vault, bridge vault, both distributor vaults)
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
- Fee split is curve-driven. Parameters snapshot once at `initialize_burn_curve` and are immutable per `RoverAuthority` invariants.
- **Distribution vaults are pre-funded by program flows** — no operator custody of reward tokens between mint and claim. `new_epoch` publishes merkle roots only; authority signs intent, not value.
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
