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

**Operating thesis:** post-2026-04-28 pivot, crank is the execution layer for cross-venue funding-rate arb. See `pivot.md` for canonical thesis and 4-wallet hopper topology. The bin-farm core is the spot leg; the perp leg (Hyperliquid) and hopper wallet build are in flight, not yet shipped.

## Programs

| Program | ID |
|---------|------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK (retired) | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |

$BANK token is retired with the pivot — no further mints. Existing holders can still hold/transfer; user vaults may still hold residual BANK that can be withdrawn via `/withdraw`.

## PDA seeds (bin-farm only)

| PDA | Seeds |
|-----|-------|
| Config | `[b"config"]` |
| UserVault | `[b"user_vault", owner_wallet]` |
| PositionCounter | `[b"pos_counter", user_vault, lb_pair]` |
| MeteoraPosition | `[b"meteora_pos", user_vault, lb_pair, count]` |
| Position | `[b"position", meteora_position]` |
| Vault (per-position) | `[b"vault", meteora_position]` |
| RoverAuthority | `[b"rover_authority"]` |
| BurnSolVault | `[b"burn_sol_vault"]` |

`RoverAuthority` and `BurnSolVault` are part of the curve-sweep machinery slated for retirement in the follow-up bin-farm cleanup upgrade. Listed for current state, not as load-bearing surface.

## File map

```
programs/
  bin-farm/src/lib.rs                  — positions, harvest, close, rovers, curve-driven sweep
  bin-farm/src/meteora_dlmm_cpi.rs     — CPI module (V2 only)

bot/
  anchor-harvest-bot.ts                — orchestrator, health :8080
  geyser-subscriber.ts                 — Helius LaserStream gRPC (Alchemy migration in flight)
  harvest-executor.ts                  — job queue, dust filter, Token-2022 aware
  keeper.ts                            — daily 7-step sequence
  relay-server.ts                      — REST + WebSocket (all Bearer-gated except /api/health)
  alerter.ts, logger.ts, retry.ts, meteora-accounts.ts

packages/
  core-sdk/                            — shared constants, PDAs, math, pool-config,
                                         price-source, jup-quote, wallet-service, transactions
  discord-bot/                         — slash commands, role-service, notifier, formatter

scripts/                               — deploy, preflight, client gen, emergency close,
                                         unwrap-stuck-wsol, test-laserstream
tools/
  depth.ts                             — ASCII depth chart
  protocol-lp/                         — protocol-owned LP harvester (per-wallet droplet instances
                                         post-pivot — W-Buy / W-Sell)

runbooks/                              — droplet-recovery.md, keypair-separation.md
curator.json                           — pool registry
Anchor.toml                            — bin-farm only, mainnet cluster
pivot.md                               — operating thesis + hopper topology
conversion.md                          — Helius → Alchemy gRPC migration prep
```

## Key instructions (bin-farm surface)

**User-facing:** `create_vault`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`, `withdraw_sol`, `withdraw_token`, `update_gas_lamports` (admin-capped), `open_position_v2` (takes `rent_lamports`), `harvest_bins`, `close_position` (auto), `user_close`, `claim_fees`.

**Protocol (curve-sweep — slated for retirement):** `sweep_rover` (curve-driven, permissionless), `wrap_burn_sol`, `open_rover_bid_position`, `rover_burn_and_mint`, `open_fee_rover`, `close_rover_position`, `close_rover_token_account`. The `*_burn_*` and `rover_burn_and_mint` instructions CPI into the now-retired bank-mint program; they will runtime-revert once bank-mint is closed on-chain. Stripping them out is part of the bin-farm cleanup upgrade ticket.

**Admin:** `set_fee_bps`, `initialize_burn_curve` (one-shot, already executed), `set_burn_enabled` (kill switch).

**Dead-coupled (will revert post-program-close):** `vault_burn_and_mint` (→ bank-mint), `rover_burn_and_mint` (→ bank-mint), `vault_vote` (→ gauge-voter). Strip in the bin-farm cleanup upgrade.

## Critical runtime gotchas

**SBF build.** Homebrew cargo doesn't support `+toolchain`. Use `PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor build -p bin_farm`.

**`Box<>` wrappers are required.** Don't remove them from `InterfaceAccount` / `Account` fields in bin-farm — BPF 4KB stack overflow.

**Anchor methods need BN, not BigInt.** `new BN(amount.toString())` for every Anchor arg.

**`getTransaction` lags confirmation.** Retry 3× with 2s delay.

**WSOL must always be unwrapped after use.** Any path that touches WSOL needs `unwrap_wsol_in_vault` at the end (harvest, close, /withdraw SOL, /buy leftover). Missing this strands WSOL invisible to `/balance`. Recovery: `scripts/unwrap-stuck-wsol.ts`.

**`wrap_burn_sol` must be followed by `sync_native` in the same tx.** Can't combine into one ix (balance-mismatch at runtime). Caller-side concern; the on-chain instruction itself is being retired.

**Gas model.** Bot is sole signer + fee payer. 9 user-facing instructions call `deduct_gas` which pulls `config.gas_lamports` from the vault PDA to the bot. Capped on-chain at `MAX_GAS_LAMPORTS = 0.01 SOL` (`lib.rs:2608`). `open_position_v2` also pulls `rent_lamports` (bot-computed, capped at `MAX_RENT_DEDUCT_LAMPORTS = 0.2 SOL`). Closes refund Meteora rent to the vault, not the bot.

**`harvest_bins` dust gate.** Gas deducted only when `is_authorized_bot && had_yield` (`lib.rs:724`). Permissionless keepers get `keeper_tip_bps` from fees; zero-yield calls don't charge the vault.

**Token-2022 transfer hooks unsupported.** CPI passes `empty_hooks()`. Bot rejects hook-bearing mints via `hasTransferHook()` in `/buy` + `/sell`. `open_fee_rovers` uses curator.json whitelist.

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

**Do NOT deploy from the `pivot-demolition` branch** until the on-chain vault drain + program close ticket has run. Deploying mid-flight would lose the keeper's dead-step orchestration while user funds still sit in the distributor vaults.

Wallet DB → `s3://crank-backups/` every minute (`flock`). Restore path verified end-to-end; decrypt with `openssl -aes-256-cbc -pbkdf2`. Details in `runbooks/droplet-recovery.md`.

## Bot security

The bot keypair holds upgrade authority for bin-farm + `Config.bot` (skim destination). Signs admin orchestration but never custodies user funds. Keypair separation to cold wallet (Ledger) is planned — runbook at `runbooks/keypair-separation.md`, blocked on hardware. Per-wallet keypair separation for the new hopper topology (W-Buy / W-Sell / Treasury / Hopper) converges on the same hardware story.

Relay is Bearer-gated fail-closed (`RELAY_AUTH_TOKEN` required at `attach()`, `timingSafeEqual` on compare). WebSocket `/ws` requires Bearer via Authorization header or `?token=` query (browser fallback).

## Relay endpoints

All `https://bot.crank.money/api/*` require Bearer except `/api/health`. Surviving routes: `/api/stats`, `/api/pools`, `/api/positions`, `/api/pending-harvests`, `/api/bot-wallet`, `/api/rovers`, `/api/feed`, `/api/protocol-pnl`. WebSocket at `/ws`. (`/api/fees` retired with the pivot demolition.)

## Retired (2026-04-28 pivot)

The following programs and machinery were stripped from the codebase. Programs remain deployed on mainnet pending a separate vault-drain + `solana program close` operation.

**On-chain programs (still deployed, slated for close):**
- `bank-mint` — burn CRANK → mint BANK 1:1.
- `merkle-distributor` — SOL/WSOL cumulative Merkle claims.
- `bank-distributor` — BANK cumulative Merkle claims.
- `gauge-voter` — pool-weight voting.
- `epoch-vault` — SOL fee accumulator + drain_vault.

**Off-chain (deleted from repo):**
- `bot/epoch-computer.ts` — daily SOL+BANK Merkle tree publisher.
- `packages/core-sdk/burn-curve.ts` + 16 vitest cases.
- `packages/discord-bot/src/commands/{vote,burn}.ts`.
- `scripts/{init-burn-curve,test-epoch}.ts`.
- All IDLs + Codama-generated clients for the 5 retired programs.
- `BANK_MINT_PROGRAM_ID`, `GAUGE_VOTER_PROGRAM_ID`, `MERKLE_DISTRIBUTOR_PROGRAM_ID`, `BANK_DISTRIBUTOR_PROGRAM_ID`, `EPOCH_VAULT_PROGRAM_ID` constants.
- All gauge / claim / curve / distributor PDA helpers.
- Keeper steps for `new_epoch`, `crankRoverBurnAndMint`, `crankOpenRoverBids`, `crankEpochDistribution`, `detectEpochMiss`.
- `alertEpochMiss`, `alertEpochSuccess`, `alertEntitlementDrift`.

See git history for full diff.

## Pivot surface (in flight, not yet built)

- **Hopper wallet topology** — A / Hopper / W-Buy / W-Sell / Treasury / Personal. Per-wallet protocol-lp harvester instances on a droplet. Weekly Hopper sweep cron, 40/40/20 split (W-Buy / Treasury / Personal). Pumpswap LP fees bypass Hopper → direct to Personal. See `pivot.md`.
- **Bin-farm cleanup upgrade** — strip 3 dead-coupled instructions + 2 program ID constants + dead RoverAuthority fields + curve-sweep machinery. Deploy + client regen + bot redeploy.
- **On-chain vault drain + 5-program close** — drain SOL distributor vault, BANK distributor vault, epoch-vault `bridge_vault` to a treasury wallet first. Then `solana program close` x5. Recovers ~25 SOL rent.
- **Hyperliquid perp leg** — short side of the delta-neutral pair. Pre-set squeeze closes.
- **Per-tribe pool funnels** — zerebro, lighter, anthropic, griffain, pump, fartcoin pool configs in `curator.json` + Discord-bot UX.
- **Alchemy gRPC migration** — see `conversion.md`. 90-day Alchemy trial active.
- **Public dashboard** — 6 wallet balances + Hopper-pending + deployed-strategies pane.

## Known issues

- **Keypair separation open** — bot key still holds upgrade authority + skim destination. Blocked on Ledger. Runbook at `runbooks/keypair-separation.md`. More important post-pivot under hopper topology.
- **Token-2022 transfer hooks** — unsupported. Defense-in-depth rejects hook-bearing mints.
- **X tweet auto-submit** — manual copy/paste for now. Wire to crank-crm drafter later.
- **5 retired programs still deployed on mainnet.** Holding rent + still-active CPIs from bin-farm. Resolved by vault drain + program close + bin-farm cleanup upgrade.

## Next priorities

1. **Vault drain + program close** — gated on accurate on-chain balance check for SOL distributor + BANK distributor + bridge_vault. Irreversible once executed.
2. **Bin-farm cleanup upgrade** — strip dead instructions/constants/fields. See `~/.claude/plans/no-i-am-feeling-compiled-whisper.md` §10.
3. **Hopper topology build** — wallets + protocol-lp droplet instances + sweep cron + dashboard pane.
4. **Alchemy gRPC migration** — single-file swap per `conversion.md`.
5. **Per-tribe funnels + Hyperliquid perp leg** — product surface from `pivot.md`.

See `pivot.md` for canonical thesis. `runbooks/` for operational procedures.
