# claude.md — crank.money codebase context

## RULES

**Read the full logs, don't grep.** When something happens on the bot, dump the log window and read it. Grepping for an expected keyword misses what's actually there.

```bash
ssh -i ~/.ssh/id_ed25519_deploy root@159.223.133.9 'cat /root/.pm2/logs/crank-harvester-out.log' | grep 'HH:MM'
```

Key log patterns:
- `"Harvest submitted: N bins from XXXX"` — partial harvest
- `"Closed XXXX"` — full close (position PDA prefix, capital C)
- `"[executor] XXXX Sell ALL N bins → CLOSE"` / `"→ HARVEST"` — gRPC trigger
- `"[safety] …"` — 5-sec fallback poll
- `"[geyser] Connected. Watching N pools"` — gRPC live

**When Root says something happened, it happened.** Read logs to find HOW, not WHETHER.

**Never print secrets.** SSH-generate keys on the server, pipe into files, don't echo.

**Don't touch the droplet user config.** Service-user conversion broke ops access before. Bot runs as root; stateless-operator model bounds the blast radius.

**Never let rsync delete `data/`.** Wallet DB loss = user inconvenience (re-register), not fund loss — funds are on-chain in PDA vaults. `deploy.sh` already excludes it; verify before editing.

## What the protocol does

Wraps Meteora DLMM positions. User sets a range; bins act as limit orders. Price crosses → bin converts → bot harvests the yield into the user's vault.

- **Sell the rips:** token deposited above price → SOL out.
- **Buy the dips:** SOL deposited below price → token out.

**Fee:** 50 bps on converted output only. Zero on deposit. LP fees claimable for free.

**Custody:** each user gets a `UserVault` PDA seeded by `[b"user_vault", owner_wallet]`. Funds live on-chain in the vault; bot is a stateless operator. Withdrawals enforced to `vault.owner` by seed derivation. Server wipe loses zero user funds.

**Distribution:** non-custodial. `sweep_rover` splits SOL via on-chain burn curve (burn → bids → BANK mint; trader share → distributor; protocol skim → Config.bot). Daily Merkle trees (SOL + BANK) pre-funded by program flows; `new_epoch(root, cid)` publishes root only, computes delta on-chain. Reward tokens never touch the operator keypair between mint and claim.

## Programs

| Program | ID |
|---------|------|
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

## PDA seeds

| PDA | Seeds | Program |
|-----|-------|---------|
| Config | `[b"config"]` | bin-farm |
| UserVault | `[b"user_vault", owner_wallet]` | bin-farm |
| PositionCounter | `[b"pos_counter", user_vault, lb_pair]` | bin-farm |
| MeteoraPosition | `[b"meteora_pos", user_vault, lb_pair, count]` | bin-farm |
| Position | `[b"position", meteora_position]` | bin-farm |
| Vault (per-position) | `[b"vault", meteora_position]` | bin-farm |
| RoverAuthority | `[b"rover_authority"]` | bin-farm |
| BurnSolVault | `[b"burn_sol_vault"]` | bin-farm |
| BankConfig | `[b"bank_config"]` | bank-mint |
| GaugeConfig / PoolGauge | `[b"gauge_config"]` / `[b"pool_gauge", lb_pair]` | gauge-voter |
| Distributor / ClaimStatus | `[b"distributor"]` / `[b"claim_status", distributor, claimant]` | merkle + bank distributors |
| BridgeConfig / BridgeVault | `[b"bridge_config"]` / `[b"bridge_vault"]` | epoch-vault |

## File map

```
programs/                              — 6 anchor programs
  bin-farm/src/lib.rs                  — positions, harvest, close, rovers, curve-driven sweep
  bin-farm/src/meteora_dlmm_cpi.rs     — CPI module (V2 only)
  bank-mint/src/lib.rs                 — burn CRANK → mint BANK 1:1
  gauge-voter/src/lib.rs               — pool-weight voting
  merkle-distributor/src/lib.rs        — SOL/WSOL cumulative Merkle claims
  bank-distributor/src/lib.rs          — BANK cumulative Merkle claims (fork of merkle-distributor)
  epoch-vault/src/lib.rs               — SOL fee accumulator + drain_vault

bot/                                   — off-chain harvester
  anchor-harvest-bot.ts                — orchestrator, health :8080
  geyser-subscriber.ts                 — Helius LaserStream gRPC
  harvest-executor.ts                  — job queue, dust filter, Token-2022 aware
  keeper.ts                            — daily 8-step sequence
  epoch-computer.ts                    — daily SOL + BANK Merkle publish
  relay-server.ts                      — REST + WebSocket (all Bearer-gated except /api/health)
  alerter.ts, logger.ts, retry.ts, meteora-accounts.ts

packages/
  core-sdk/                            — shared constants, PDAs, math, burn-curve TS mirror,
                                         pool-config, price-source, jup-quote, wallet-service,
                                         transactions
  discord-bot/                         — 13 slash commands, role-service, notifier, formatter

scripts/                               — deploy, preflight, client gen, emergency close,
                                         unwrap-stuck-wsol, test-epoch, init-burn-curve

tools/
  depth.ts                             — ASCII depth chart
  protocol-lp/                         — protocol-owned LP (separate droplet)

runbooks/                              — droplet-recovery.md, keypair-separation.md
curator.json                           — pool registry + gauge map
Anchor.toml                            — 6 programs, mainnet cluster
capturethebag.md                       — 2026-04-13 amendment ship log
todo.md                                — open + roadmap only (shipped items live here)
```

## Key instructions (bin-farm surface)

**User-facing:** `create_vault`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`, `withdraw_sol`, `withdraw_token`, `vault_burn_and_mint`, `vault_vote`, `update_gas_lamports` (admin-capped), `open_position_v2` (takes `rent_lamports`), `harvest_bins`, `close_position` (auto), `user_close`, `claim_fees`.

**Protocol:** `sweep_rover` (curve-driven, permissionless), `wrap_burn_sol` + `open_rover_bid_position` (bot-gated), `rover_burn_and_mint` (bot-gated, destination caller-supplied), `open_fee_rover`, `close_rover_position`, `close_rover_token_account`.

**Admin:** `set_fee_bps`, `initialize_burn_curve` (one-shot), `set_burn_enabled` (kill switch).

**External:** `bank-mint.burn_and_mint`, `gauge-voter.vote`, `merkle/bank-distributor.new_epoch(root, cid)` (publishes root only), `merkle/bank-distributor.claim`, `epoch-vault.drain_vault`.

## Critical runtime gotchas

**SBF build.** Homebrew cargo doesn't support `+toolchain`. Use `PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor build -p bin_farm`.

**`Box<>` wrappers are required.** Don't remove them from `InterfaceAccount` / `Account` fields in bin-farm — BPF 4KB stack overflow.

**Anchor methods need BN, not BigInt.** `new BN(amount.toString())` for every Anchor arg.

**`getTransaction` lags confirmation.** Retry 3× with 2s delay.

**WSOL must always be unwrapped after use.** Any path that touches WSOL needs `unwrap_wsol_in_vault` at the end (harvest, close, /withdraw SOL, /buy leftover). Missing this strands WSOL invisible to `/balance`. Recovery: `scripts/unwrap-stuck-wsol.ts`.

**`wrap_burn_sol` must be followed by `sync_native` in the same tx.** Can't combine into one ix (balance-mismatch at runtime).

**Gas model.** Bot is sole signer + fee payer. 9 user-facing instructions call `deduct_gas` which pulls `config.gas_lamports` from the vault PDA to the bot. Capped on-chain at `MAX_GAS_LAMPORTS = 0.01 SOL` (`lib.rs:2608`). `open_position_v2` also pulls `rent_lamports` (bot-computed, capped at `MAX_RENT_DEDUCT_LAMPORTS = 0.2 SOL`). Closes refund Meteora rent to the vault, not the bot.

**`harvest_bins` dust gate.** Gas deducted only when `is_authorized_bot && had_yield` (`lib.rs:724`). Permissionless keepers get `keeper_tip_bps` from fees; zero-yield calls don't charge the vault.

**Burn curve is pure + mirrored.** `compute_curve` in `programs/bin-farm/src/lib.rs`; TS mirror in `packages/core-sdk/burn-curve.ts`. 16 vitest cases. Change one, change the other + re-run.

**`RoverAuthority.initial_crank_supply` is immutable.** Snapshotted 2026-04-13 at `1,935,388,154,207,285` raw (1.935B CRANK). 75% breakpoint = ~1,451,541,116 CRANK supply.

**`RoverAuthority.revenue_dest`/`pending_revenue_dest`/`revenue_dest_change_at` are legacy.** Unused post-curve. Left for account-layout backwards compat — don't break them.

**Token-2022 transfer hooks unsupported.** CPI passes `empty_hooks()`. Bot rejects hook-bearing mints via `hasTransferHook()` in keeper + /buy + /sell. `open_fee_rovers` uses curator.json whitelist.

**Non-custodial `new_epoch` semantics.** `epoch_amount = vault.amount + total_claimed − total_funded`. If nothing new arrived, `require!(epoch_amount > 0)` reverts — keeper catches and skips.

**SOL price from Pyth.** `fetchDexScreenerPrice(SOL_MINT)` routes to Pyth Hermes, not DexScreener (FOGO contamination). Other tokens use DexScreener with stablecoin-pair preference.

**`binIdToBinArrayIndex` uses `Math.trunc`.** Not `Math.floor`. Negative bin IDs otherwise mismatch on-chain PDAs. Fixed in `pda.ts`.

## Deployment

Droplet: NYC1, s-2vcpu-4gb Ubuntu 22.04 + 1GB swap. Domain `bot.crank.money`, Let's Encrypt SSL.

```
/root/crank-money/                    — rsynced app code
/root/crank-money/bot/.env            — persists across deploys
/root/.keys/bot-keypair.json          — bot wallet, chmod 600
/root/.keys/backup.key                — wallet DB encryption key
```

```bash
./scripts/deploy.sh                   # rsync + npm install + PM2 restart + health check
pm2 logs crank-harvester --lines 50
curl -H "Authorization: Bearer $RELAY_AUTH_TOKEN" http://localhost:8080/api/stats
```

Wallet DB → `s3://crank-backups/` every minute (`flock`). Restore path verified end-to-end; decrypt with `openssl -aes-256-cbc -pbkdf2`. Details in `runbooks/droplet-recovery.md`.

## Bot security

The bot keypair holds upgrade authority for all 6 programs + `Config.bot` (skim destination). Signs admin orchestration but never takes custody of reward tokens. Keypair separation to cold wallet (Ledger) is planned — runbook at `runbooks/keypair-separation.md`, blocked on hardware.

Relay is Bearer-gated fail-closed (`RELAY_AUTH_TOKEN` required at `attach()`, `timingSafeEqual` on compare). WebSocket `/ws` requires Bearer via Authorization header or `?token=` query (browser fallback).

## Relay endpoints

All `https://bot.crank.money/api/*` require Bearer except `/api/health`. Key ones: `/api/stats`, `/api/pools`, `/api/positions`, `/api/pending-harvests`, `/api/bot-wallet`, `/api/fees`, `/api/rovers`, `/api/feed`, `/api/protocol-pnl`. WebSocket at `/ws`.

## Current state (2026-04-17)

**On-chain (mainnet live):**
- Capture-the-Bag amendment (2026-04-13): 50 bps fee, curve-driven `sweep_rover`, bank-distributor program, `set_fee_bps` / `initialize_burn_curve` / `set_burn_enabled` / `wrap_burn_sol` / `open_rover_bid_position` / `rover_burn_and_mint` instructions. Full magnesium phase (100% burn, 0% protocol skim).
- Non-custodial distribution: both `new_epoch`s read `vault.amount + total_claimed − total_funded` on-chain.
- PDA vault migration (2026-04-08): 6 programs upgraded, 9 `deduct_gas` sites.
- Rent passthrough (2026-04-15, canary verified 2026-04-17): `open_position_v2` takes `rent_lamports` up to 0.2 SOL; closes refund Meteora rent to vault.
- Audit-v2 HIGH sweep (2026-04-17): v2-H-02 (`vault_wsol_ata` constrained, `lib.rs:3689, 3714`), v2-H-03 (`harvest_bins` gas gate, `lib.rs:724`), v2-H-06 + v2-H-07 (relay + WS auth), v2-H-09 (`apply-emergency-close.ts` fixed).
- Audit-v1 carryover sweep (2026-04-17): gauge-voter M-03 deployed (owner check on `remaining_accounts` in `vote()`, `gauge-voter/src/lib.rs:157`), bin-farm L-03 `total_positions` decrements verified on all 3 close paths + rover close, merkle-distributor L-04 drain check confirmed live.
- Gas cap: `MAX_GAS_LAMPORTS = 0.01 SOL` (`lib.rs:2608`).

**Off-chain (bot live):**
- Harvester: gRPC connected (~180ms bin-change → harvest), 8-step daily keeper.
- Analytics: `/stats scope:me|all` + USD-freeze at harvest/close time + initial `/buy` USD tracking + JUP baseline-flex on full conversion + tweet-draft mirror to ops channel + daily `#crank-stats` post (keeper step 8) + dynamic supply refresh (keeper step 7).
- `MIN_HARVEST_USD = 0.25` dust filter. Closes always proceed.
- `/leaderboard token:SYM` filter + rank stripe; volume column stripped.
- Auto-grant crank role on first `/buy`/`/sell`. Pruner live (`CRANK_ROLE_PRUNE_DRY_RUN=false` on droplet).
- Bot code dedup: `withRetry` shared at `bot/retry.ts` with optional `baseDelayMs`.
- Triton yellowstone-grpc removed from deps.
- `~/crank-crm/.env` has `RELAY_AUTH_TOKEN`.
- 43/43 vitest + 16 burn-curve tests passing.

**Ops:**
- Wallet DB backup cron verified; restore path verified.
- Runbooks: `droplet-recovery.md`, `keypair-separation.md` (blocked on Ledger).

## Known issues

- **$BANK metadata missing** — no logo, URI, or Metaplex registration. BANK distributes daily → holders see "unknown token" in Phantom. Blocked on Root creating the logo.
- **Keypair separation open** — bot key still holds upgrade authority + skim destination. Blocked on Ledger. Runbook at `runbooks/keypair-separation.md`.
- **Token-2022 transfer hooks** — unsupported. Defense-in-depth rejects hook-bearing mints.
- **X tweet auto-submit** — manual copy/paste for now. Wire to crank-crm drafter later.
- **Audit-v2 residual:** v2-H-04 (DB restore operational discipline) open. See `audit-v2.md`.

## Next priorities

1. **$BANK metadata** — waiting on logo.
2. **Keypair separation** — waiting on Ledger.
3. **First real community onboard** — analytics + baseline flex now give real numbers to pitch with.
4. **Roadmap builds:** Telegram adapter, Crankbot Envoy.

See `todo.md` for open work. `audit-v2.md` + `auditv1.md` for security dispositions. `runbooks/` for operational procedures.
