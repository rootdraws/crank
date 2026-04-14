# claude.md — crank.money codebase context

## RULES — READ THESE FIRST

**When something happens on the deployed bot, READ THE FULL LOGS.** Do NOT grep for what you expect to find — read what's actually there.

```bash
# CORRECT: dump full logs around the time window, then read them
ssh -i ~/.ssh/id_ed25519_deploy root@159.223.133.9 'cat /root/.pm2/logs/crank-harvester-out.log' | grep 'HH:MM'

# WRONG: grep for a keyword and assume nothing happened if it's not there
ssh ... 'pm2 logs ... | grep harvest'  # ← MISSES "Closed 9sUpPpqm" because you grepped for "harvest"
```

Key log patterns to know:
- Executor harvest: `"Harvest submitted: N bins from XXXX"`
- Executor close: `"Closed XXXX"` (NOT "close" lowercase — it's the position PDA prefix)
- gRPC trigger: `"[executor] XXXX Sell ALL N bins → CLOSE"` or `"→ HARVEST"`
- Safety poll: `"[safety] skip XXXX"` or `"[safety] HH:MM:SS N positions"`
- gRPC connect: `"[geyser] Connected. Watching N pools"`

When Root says something happened, it happened. Read the logs to find HOW, not to argue WHETHER.

**Limit orders that earn fees. Burn $CRANK, earn BANK + SOL.**

crank.money wraps Meteora DLMM positions on Solana. Set your range as a single-sided LP — **sell the rips** or **buy the dips**. If price moves through your range, Crank's Harvester pulls each bin the moment it converts.

Performance fee on converted output only (**0.5%, 50 bps** since 2026-04-13 Capture the Bag amendment). `sweep_rover` is **curve-driven**: splits SOL across three destinations using `burn_ratio = min(1.0, (crank_supply / initial_crank_supply) / 0.75)` and `protocol_skim = 0.20 × (1 − burn_ratio)`. Burn portion → `burn_sol_vault` PDA → bot places buy-side DLMM bids → fills → CRANK accumulates on rover → `rover_burn_and_mint` burns CRANK and mints BANK straight into the bank-distributor vault. Trader SOL portion → bridge_vault → merkle-distributor WSOL vault. Protocol skim → `Config.bot`. **Distribution is non-custodial** — both `new_epoch` instructions take `(root, cid)` only and compute `epoch_amount = vault.amount + total_claimed − total_funded` on-chain. Reward tokens never touch the operator keypair between mint and claim. BANK holders vote on pool weights via gauge-voter.

**PDA vault architecture (shipped 2026-04-08):** No custodial keypairs. Each user gets a UserVault PDA seeded by their real Solana wallet: `[b"user_vault", owner_wallet]`. Funds live on-chain in the vault PDA. Bot is a stateless operator — server wipe loses zero user funds. Withdrawals enforced to vault.owner by PDA seed derivation. All user-facing operations reimburse bot gas from vault via `deduct_gas`.

**Interface:** Discord bot (Telegram adapter planned). Users type `/buy GSD 900kmc to 1.1mmc SOL 10` — bot maps tickers to curated pools, converts mcap/price to bin ranges, routes to best DLMM pool by bin step, opens positions. Community doc pages per subdomain (e.g. `gsd.crank.money`).

## Architecture

Six active on-chain programs:

- **bin-farm** (core) — Position management (open, harvest, close, claim fees) + rover system. All CPI via V2 variants (Token-2022 native). **Curve-driven sweep_rover** — reads `crank_mint.supply` + `RoverAuthority.initial_crank_supply`/`burn_enabled`, computes ppb-scaled `burn_ratio` + `protocol_skim`, routes to `burn_sol_vault` / `trader_dest` / `Config.bot`. Hosts the new `wrap_burn_sol`, `open_rover_bid_position`, `rover_burn_and_mint`, `set_fee_bps`, `initialize_burn_curve`, `set_burn_enabled` instructions. Permissionless fallback on user operations (heartbeat + staleness pattern, `keeper_tip_bps`). Side derived on-chain from `active_id`.
- **bank-mint** — Burn $CRANK → mint $BANK 1:1. Supply cap: `bank_supply + crank_supply <= 2B`. BankConfig PDA is sole mint authority.
- **gauge-voter** — Global-state pair weight voting. One gauge per trading pair (not per bin step). BANK holders blend weights via `vote()`. Admin registers pairs via `add_pool` using a representative LbPair address. Max 32 pairs. Votes stick permanently. Epoch-computer aggregates fees across all bin step pools for a pair.
- **merkle-distributor** — Cumulative SOL (WSOL) distribution via Merkle proofs. Daily epoch. IPFS-pinned trees. **Non-custodial `new_epoch`** — takes `(root, cid)` only, reads vault delta on-chain. Vault pre-funded by `drain_vault(destination = distributor WSOL vault)` + SPL `sync_native`. `claim()` is permissionless (payer != claimant). Auto-claimed by keeper. Supports ~1M leaves.
- **bank-distributor** (new — 2026-04-13) — Parallel cumulative BANK distribution. Program ID `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M`. Byte-identical to merkle-distributor with a different `declare_id!`. Same non-custodial `new_epoch`. Vault pre-funded by `rover_burn_and_mint`.
- **epoch-vault** (was pegged-bridge) — SOL fee accumulator. Receives trader SOL portion from sweep_rover via `bridge_vault` PDA. `drain_vault` lets authority withdraw for distribution; destination is now the distributor WSOL vault (not the bot wallet). Same program ID `7oHSUP...`.

## Key instructions

```
--- User Vault Operations (bin-farm) ---
create_vault(owner)           → Creates UserVault PDA. Anyone can pay rent. PDA seed = owner wallet.
wrap_sol_in_vault(amount)     → Debit vault lamports → credit WSOL ATA + sync_native. For SOL buys.
unwrap_wsol_in_vault()        → Close vault WSOL ATA → lamports to vault PDA. After harvest/claim.
withdraw_sol(amount)          → Vault PDA lamports → owner wallet. Rent-exempt guard.
withdraw_token(amount)        → Vault ATA → owner ATA. Vault PDA signs.
vault_burn_and_mint(amount)   → CPI to bank-mint: burn CRANK from vault → mint BANK to vault.
vault_vote(allocations)       → CPI to gauge-voter: vote with vault's BANK holdings.
update_gas_lamports(amount)   → Admin sets per-operation gas reimbursement.

--- Position Operations (bin-farm) ---
open_position_v2(pool, amount, min_bin, max_bin, side, slippage)
  → Bot signs, tokens from vault ATA → Meteora. Side derived on-chain. deduct_gas.

harvest_bins(bin_ids)
  → Fees → rover_authority → sweep_rover → curve split.
  → Remainder → vault ATAs (not external wallet). deduct_gas.

close_position() / user_close()
  → Same fee mechanic. Tokens → vault ATAs. Rent → vault PDA. deduct_gas.

claim_fees()
  → LP trading fees → vault ATAs (no protocol fee). deduct_gas.

--- Protocol Operations (bin-farm) ---
sweep_rover()                   → Permissionless. Curve-driven split: SOL →
                                  burn_sol_vault + bridge_vault + Config.bot.
                                  Reads crank_mint.supply on-chain.
wrap_burn_sol(amount)           → Debit burn_sol_vault → credit rover WSOL ATA.
                                  Bot must follow with SPL sync_native in same tx.
open_rover_bid_position(amt, step)
                                → Bot-gated. Opens buy-side BidAsk DLMM position
                                  (Y-only, below active) on CRANK/SOL using rover
                                  WSOL ATA. Clone of open_fee_rover, flipped.
rover_burn_and_mint(amount)     → Bot-gated. CPI bank-mint burn_and_mint with
                                  rover_authority as user. Then transfer_checked
                                  minted BANK from rover BANK ATA → caller-supplied
                                  destination (keeper passes bank-distributor vault
                                  ATA → non-custodial).
open_fee_rover()                → Recycle NON-CRANK token fees into sell-side DLMM
                                  positions. Keeper skips CRANK mint (handled by
                                  rover_burn_and_mint).
close_rover_token_account()     → Unwrap WSOL on rover_authority.
close_rover_position()          → Closes rover DLMM position (bot-gated).

--- Admin-gated (bin-farm, Config.authority signer) ---
set_fee_bps(new_fee_bps)        → Direct setter (replaces propose_fee/apply_fee timelock).
initialize_burn_curve()         → One-shot: snapshots crank_mint.supply into
                                  RoverAuthority.initial_crank_supply, enables burn,
                                  creates burn_sol_vault PDA. Errors if already
                                  initialized.
set_burn_enabled(bool)          → Kill switch. False clamps burn_ratio to 0.

--- External Programs ---
burn_and_mint(amount)           [bank_mint]           → Burn $CRANK, mint $BANK 1:1.
vote(allocations)               [gauge_voter]         → Blend global pool weights.
new_epoch(root, cid)            [merkle_distributor]  → Publish root only. Vault
                                                         delta computed on-chain.
                                                         No transfer.
new_epoch(root, cid)            [bank_distributor]    → Same semantics, BANK instead
                                                         of WSOL.
claim(index, amount, proof)     [merkle/bank-dist]    → Auto-claimed by keeper.
                                                         Token → claimant ATA.
drain_vault(amount)             [epoch_vault]         → Authority-gated. Moves SOL
                                                         from bridge_vault to the
                                                         passed destination (now the
                                                         distributor WSOL vault).
```

## Bin detection logic

```
SELL THE RIPS (token deposited above price → SOL output):
  Safe bins = bins where binId < activeId (price ripped above them)

BUY THE DIPS (SOL deposited below price → token output):
  Safe bins = bins where binId > activeId (price dipped below them)
```

## File map

```
programs/
  bank-mint/src/lib.rs           — Burn $CRANK → mint $BANK 1:1
  bank-distributor/src/lib.rs    — Cumulative BANK Merkle claims (fork of merkle-distributor)
  bin-farm/src/
    lib.rs                       — Core: positions, harvest, close, rovers, curve-driven sweep
    meteora_dlmm_cpi.rs          — CPI module (V2 only)
  gauge-voter/src/lib.rs         — Pool weight voting + pool curation
  merkle-distributor/src/lib.rs  — Cumulative SOL (WSOL) Merkle claims + IPFS CID
  epoch-vault/src/lib.rs         — SOL fee accumulator + drain_vault instruction

bot/
  anchor-harvest-bot.ts          — Orchestrator, health server :8080, graceful shutdown
  geyser-subscriber.ts           — Helius LaserStream gRPC, raw LbPair byte parsing,
                                   position registry, persistent cache, auto-reconnect
  harvest-executor.ts            — Job queue, Token-2022 aware, dedup, max 5 concurrent
  keeper.ts                      — Daily fee sequencer (8 steps: close WSOL → sweep →
                                   open rover bids → rover burn+mint → dual epoch
                                   (SOL + BANK) → fee rovers (CRANK-bypass) → close
                                   exhausted → prune inactive crank-role members)
  epoch-computer.ts              — Daily distribution. runEpoch (SOL): drain bridge_vault
                                   straight to distributor WSOL vault → sync_native →
                                   new_epoch. runBankEpoch (BANK): read bank-distributor
                                   vault delta → new_epoch → auto-claim. Non-custodial.
  relay-server.ts                — REST API + WebSocket relay (stats, pools, positions,
                                   fees, rovers, PnL, feed)
  meteora-accounts.ts            — Shared Meteora CPI account resolution + DLMM cache
  logger.ts                      — pino logger
  retry.ts                       — Shared withRetry (exponential backoff)
  alerter.ts                     — Discord feed channel alerts (gRPC, low balance, keeper failures, sync)
  price-syncer.ts                — RETIRED. Jupiter routes through DLMM organically.
  bot.test.ts                    — Unit tests (vitest): bin detection, byte parsing, dedup
  epoch-computer.test.ts         — Unit tests (vitest): Merkle proof verification, share computation, hashing (27 tests)
  burn-curve.test.ts             — Unit tests (vitest): compute_curve reference values,
                                   invariants, kill switch, edge cases (16 tests)
  ecosystem.config.cjs           — PM2 config (512MB, auto-restart)
  idl/                           — Anchor IDL JSON files (bin_farm, merkle_distributor,
                                   bank_distributor, epoch_vault, etc.)
  claude-bot.md                  — Bot folder context doc

public/                          — On-chain referenced assets only
  crank-token.png                — $CRANK token logo
  crank-metadata.json             — $CRANK off-chain metadata JSON

scripts/
  deploy.sh                      — Rsync + npm install + PM2 restart + health check (pre-deploy wallet DB backup)
  setup-droplet.sh               — One-time server provisioning (fail2ban, unattended-upgrades, SSH hardening, PM2 log rotation)
  backup-wallet-db.sh            — Per-minute wallet DB backup to DO Spaces (cron)
  preflight-check.ts             — Verify all programs + PDAs on-chain
  generate-clients.mjs           — Codama client generation from IDL (bin-farm,
                                   epoch-vault, bank-distributor, merkle-distributor)
  init-burn-curve.ts             — One-shot bootstrap: initialize_burn_curve +
                                   set_fee_bps(50) + bank-distributor init + ATAs.
                                   --execute to send, dry-run by default.
  recycle-fee-rover.ts           — Manual fee rover opener
  close-all-positions.ts         — Force-close all user positions (bot-signed, vault architecture)
  force-close-position.ts        — Debug close with high CU + simulation (bot-signed, vault architecture)
  close-wsol.ts                  — Vault WSOL diagnostic (shows balance, suggests /withdraw)
  reclaim-atas.ts                — Vault ATA diagnostic (lists empty ATAs for rent reclaim)
  test-epoch.ts                  — Standalone epoch trigger (--dry-run, --min-lamports) for E2E testing

tools/
  depth.ts                       — DLMM order book depth chart (ASCII, market cap bands)
  protocol-lp/                   — Protocol LP automation (harvest sell rips → BidAsk buy re-entry)
    index.ts                     — Orchestrator, poll loop, ProtocolLP class
    harvester.ts                 — Position discovery, safe bin detection, removeLiquidity
    deployer.ts                  — BidAsk buy position creation via DLMM SDK
    config.ts                    — Environment loading + validation
    state.ts                     — Persistent state (data/protocol-lp-state.json)
    health.ts                    — HTTP health endpoint for PM2

packages/
  core-sdk/                      — Shared SDK for chat bot
    claude-core-sdk.md           — Core SDK context doc
    constants.ts                 — All program IDs, mints, layout offsets, ppb curve
                                   constants, rover bid sizing (SOURCE OF TRUTH)
    pda.ts                       — All PDA derivation (6 programs + Meteora + Metaplex,
                                   includes burn_sol_vault + bank-distributor PDAs)
    burn-curve.ts                — TS mirror of compute_curve (ppb, BigInt). Used by
                                   /burn status + tests to validate on-chain math.
    math.ts                      — binToPrice, priceToBin, percentRangeToBins, formatPrice
    pool-config.ts               — PoolConfig type + loadPoolRegistry() from curator.json
    range-parser.ts              — Price/mcap/pct range parsing + command string parser
    pool-router.ts               — Multi-pool routing with auto-split, quoteTokenUsdPrice conversion
    price-source.ts              — DexScreener price fetching with 10s per-mint cache
    wallet-service.ts            — User vault PDA mapping + position/vote/harvest tracking (no keypairs, no encryption)
    signer.ts                    — Bot-only tx signing (no user keypairs)
    meteora.ts                   — Meteora pool resolution helpers
    transactions.ts              — Transaction building utilities
  discord-bot/                   — Discord slash command bot
    claude-discord.md            — Discord bot context doc
    src/index.ts                 — DiscordBot class, wires commands, standalone + embedded modes
    src/notifier.ts              — DM + feed channel notifications on harvest/close events
    src/formatter.ts             — Message formatting (pools grouped by pair, ASCII fill bars)
    src/deploy-commands.ts       — Register slash commands with Discord API
    src/commands/                 — 13 handlers: start, balance, deposit, buy, sell,
                                   positions, close, withdraw, pools, vote, burn, help,
                                   leaderboard
    src/deposit-detect.ts        — Returns owner wallet (PDA seed enforcement replaces deposit-based locking)

deploy/nginx/
  bot.crank.money.conf           — Production nginx (SSL + WebSocket + CORS + rate limiting)

security.md                      — Security hardening checklist (completed 2026-03-29)

curator.json                     — Pool registry (ticker → pool address + config, read by bot)
Anchor.toml                      — 6 programs, mainnet cluster
todo.md                          — Living task list
capturethebag.md                 — Ship log for the 2026-04-13 curve + non-custodial amendment
```

## PDA seeds

| PDA | Seeds | Program |
|-----|-------|---------|
| Config | `[b"config"]` | bin-farm |
| **UserVault** | `[b"user_vault", owner_wallet.key()]` | bin-farm |
| PositionCounter | `[b"pos_counter", user_vault.key(), lb_pair.key()]` | bin-farm |
| MeteorPosition | `[b"meteora_pos", user_vault.key(), lb_pair.key(), count]` | bin-farm |
| Position | `[b"position", meteora_position.key()]` | bin-farm |
| Vault (per-position) | `[b"vault", meteora_position.key()]` | bin-farm |
| RoverAuthority | `[b"rover_authority"]` | bin-farm |
| BurnSolVault | `[b"burn_sol_vault"]` | bin-farm |
| BankConfig | `[b"bank_config"]` | bank-mint |
| GaugeConfig | `[b"gauge_config"]` | gauge-voter |
| PoolGauge | `[b"pool_gauge", lb_pair.key()]` | gauge-voter |
| Distributor (SOL) | `[b"distributor"]` | merkle-distributor |
| ClaimStatus (SOL) | `[b"claim_status", distributor.key(), claimant.key()]` | merkle-distributor |
| Distributor (BANK) | `[b"distributor"]` | bank-distributor |
| ClaimStatus (BANK) | `[b"claim_status", distributor.key(), claimant.key()]` | bank-distributor |
| BridgeConfig | `[b"bridge_config"]` | epoch-vault |
| BridgeVault | `[b"bridge_vault"]` | epoch-vault |

## Program IDs

| Program | ID |
|---------|------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| bank-mint | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` |
| gauge-voter | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` |
| merkle-distributor | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` |
| bank-distributor | `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M` |
| epoch-vault | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` |

## Token addresses

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |

## Key PDAs (live)

| PDA | Address | Program |
|-----|---------|---------|
| Core Config | `MeTGCG86PTWhnN52yV9ie8oJkgfSLGyuRCFxhDd97i2` | bin-farm |
| RoverAuthority | `56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR` | bin-farm |
| BurnSolVault | `C3kNgWtLurmvfvf27wdsz4V9zrQL956KY5DTjF6JMnD6` | bin-farm |
| Trader Dest | `B9gTfeCbN1oSXKCKgog5gGTH3VGNr3U5SYH4mL3gtqxK` | (= bridge_vault, on RoverAuthority) |
| BankConfig | `HxvvyJtscUTmUhkvz6D5gidGEfmatuSmFgcxxRzexwKF` | bank-mint |
| GaugeConfig | `AqdJmiDvUj6DWKt48QCMEqWSnh2a2qjExidhbrMw9z17` | gauge-voter |
| Distributor (SOL) | `Hwra7Rz8ZfBVuJYqyGz5PL9Bj21jSvw2qbxkg2uoE7xQ` | merkle-distributor |
| Distributor Vault (SOL/WSOL) | `Fr3ntupQJRsYzTAVzNerd7zQ7QHkwKtaE5fjPVx21ZSw` | ATA |
| Distributor (BANK) | `9pQBWUhCeFeJpYgPsP6NsxvSXyLbmX8F3tekrVi3Wtrf` | bank-distributor |
| Distributor Vault (BANK) | `DLLD7r62rp9AEbH2CiTtkKuJCrSmiehseMByNPvoySo6` | ATA |
| Rover BANK ATA | `Fqq5Cp1LoNFdntcz6crjB2pCfK6Axtrt9YyuWjzjfKtg` | ATA owned by RoverAuthority |
| BridgeVault | `B9gTfeCbN1oSXKCKgog5gGTH3VGNr3U5SYH4mL3gtqxK` | epoch-vault |

## Fee flow

```
harvest/close → 50 bps fee → rover_authority ATAs
  SOL fees   : WSOL ATA → close_rover_token_account (unwrap) → sweep_rover
  CRANK fees : rover CRANK ATA → rover_burn_and_mint   (keeper skips open_fee_rover
                                                       for CRANK mint — CRANK is
                                                       fuel, not inventory)
  Other tok  : rover ATA → open_fee_rover (BidAsk sell side) → natural conversion → SOL

sweep_rover curve split (reads crank_mint.supply + RoverAuthority.initial_crank_supply):
  burn_ratio × total     → burn_sol_vault PDA  (bin-farm-owned)
  trader_sol_frac × tot  → trader_dest         (= bridge_vault, epoch-vault)
  protocol_skim × total  → Config.bot          (self-funding operations + revenue)

  where:
    remaining       = crank_mint.supply / initial_crank_supply
    burn_ratio      = min(1.0, remaining / 0.75)           (kill switch clamps to 0)
    protocol_skim   = 0.20 × (1 − burn_ratio)
    trader_sol_frac = 1 − burn_ratio − protocol_skim

Rover-side burn pipeline (keeper steps 2a + 2b):
  burn_sol_vault → wrap_burn_sol → rover WSOL ATA → SPL sync_native (next ix)
                 → open_rover_bid_position (buy-side BidAsk on CRANK/SOL, ~70 bins
                                            below active, Y-only WSOL deposit)
  Bids fill over the day → CRANK accumulates on rover_authority
  rover_burn_and_mint → CPI bank-mint → BANK minted directly to bank-distributor vault.
                                        Never touches bot wallet.

Daily epoch-computer (two trees, same computeShares weights):
  SOL  : drain_vault (bridge_vault → distributor WSOL vault) → sync_native
       → merkle_distributor.new_epoch(root, cid) → auto-claim to user vault PDAs
  BANK : (vault pre-funded by rover_burn_and_mint)
       → bank_distributor.new_epoch(root, cid)   → auto-claim to user vault PDAs

Both new_epoch instructions publish the merkle root only. They compute
  epoch_amount = vault.amount + total_amount_claimed − total_amount_funded
on-chain — no transfer, no funder_ata. Operator keypair signs intent only.
```

## Build

Anchor 0.31.1, Solana CLI 3.0+. `blake3` pinned to 1.5.5 (Rust 1.84 BPF compat).

```bash
anchor build                              # All 6 programs (includes bank-distributor)
anchor idl build -p bin_farm              # IDL generation (repeat for each program)
node scripts/generate-clients.mjs         # Codama TypeScript clients
                                          # (bin-farm, epoch-vault, bank-distributor,
                                          #  merkle-distributor)
```

**Run bot:** `npm run bot` (tsx, loads env from `bot/.env`).

**Testing:** `npx vitest run` (~60 unit tests — bin detection, Merkle proofs, share computation, burn curve), `curl http://localhost:8080/api/fees` (live fee pipeline snapshot: rover + burn_sol_vault + bridge vault + both distributor vaults), `npx tsx scripts/test-epoch.ts --dry-run` (epoch dry-run).

## Tools

### `npm run depth <TICKER>` — Order Book Depth Chart

Reads all DLMM bin liquidity for a pool and renders an ASCII depth chart showing buy/sell pressure by market cap band. Sell-side bars grow rightward from the top, buy-side bars grow rightward from the bottom, centered on current price.

```bash
npm run depth CRANK                    # Default: 10 bands, auto-sized ($5k for small mcap)
npm run depth CRANK -- --bands 15      # More bands per side
npm run depth CRANK -- --band-size 10k # Override band size
npm run depth SOL -- --pool sol-usdc-1 # Specific pool (price-mode)
npm run depth CRANK -- --bins 300      # Override bin fetch count per side
```

Shows per-band: SOL to clear, USD equivalent, cumulative from current price outward (↓ sell, ↑ buy). Reads pool config from `curator.json`, SOL/USD from Pyth, bin data from `@meteora-ag/dlmm` SDK. Requires `RPC_URL` in `bot/.env`.

### `npm run protocol-lp` — Protocol LP Automation

Headless bot that manages protocol-owned DLMM liquidity. Harvests SOL from converted sell-side bins, accumulates until threshold (2 SOL default), then deploys as BidAsk buy positions 70 bins below active price. Creates a floor — heavier liquidity at lower bins.

```bash
DRY_RUN=true npm run protocol-lp     # Logs what it would do, no transactions
DRY_RUN=false npm run protocol-lp    # Live mode
```

Config via `tools/protocol-lp/.env` (falls back to `bot/.env` for RPC_URL). Requires `KEYPAIR_PATH` pointing to the LP wallet. Health endpoint on `:8081/health`. PM2 config at `tools/protocol-lp/ecosystem.config.cjs`. Separate droplet from crank-harvester.

**Files:** `tools/protocol-lp/` — `index.ts` (orchestrator), `harvester.ts` (bin detection + removeLiquidity), `deployer.ts` (BidAsk buy re-entry), `config.ts`, `state.ts`, `health.ts`.

## Implementation notes

**Do not remove `Box<>` wrappers** on `InterfaceAccount` / `Account` fields in bin-farm. BPF 4KB stack frame overflow without them.

**Rover remaining_accounts (2).** `open_rover_position` and `open_fee_rover` pass `event_authority` + `dlmm_program` via remaining_accounts (BPF stack constraint).

**Fee rover CU budget: 1M.** `open_fee_rover` uses 1M compute units (BidAskImBalanced across 69 bins). All other operations stay at 400K.

**Fee rover threshold is value-based, not raw-unit.** `keeper.ts crankOpenFeeRovers` computes USD value from PumpSwap AMM reserves (on-chain, no API). Each pool must have `pumpswapPool` in `curator.json`. Opens if `valueUsd >= MIN_FEE_ROVER_USD` (default $10). Bin width: `width = clamp(valueUsd / FEE_ROVER_BIN_USD, 1, maxWidth)` with `FEE_ROVER_BIN_USD` default $10 — concentrate liquidity, don't spread dust. Exhaustion check closes rovers with <5% of initial amount remaining.

**`bitmap_ext` is NOT `#[account(mut)]`.** DLMM program ID placeholder is executable and can't be writable. CPI module uses `bitmap_meta()` helper.

**All Meteora CPI is V2.** No V1 code remains.

**Token-2022 fully supported.** All 14 outbound transfers use `transfer_checked` from `token_interface`. Decimals read at byte offset 44.

**Mcap-to-bin conversion for non-USD quote pools.** For pools with `displayMode: 'mc'`, plain numbers and `k`/`m`/`b` suffixes are treated as mcap (e.g. `24k` = 24,000 mcap). `rangeInputToPrice()` converts to USD price (`mcap / supply`). `priceToBin()` expects DLMM-native prices. For SOL-quoted pools (CRANK/SOL), `routeCommand()` divides by `quoteTokenUsdPrice` (fetched from DexScreener) to convert USD → SOL-denominated before bin calculation. Without this, bins land on the wrong side of `activeId` and the on-chain program picks the wrong token program.

**Setup tx CU budget: 800K for bin array init.** Meteora `initializeBinArray` on wide-step pools (binStep 80) exceeds the default 200K CU limit. `buildSetupTx()` auto-detects DLMM instructions and bumps to 800K.

**Helius LaserStream SDK (`helius-laserstream`).** Replaced `@triton-one/yellowstone-grpc` which silently failed to deliver account updates. SDK handles reconnect, ping/pong, and 24h replay. Subscription format: named filters with `account` and `owner` arrays. Data callback receives `SubscribeUpdate` — account info at `message.account.account` with `pubkey` and `data` as Buffers.

**Sanctum SPL Stake Pool — RETIRED.** $PEGGED killed 2026-04-01. Pool exists on-chain but is no longer used. Revenue distributed as SOL directly via Merkle distributor.

**`binIdToBinArrayIndex` uses `Math.trunc` not `Math.floor`.** For negative bin IDs, `Math.floor` rounds toward negative infinity but Meteora's SDK truncates toward zero then subtracts 1 if remainder is non-zero. The off-by-one caused bin array PDAs to mismatch what the on-chain program expected. Fixed in `pda.ts`.

**Gas model (vault reimburses bot).** Bot is sole tx signer + fee payer. After each user-facing instruction, `deduct_gas()` transfers `config.gas_lamports` from the user's vault PDA to the bot. 9 instructions have gas deduction: open_position_v2, harvest_bins, close_position, user_close, claim_fees, withdraw_sol, withdraw_token, wrap_sol_in_vault, unwrap_wsol_in_vault. Protocol operations (sweep_rover, wrap_burn_sol, open_rover_bid_position, rover_burn_and_mint, fee rovers, epoch claims bundled with unwrap) are funded by the protocol skim (`Config.bot` destination from sweep_rover).

**`wrap_burn_sol` must be followed by SPL `sync_native` in the same tx.** Same constraint as `wrap_sol_in_vault` — calling `sync_native` inside the same instruction that modified the WSOL ATA's lamports hits a runtime balance mismatch. The keeper composes `createAssociatedTokenAccountIdempotent → wrap_burn_sol → sync_native` in a single tx before calling `open_rover_bid_position` in a follow-up tx (CU budget).

**`rover_burn_and_mint` destination is caller-supplied.** The instruction forwards minted BANK from rover's BANK ATA to whatever `bank_distributor_vault` account the keeper passes. Keeper always passes the real bank-distributor vault ATA — BANK never touches the bot wallet. This is what makes the distribution tax-clean. A future bin-farm upgrade could constrain the destination on-chain; for now the keeper is the only caller and this works.

**Burn curve math is pure + mirrored.** `compute_curve(current_supply, initial_supply, burn_enabled) -> (burn_ratio_ppb, protocol_skim_ppb)` in `programs/bin-farm/src/lib.rs`. TS mirror at `packages/core-sdk/burn-curve.ts`. 16 vitest cases validate reference values, invariants (sum = PPB_SCALE), monotonicity, kill switch, and edge cases. If you change one implementation, change the other + re-run tests.

**`RoverAuthority.initial_crank_supply` is immutable.** `initialize_burn_curve` errors if already set. Snapshot was taken 2026-04-13 at `1,935,388,154,207,285` raw units (1.935B CRANK). The 75% breakpoint lands at ~1,451,541,116 CRANK supply.

**Non-custodial `new_epoch` semantics.** `epoch_amount = vault.amount + total_amount_claimed − total_amount_funded`. Computed on-chain every call. If the vault is already drained by prior claims and nothing new arrived, `require!(epoch_amount > 0)` kicks in and the ix reverts — keeper catches and skips the cycle. First post-fix cycle on 2026-04-13 verified this: `delta 0 (vault=0 funded=64.4M claimed=64.4M) < 1000 — skipping`.

**Harvest enrichment via `getTransaction`.** After harvest/close, executor calls `getTransaction(txSig)` and reads `preTokenBalances`/`postTokenBalances` from the confirmed transaction metadata. Computes deltas per owner per mint. Retries up to 3 times with 2s delay — RPC indexing can lag behind confirmation.

**WSOL auto-unwrap via `unwrap_wsol_in_vault`.** On-chain instruction closes the vault's WSOL ATA → lamports return to vault PDA. Called automatically by harvest-executor after harvest/close that produces WSOL. Also called by `/withdraw SOL` before extracting native lamports. Epoch claims bundle `claim()` + `unwrap_wsol_in_vault()` in a single tx.

**SOL price from Pyth oracle.** `fetchDexScreenerPrice(SOL_MINT)` uses Pyth Hermes API (`hermes.pyth.network`) instead of DexScreener. Eliminates FOGO contamination where DexScreener labels FOGO pairs with `baseToken.address = SOL mint` but returns FOGO's price ($0.01) instead of SOL's ($81). For non-SOL tokens, DexScreener is used with stablecoin-pair preference + symbol consensus filtering.

**Token-2022 transfer hooks unsupported — defense-in-depth guards in place.** bin-farm passes `RemainingAccountsInfo::empty_hooks()` to all Meteora CPI. Tokens with transfer hooks will fail at CPI level, locking ~0.06 SOL rent per position. Guards: (1) curator.json mint whitelist in `open_fee_rovers`, (2) `hasTransferHook()` detection in keeper + `/buy` + `/sell` — rejects Token-2022 mints with hook extensions. Full hook resolution would need a bin-farm program upgrade.

**Safety poll interval: 5 seconds.** Fallback only — gRPC sub-second harvest detection confirmed working as of 2026-04-12 (measured ~180ms from activeId change to harvest execution). Safety poll runs redundantly to catch anything gRPC misses.

**Sell command auto-resolves quote token.** `/sell CRANK 25k to 35k 4000000 CRANK` detects token==quote and resolves actual quote from pool registry.

**`/withdraw` dashboard + execute.** Bare `/withdraw` shows balances + withdraw wallet + examples. `/withdraw SOL .5` or `/withdraw CRANK all` executes. No address param — sends to auto-detected deposit wallet.

**`/close` dashboard + execute.** Bare `/close` shows positions with IDs + fill bars. `/close <id>` closes one. `/close all` rage quits everything.

**Community gating mechanics (2026-04-13).** The Discord is a members-only trading floor. Four mechanics keep signal high:

- **@handle attribution in feed.** Every `harvested`/`closed` line in the feed channel renders the trader's `<@discord_id>` via `walletService.getUserIdForVault()`. `allowedMentions.parse: []` suppresses the ping (the owner already gets a DM) while leaving the handle clickable. Shipped in `notifier.ts` + `formatter.ts` + `commands/close.ts`.
- **`/leaderboard [days]`.** Top 10 by harvest volume in a rolling window (default 7d). Backed by `walletService.getLeaderboard(sinceMs)` — aggregates harvests table + open positions by vault PDA, reverse-maps to user IDs via `vaultIndex`. All mentions suppressed (public post, don't ping top 10 on every query).
- **Daily crank-role pruner (keeper step 6).** `crankPruneInactiveMembers()` strips `DISCORD_CRANK_ROLE_ID` from any registered user who (a) holds no open position AND (b) has no harvest fill in `CRANK_ROLE_PRUNE_WINDOW_DAYS` (default 7). **Grace period:** users registered within the window are treated as active — newcomers get the full window to open a position before being boot-eligible. Unregistered role-holders are always left alone (Root hands out the role manually in closed beta). No-op unless `DISCORD_CRANK_ROLE_ID`, `DISCORD_GUILD_ID`, and `DISCORD_ENABLE_MEMBER_INTENT=true` are all set — missing vars logged as `prune skipped — roleId=X guildId=Y client=Z ws=W`.
- **`#cash-out` channel gate (optional).** Set `DISCORD_CASHOUT_CHANNEL_ID`. In that channel only `/close`, `/withdraw`, `/positions`, `/balance`, `/help` dispatch; every other slash command gets an ephemeral "cash-out only" reply. Implemented as an allowlist in the `index.ts` dispatcher before the command switch.

**Pruner dry-run flag.** `CRANK_ROLE_PRUNE_DRY_RUN=true` in `bot/.env` makes the pruner log the candidate list (`prune DRY — would remove from USER#1234`) without touching roles. First production run 2026-04-13 reported `members=17 candidates=0 pruned=0` — flip to `false` only after the candidate list passes eyeballing. Every daily tick logs `prune done — members=X candidates=Y pruned=Z window=Nd dryRun=bool` regardless of mode.

**Privileged intent for pruner.** `GatewayIntentBits.GuildMembers` is gated behind `DISCORD_ENABLE_MEMBER_INTENT=true` because Discord refuses bot login if a privileged intent is requested without the matching portal toggle. To activate: enable "Server Members Intent" in the Discord developer portal, set the env var, restart. Without it, the pruner early-returns (all other commands work fine). First deploy 2026-04-13 hit this — bot wouldn't log in until the intent was gated behind the env var.

**Keeper's Discord handle.** The keeper receives the Discord client via `keeper.setDiscordClient(discordBot.client)` called in `anchor-harvest-bot.ts` right after `discordBot.start()`. Client is a public field on `DiscordBot`. `keeper.ts`' `runDailySequence` is only triggered after Discord start completes, so client is set before step 6 runs.

**$BANK metadata not yet registered.** Needs Metaplex token metadata: name, symbol, image, off-chain JSON.

## DigitalOcean / Bot deployment

**Droplet:** NYC1, s-2vcpu-4gb, Ubuntu 22.04 (+ 1GB swap)
**Domain:** `bot.crank.money` (A record on Vercel DNS)
**SSL:** Let's Encrypt via certbot (auto-renewing)

```
/root/crank-money/           — App code (rsynced)
/root/crank-money/bot/.env   — Bot environment (persists across deploys)
/root/.keys/bot-keypair.json — Bot wallet keypair (chmod 600)
```

```bash
./scripts/deploy.sh              # Deploy (reads DROPLET_IP from env or defaults)
pm2 logs crank-harvester --lines 50
curl http://localhost:8080/api/stats
```

**Bot security:** The bot keypair is the deployer/admin. Holds upgrade authority for all 6 programs + `Config.bot` fee recipient (protocol skim destination). Signs `sweep_rover`, `rover_burn_and_mint`, `wrap_burn_sol`, `open_rover_bid_position`, `drain_vault`, `sync_native`, and both `new_epoch` calls — all administrative orchestration, none take custody of reward-bound tokens. Keypair separation to cold wallet (Ledger) still planned (see `todo.md`). Even with bot-key compromise, no reward tokens can be diverted mid-flow; kill switch flipping still routes SOL to `Config.bot` (no external exfil path).

## Relay endpoints

All served via `https://bot.crank.money`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Returns 200/503 — gRPC connected, balance, last harvest/keeper timestamps |
| `GET /api/stats` | Bot health, gRPC status, position count, harvest totals, queue depth |
| `GET /api/pools` | Watched pools with activeId, binStep, mints |
| `GET /api/pools/:address` | Single pool details |
| `GET /api/positions` | Tracked positions with fill % |
| `GET /api/pending-harvests` | Positions with harvestable bins |
| `GET /api/bot-wallet` | Balance, spend rate, estimated hours remaining |
| `GET /api/fees` | Fee pipeline state (rover, burn_sol_vault, bridge vault, SOL + BANK distributor vaults) |
| `GET /api/rovers` | Rover positions by TVL |
| `GET /api/rovers/top5` | Top 5 rovers |
| `GET /api/feed` | Last 50 activity feed events |
| `GET /api/protocol-pnl` | Win rate, net PnL, per-pool breakdown, rover portfolio |
| `WSS /ws` | Real-time: activeBinChanged, harvestNeeded, harvestExecuted, positionClosed, roverTvlUpdated, feedHistory |

## Adding a new token/pool

Four things must be updated when listing a new community pair (e.g. GSD/SOL):

**1. On-chain: `add_pool` on gauge-voter**
Admin calls `add_pool(lb_pair)` with ONE representative LbPair address for the pair. This creates the PoolGauge PDA that holds the pair's vote weight. One gauge per pair — bin step pools are a routing detail, not a governance concept. Must be signed by the gauge-voter authority.

**2. `curator.json` — gauges section**
Add the pair to `"gauges"`: `"GSD": "<the same LbPair address registered on-chain>"`. This is how `/vote GSD 50` resolves to the on-chain PoolGauge. The gauge address doesn't need to be the pool users trade on — it's just the on-chain anchor for the pair's weight.

**3. `curator.json` — pools section**
Add one or more pool entries for routing (one per bin step you want to support): `id`, `label`, `address` (Meteora LbPair), `binStep`, `tokenX`/`tokenY`, `mintX`/`mintY`, `decimalsX`/`decimalsY`, `displayMode` (`price` or `mc`), `supply` (required for `mc` mode), `splitStrategy`, `maxRangePct`, `buyToken`/`quoteToken`, `example`. The router tries all pools for the pair and picks the best fit for the user's range.

**4. `KNOWN_TOKENS` in `packages/core-sdk/constants.ts`**
Add `mint_address: 'SYMBOL'`. Used by `/balance` and `/withdraw` for display. Without this, the token shows as a truncated address.

**5. Update LaserStream subscription** to watch the new LbPair address(es). Without this, the harvester won't detect bin conversions on the new pool.

**Verification checklist before adding:**
- LbPair address verified on-chain (not from frontend display)
- `binStep` read from on-chain account (offset 80, u16 LE)
- `decimalsX`/`decimalsY` read from respective mint accounts
- `mintX`/`mintY` are actual mints (not wrapped versions)
- For `mc` mode: `supply` verified against on-chain `mint.supply / 10^decimals` — write it manually, never auto-fetch. Tokens can have burned supply, minted more post-launch, or non-standard totals (CRANK is 1.9B, not 1B)
- `maxRangePct` computed: `((1 + binStep/10000)^70 - 1) * 100`
- Pool has been live >48h (new pools can have thin liquidity)

**After updating:**
- Clear pool cache or restart bot (pool registry is cached in memory)
- The pool router will automatically include the new pools in routing decisions
- Users can immediately `/buy`, `/sell`, and `/vote` using the new token symbol
- The epoch-computer aggregates fees across all bin step pools for the pair

**Removing a pool:** Remove from curator.json + LaserStream subscription. Existing open positions continue to be monitored and harvested. New positions cannot be opened on removed pools.

## Security rules

**NEVER print secrets in chat.** Generate keys directly on the server via SSH. Pipe output into files, don't read it back. Discord tokens, encryption keys, private keys — none of these should appear in conversation.

**NEVER deploy without verifying `data/` is excluded from rsync.** The wallet DB (`data/crankbot.json`) contains vault PDA mappings and position tracking. Loss = inconvenience (users re-register), NOT fund loss — all funds are on-chain in vault PDAs.

**PDA vault architecture (replaced custodial keypairs 2026-04-08):** Each user gets a UserVault PDA seeded by their real Solana wallet. No encrypted keypairs. No encryption keys. Bot is a stateless operator. Withdraw address = `vault.owner` (baked into PDA seed, immutable). Wallet DB backed up per-minute to DO Spaces (`s3://crank-backups`) as convenience — not a security-critical backup.

## Known issues

- **Token-2022 transfer hooks unsupported** — V2 CPI but hook extra accounts not resolved. Defense-in-depth guards reject hook-bearing tokens.
- **$BANK metadata missing** — no logo, no URI, looks like scam token in wallets. Blocks all community onboarding. Now urgent: after 2026-04-13 amendment, BANK actively distributes daily — holders see "unknown token" in Phantom.
- **Keypair separation still relevant** — PDA vaults solve user-side trust, and the non-custodial distribution eliminates reward-token custody, but the bot keypair still holds upgrade authority for all 6 programs + `Config.bot` skim destination. Cold wallet for admin keys still needed.
- **close_vault instruction missing** — Users can't reclaim vault PDA rent yet.
- **No `close_position` for rover positions** — `close_position` requires UserVault. Rovers use RoverAuthority. Use `close_rover_position` (added 2026-04-12).
- **Audit-v2 HIGH findings mostly still open** — see `audit-v2.md` addendum. v2-H-08 (new_epoch idempotency) mitigated by the non-custodial rewrite; v2-C-01/C-02, v2-H-01/H-02/H-03/H-04/H-05/H-06/H-07/H-09 all still open.
- **Audit-v1 program upgrades pending** — gauge-voter (M-03), bin-farm L-03 `total_positions` decrement. merkle-distributor L-04 not confirmed in the 2026-04-13 non-custodial upgrade — verify on next build.

## Program audit notes (reviewed 2026-04-01)

**epoch-vault** (`programs/epoch-vault/src/lib.rs`) — Clean. `drain_vault` uses `system_program::transfer` via `invoke_signed` with vault PDA seeds (upgraded 2026-04-09 — original direct lamport manipulation was rejected by runtime on system-owned PDAs). `destination` is unchecked — authority-gated so only the bot can drain, but it can drain to ANY address. This is intentional (bot drains to itself for WSOL wrapping).

**merkle-distributor** (`programs/merkle-distributor/src/lib.rs`) — Clean. `update_mint` added correctly — authority-gated, validates new vault ATA is owned by distributor PDA and denominated in new mint. Mint changed to WSOL on-chain (verified). The `claim()` instruction uses `transfer_checked` via `token_interface` so it works with both SPL Token and Token-2022. Cumulative accounting is sound — delta computed from `cumulative_amount - claim_status.cumulative_claimed`.

**gauge-voter** (`programs/gauge-voter/src/lib.rs`) — Solid. The ppb (parts-per-billion) math avoids overflow with u128 intermediates. Rounding dust correction on first pool is correct. Flash-loan voting is acknowledged and accepted in comments. One note: `remove_pool` closes the PoolGauge account but does NOT redistribute the removed weight to remaining pools — the weight just disappears, shrinking total below 10000 bps. Self-heals on the next `vote()` call (rounding correction forces sum back to 10000). The epoch-computer should normalize by actual sum when reading gauge weights, not assume 10000.

**bank-mint** (`programs/bank-mint/src/lib.rs`) — Clean. Supply cap invariant `bank_supply + crank_supply <= 2B` is checked on every burn_and_mint. Uses `token_interface` so both SPL Token and Token-2022 work. The PDA is sole mint authority — verified at `initialize`.

**bin-farm** (`programs/bin-farm/src/lib.rs`) — The big one (~3200 lines after 2026-04-13 amendment). `sweep_rover` is curve-driven: reads `crank_mint.supply` + `RoverAuthority.initial_crank_supply`/`burn_enabled`, computes ppb-scaled shares via `compute_curve()`, routes to three destinations. `trader_dest` constraint validates against `rover_authority.trader_dest` (points to `bridge_vault`). `burn_sol_vault` destination is seed-derived in the account context, not stored on RoverAuthority.

**bank-distributor** (`programs/bank-distributor/src/lib.rs`) — Fork of merkle-distributor at program ID `9sqcwp65…`. Non-custodial `new_epoch(root, cid)` reads `vault.amount + total_claimed − total_funded` for the epoch delta. Same `claim()` semantics. `Distributor` PDA seeds `[b"distributor"]` scoped to this program ID (not shared with the SOL distributor).

**Cross-program note:** `RoverAuthority.revenue_dest` + `pending_revenue_dest` + `revenue_dest_change_at` are LEGACY fields — unused by the curve-driven sweep_rover. Left in place for account-layout backwards compat; don't break them. `trader_dest` still points to `bridge_vault` (`B9gTfe...`). After the curve amendment, sweep_rover's SOL goes to three distinct destinations, not 40%+40% to the same account as before.

## Security audit (2026-04-01)

Full adversarial audit completed. Report: `audit.md` at repo root. 53 findings, **33 remediated** in the same session.

**What was fixed (code in repo, no deploy needed):**
- Keccak256 hash (was sha3-256 — Merkle proofs would have failed)
- Priority fee cap (500K micro-lamports/CU in executor + keeper)
- Epoch crash recovery (staged progress file, resume on restart)
- Relay auth (Bearer token on `/api/*`, set `RELAY_AUTH_TOKEN` to activate)
- WebSocket connection limit (100 max)
- Sybil-resistant epochs (equal distribution fallback removed)
- Silent catch blocks → warn-level logging
- Wallet DB permissions (0o600), sync flush on creation
- ~~Secret key buffer zeroing~~ **REVERTED** — `Keypair.fromSecretKey` in web3.js 1.98.x shares the buffer, `fill(0)` destroyed live keypairs
- DexScreener deviation guard (>50% spike rejected)
- Pyth staleness check (60s max age)
- Withdraw address lock (largest depositor, not first)
- gRPC routing (bin-farm discriminator check)
- Keeper 20hr cooldown (prevents midnight double-fire)
- nginx: localhost removed from CORS, security headers added (HSTS, X-Frame-Options, etc.)
- PM2: tsx direct (not npx), kill_timeout=10s, min_uptime=10s, death alerting
- npm deps pinned to exact versions
- Error messages sanitized (no raw logs to Discord users)
- Certbot email registration
- Key rotation: auto-updates .env, verifies before write, cleans old backups
- Byte offset startup validation (SDK cross-check)
- BigInt-native amount conversion in /buy

**What needed server action (now activated):**
- ~~`RELAY_AUTH_TOKEN` in bot/.env~~ — DONE 2026-04-11. All `/api/*` endpoints gated.
- ~~`/root/.keys/backup.key`~~ — DONE 2026-04-10. Backup encryption key generated.
- ~~Re-provision droplet or manual user migration (service user)~~ deferred — deploy script reverted to `root`

**What needs program upgrade (code is ready, requires `anchor build` + deploy):**
- gauge-voter: owner check on remaining_accounts (M-03)
- bin-farm: total_positions decrement on close (L-03)
- merkle-distributor: old vault drain check before update_mint (L-04)

**What remains open (see `audit.md` for details):**
- C-02: Keypair separation (architecture — needs Ledger)
- H-01: Token-2022 transfer hooks on-chain guard (program upgrade)
- H-10: gRPC trust model (inherent to Helius endpoint)
- M-01, M-02, M-04, L-01, L-02, L-05, L-06: on-chain changes (various)
- M-09: Jupiter swap validation (code disabled)
- I-01 through I-08: accepted informational items

## Critical runtime notes

**Anchor methods require BN, not BigInt.** `@coral-xyz/borsh` calls `.toArrayLike()` which exists on `BN` but not native `bigint`. Always use `new BN(amount.toString())` for Anchor method args.

**`getTransaction` lags behind confirmation.** After `.rpc()` confirms, the RPC node may not have indexed the tx data yet. Always retry `getTransaction` (3 attempts, 2s delay).

**PDA vault: no user keypairs anywhere.** `wallet-service.ts` has no encryption, no `getOrCreate()`, no keypair generation. `signer.ts` only takes bot keypair. All user operations go through on-chain vault instructions.

**SBF build requires rustup cargo.** Homebrew cargo doesn't support `+toolchain` syntax. Use: `PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml`

## Current state (2026-04-13)

- **Capture the Bag amendment live on mainnet** — curve-driven sweep_rover + 50 bps fee + bank-distributor program + 6 new bin-farm instructions (`set_fee_bps`, `initialize_burn_curve`, `set_burn_enabled`, `wrap_burn_sol`, `open_rover_bid_position`, `rover_burn_and_mint`). Snapshot: `initial_crank_supply = 1,935,388,154,207,285`, `burn_enabled = true`. Full magnesium phase (100% burn, 0% protocol skim).
- **Non-custodial distribution shipped same day** — `new_epoch` on both distributors rewritten to read `vault.amount + total_claimed − total_funded` on-chain. No `funder_ata`, no `transfer_checked`. Reward tokens never touch operator keypair. Applies to BANK + SOL pipelines.
- **First BANK epoch fired** — 64.4M BANK distributed to the lone harvester (Root) and claimed to his vault PDA. Tree pinned at IPFS `QmUThu8fbAPJGrzLJjbkBY58S5SBs8wgQmRiMXxL1iVyFZ`.
- **PDA vault migration** — All 6 programs upgraded on mainnet. Non-custodial UserVault PDAs. Bot is stateless operator. 9 `deduct_gas` sites.
- **Gas model active:** 125,000 lamports/op. Bot self-sustaining via `Config.bot` skim destination.
- **All ops items set:** PINATA_JWT, gas_lamports, RELAY_AUTH_TOKEN on droplet.
- **API locked down:** Bearer token on all `/api/*` except `/api/health`.
- **Discord bot live** — `crankbot#8555`, 13 slash commands, feed channel `#crank-feed`. `/burn` now supports `/burn status` sub-mode (reads curve state). `/start` auto-creates vault's CRANK ATA (Token-2022). Minimum vault SOL UX copy: 0.1 SOL (bumped from 0.05 on 2026-04-14 — wide-range splits can need ~0.05 SOL refundable rent).
- **Silent tx-failure class eliminated (2026-04-14)** — `confirmTransaction` only throws on confirmation timeout, not on-chain execution errors; failed txs were posting "deposited" to the feed with a Solscan link. Migrated 7 call sites to `confirmAndCheck` (`buy.ts` ×2, `close.ts`, `bot/harvest-executor.ts` ×2, `bot/keeper.ts` ×2). Precise pre-flight added to `/buy` + `/sell`: `positions × (rent + gas) + buffer + SOL deposit` plus vault token-balance check for sells. `deploy.sh` liveness check switched from Bearer-gated `/api/stats` to `/api/health` (accepts 200 or 503). Geyser `connected` flag now fires on `subscribe()` resolve — previously set only inside `onData`, so `/api/health` reported unhealthy forever when the protocol was quiet + 0 positions.
- **Community gating shipped (2026-04-13)** — @handle attribution on every feed post, `/leaderboard`, crank-role pruner (keeper step 8), optional `#cash-out` allowlist.
- **Harvester running** — gRPC connected, daily keeper sequence (8 steps), relay on :8080.
- **Droplet** — s-2vcpu-4gb NYC1, 1GB swap, fail2ban, SSH key-only, UFW, nginx rate limiting.
- **gRPC live on `helius-laserstream` SDK** — sub-second harvest detection (~180ms) confirmed.
- **Tests:** 43/43 vitest passing + 16 new burn-curve tests.

## Next priorities

See `todo.md` for full list. Key items:

1. **$BANK metadata** — Register Metaplex token metadata. Now urgent — BANK is actively distributing.
2. **Audit-v2 HIGH follow-ups** — `/start` signature proof (v2-C-01), `update_gas_lamports` cap + timelock (v2-H-01), `wrap_sol_in_vault` destination check (v2-H-02), `harvest_bins` keeper-tip gating (v2-H-03), Bearer auth hardening (v2-H-06), `/ws` auth (v2-H-07).
3. **Keypair separation (C-02)** — still valid; cold wallet for upgrade authorities.
4. **Build `/stats` + `#crank-stats`** — Operational analytics.
5. **GSD community onboard** — First real community. Quiet, one-at-a-time approach.
