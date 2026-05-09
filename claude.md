# claude.md — crank.money codebase context

## Rules

- **Read full logs, don't grep.** Dump the window. Grepping for an expected keyword misses what's actually there.
- **When Root says something happened, it happened.** Read logs to find HOW, not WHETHER.
- **Never print secrets.** SSH-generate keys on the server; pipe into files; don't echo.
- **Don't touch the droplet user config.** Service-user conversion broke ops access before. Bot runs as root; stateless-operator model bounds blast radius.
- **Never let rsync delete `data/`.** Wallet DB loss = user re-register, not fund loss (funds on-chain in PDA vaults). `deploy.sh` excludes it; verify before editing.

## What the protocol does

Bin-farm wraps Meteora DLMM positions. User sets a range; bins act as limit orders. Price crosses → bin converts → bot harvests yield into the user's PDA vault.

- **Sell the rips:** token deposited above price → SOL out.
- **Buy the dips:** SOL deposited below price → token out.

**Fees:**
- **bin-farm exec fee** — 1% on converted output (was 50 bps, raised 2026-05-08). Zero on deposit. LP fees claimable for free. Routes to HopperVault → 4-way sweep (25/25/25/25 treasury/admin/ops/tax).
- **bin-farm settle** — on treasury-matched closes (Path B): 25% proposer / 25% tax reserve / 50% treasury. Caps: `payout_bps + tax_bps ≤ 5000`.

**Custody:** each user gets a `UserVault` PDA seeded by `[b"user_vault", owner_wallet]`. Funds on-chain. Withdrawals enforced to `vault.owner` by seed derivation. Server wipe loses zero user funds.

**Treasury matching (Path B):** spot leg copy-trades user buys into a parallel NTP-owned position via SPL Governance. The `proposal-whitelist-addin` returns voter weight 0 for any proposal whose inner ixs aren't on the whitelist — so a compromised bot cannot author a drain proposal. Whitelist: `treasury_open_position`, `treasury_user_close`, `record_settle_meta`, `settle_proposer`, `close_settle`, `harvest_bins`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`, SPL Memo. Council side ungated (HW wallet for upgrades/withdrawals).

**Operating thesis:** crank is the execution layer for cross-venue funding-rate arb. Spot leg is the bin-farm DLMM. Perp leg (Hyperliquid) is in flight, not built. Protocol revenue routes on-chain via the Hopper program.

## Programs

| Program | ID |
|---------|------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| hopper (routing) | `2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF` |
| proposal-whitelist-addin | `9Tpa3wZwm21yPFvZtDQYnJic5UGKPNQKqQqCiC6tkUnv` (devnet only — mainnet pending) |

Upgrade authority on bin-farm + hopper: `FFwqCuYTw7DFWWRQD3tYcPBPpmaAQjT1JV5kqG15QPsL` (admin wallet). Migration to HW wallet `DPr9NDewhqDMY58fpAZSBqjTfDYm9N8NKjP2o2RZLU9A` deferred — see `HANDOFF.md`. Bot keypair is `Config.bot` (signer + fee payer + ops-leg fee dest), distinct from upgrade authority.

## Tokens

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK (retired) | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 |

$BANK no further mints. Existing holders can hold/transfer; user vaults may hold residual BANK withdrawable via `/withdraw token`.

## PDA seeds

**bin-farm:**
- `Config` — `[b"config"]`
- `UserVault` — `[b"user_vault", owner_wallet]`
- `PositionCounter` — `[b"pos_counter", user_vault, lb_pair]`
- `MeteoraPosition` — `[b"meteora_pos", user_vault, lb_pair, count]`
- `Position` — `[b"position", meteora_position]`
- `Vault` (per-position) — `[b"vault", meteora_position]`
- `PositionSettle` — `[b"position_settle", position]`

**hopper:**
- `RoutingConfig` — `[b"routing_config"]` (current mainnet value: `6VvNCC7kGYGGTAQCBamt7UoBRvxaenwprBcWkzjz7xZ9`; **post-v2-deploy will change** if hopper is keypair-rotated — see HANDOFF)
- `HopperVault` — `[b"hopper_vault"]` (current mainnet value: `4bugEHcAr1F6bg39nu26M3steAGwGAdtGzq3iwYjWs1b`) — receives all `harvest_bins.fee_taken`
- `TokenRoute` — `[b"token_route", mint]`

**proposal-whitelist-addin:**
- `Registrar` — `[b"registrar", realm, governing_token_mint]`
- `VoterWeightRecord` — `[b"voter_weight_record", realm, governing_token_mint, governing_token_owner]`

## bin-farm instruction surface

**User-facing (Path A):** `create_vault`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`, `withdraw_sol`, `withdraw_token`, `open_position_v2` (takes `rent_lamports`), `harvest_bins`, `close_position`, `user_close`, `claim_fees`.

**Treasury (Path B, governance-only):** `treasury_open_position`, `treasury_user_close`, `record_settle_meta`, `settle_proposer`, `close_settle`. Caller checks pinned to NTP — direct bot calls revert. Once `Config.native_treasury_pda` is set, the user-facing path also reverts when invoked against the NTP-owned UserVault, sealing the addin gate.

**Admin:** `set_fee_bps`, `set_fee_dest` (retargets `Config.fee_dest`), `set_native_treasury_pda` (one-shot), `init_payout_config` / `update_payout_config` / `set_payout_admin`, `set_tax_config(tax_bps, tax_reserve)`, `expand_config_v2` (one-shot V1→V2 realloc), `update_bot`, `update_keeper_tip_bps`, `update_priority_slots`, `update_gas_lamports`, `transfer_authority`/`accept_authority`, `pause`/`unpause`, `bot_pause`/`bot_unpause`, `propose_emergency_close`/`apply_emergency_close`.

`Config.fee_dest` currently = HopperVault PDA. Bot resolves at startup and falls back to `Config.bot` when default. Restart bot after admin retarget.

## hopper instruction surface (v2 4-way)

**Admin:** `initialize(dest_treasury, dest_admin, dest_ops, dest_tax, sol_split_bps[4], threshold, tip_bps)`, `update_routing` (4 optional pubkeys + bps array), `register_token_route(threshold)`, `update_token_route(threshold?, enabled?)`, `transfer_admin`/`accept_admin`, `pause`.

**Permissionless (anyone cranks):** `sweep_sol` (4-way split per `sol_split_bps[4]`, default 25/25/25/25, plus cranker tip), `sweep_token(mint)` (4-way using same `RoutingConfig` destinations; cranker pays for `init_if_needed` ATAs).

Replay safety: every sweep handler validates passed destination accounts against current `RoutingConfig` at handler time. Admin retargets render queued sweeps inert (revert), no fund misroute.

## proposal-whitelist-addin instruction surface

**Admin:** `create_registrar`, `update_registrar_whitelist`.
**Voter-side:** `create_voter_weight_record` (idempotent), `update_voter_weight_record` (re-derives ProposalTransaction PDAs from passed `remainingAccounts`, validates each inner ix against the registrar whitelist; off-list → weight 0).

## File map

```
programs/
  bin-farm/src/lib.rs                  positions, harvest, close, fee_dest routing,
                                       treasury_* (Path B), settle_proposer (4-way settle)
  bin-farm/src/meteora_dlmm_cpi.rs     CPI (V2)
  hopper/src/lib.rs                    routing program (v2 4-way)
  proposal-whitelist-addin/src/lib.rs  community VWR addin gating Path B votes

bot/
  anchor-harvest-bot.ts                orchestrator, init, fee_dest resolution
  geyser-subscriber.ts                 Helius LaserStream gRPC (Alchemy migration in flight)
  harvest-executor.ts                  job queue, dust filter, fee_dest pass-through
  treasury-runtime.ts                  Path B init (gated on GOVERNANCE_REALM_NAME)
  treasury-match.ts                    proposal orchestrator (queue, retry, lifecycle)
  keeper.ts                            daily 3-step: hopper_sweep / refresh_supplies / stats_post
  relay-server.ts                      REST + WS, Bearer-gated except /api/health
  alerter.ts, logger.ts, retry.ts, meteora-accounts.ts

packages/
  core-sdk/                            shared constants, PDAs, math, pool-config,
                                       price-source, jup-quote, wallet-service, transactions,
                                       treasury-{validator,proposal,payloads}.ts,
                                       whitelist-addin.ts, generated/ Codama clients
  discord-bot/                         slash commands, notifier, formatter

scripts/                               deploy.sh, preflight-check.ts, generate-clients.mjs,
                                       init-hopper.mjs, set-fee-dest.mjs, check-vaults.mjs,
                                       unwrap-stuck-wsol.ts, force-close-position.ts,
                                       close-all-positions.ts, test-laserstream.ts,
                                       bootstrap-realm.ts, devnet-rehearsal.ts
tools/
  depth.ts                             ASCII depth chart
  protocol-lp/                         per-wallet harvester for protocol-owned LP

runbooks/                              droplet-recovery.md, keypair-separation.md
curator.json                           pool registry
Anchor.toml                            bin-farm + hopper + proposal-whitelist-addin
HANDOFF.md                             current deploy state + next-session work
README.MD                              public-facing entry point
```

## Critical runtime gotchas

- **SBF build:** Homebrew cargo lacks `+toolchain`. Use `PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor build`.
- **`Box<>` wrappers required** on `InterfaceAccount` / `Account` fields in bin-farm — BPF 4KB stack overflow without them.
- **Anchor methods need BN, not BigInt.** `new BN(amount.toString())` for every arg.
- **`getTransaction` lags confirmation.** Retry 3× with 2s delay.
- **WSOL must always be unwrapped after use.** Any path touching WSOL needs `unwrap_wsol_in_vault` at the end (harvest, close, /withdraw SOL, /buy leftover). Recovery: `scripts/unwrap-stuck-wsol.ts`.
- **Gas model:** bot is sole signer + fee payer. 9 user-facing instructions call `deduct_gas` pulling `config.gas_lamports` from vault PDA → bot. Capped on-chain at `MAX_GAS_LAMPORTS = 0.01 SOL`. `open_position_v2` also pulls `rent_lamports` (bot-computed, capped at 0.2 SOL). Closes refund Meteora rent to vault, not bot.
- **`harvest_bins` dust gate:** gas deducted only when `is_authorized_bot && had_yield`. Permissionless keepers get `keeper_tip_bps` from fees.
- **fee_dest validation:** `harvest_bins`, `close_position`, `user_close` validate the passed `fee_dest` account against `Config.fee_dest` (or `Config.bot` if default). Mismatched fee_dest reverts `InvalidFeeDest`.
- **Token-2022 transfer hooks unsupported.** CPI passes `empty_hooks()`. Bot rejects hook-bearing mints via `hasTransferHook()` in `/buy` + `/sell`.
- **Hopper anchor IDL gotcha:** when a program keypair file is regenerated locally, `anchor build` stamps the new pubkey into the IDL `address` field even if `declare_id!` is correct. Symptom: tx routes to a non-existent program ID. Fix: edit IDL `address` field manually + regenerate Codama clients.
- **SOL price from Pyth:** `fetchDexScreenerPrice(SOL_MINT)` routes to Pyth Hermes, not DexScreener. Other tokens use DexScreener with stablecoin-pair preference.
- **`binIdToBinArrayIndex` uses `Math.trunc`.** Negative bin IDs otherwise mismatch on-chain PDAs.

## Deployment

Droplet: NYC1, s-2vcpu-4gb Ubuntu 22.04 + 1GB swap. Domain `bot.crank.money`, Let's Encrypt SSL.

```
/root/crank-money/                rsynced app code
/root/crank-money/bot/.env        persists across deploys
/root/.keys/bot-keypair.json      bot wallet, chmod 600
/root/.keys/backup.key            wallet DB encryption key
```

```bash
DROPLET_IP=159.223.133.9 ./scripts/deploy.sh   # rsync + npm install + PM2 restart + health check
ssh -i ~/.ssh/id_ed25519_deploy root@159.223.133.9 'pm2 logs crank-harvester --lines 50'
curl -H "Authorization: Bearer $RELAY_AUTH_TOKEN" http://localhost:8080/api/stats
```

When bin-farm or hopper IDLs change, deploy ordering:
1. `pm2 stop crank-harvester` on droplet
2. `anchor deploy --program-name <p>` (or `solana program deploy --program-id <ID> target/deploy/<p>.so` for upgrades by upgrade authority)
3. `node scripts/generate-clients.mjs` + commit regenerated clients + IDL
4. `./scripts/deploy.sh`

Wallet DB → `s3://crank-backups/` every minute (`flock`). Restore path verified end-to-end; decrypt with `openssl -aes-256-cbc -pbkdf2`. See `runbooks/droplet-recovery.md`.

## Security

- Bot keypair = `Config.bot` only (signer + fee payer). Does NOT hold upgrade authority.
- Upgrade authority on bin-farm + hopper = admin wallet `FFwq…QPsL`. Single-key compromise = both programs. HW-wallet rotation deferred — see `HANDOFF.md`.
- Relay Bearer-gated, fail-closed (`RELAY_AUTH_TOKEN` required at `attach()`, `timingSafeEqual`). WS at `/ws` requires Bearer via `Authorization` header or `?token=` query.
- Token-2022 transfer hooks rejected.

## Relay endpoints

All `https://bot.crank.money/api/*` require Bearer except `/api/health`. Surviving routes: `/api/stats`, `/api/pools`, `/api/positions`, `/api/pending-harvests`, `/api/bot-wallet`, `/api/rovers`, `/api/feed`, `/api/protocol-pnl`. WebSocket at `/ws`. (`/api/fees` retired.)

## State (2026-05-08)

- **Mainnet (live):** bin-farm v1 (50bps fee, no Path B), hopper v1 (3-way), bot routing fees → HopperVault, daily sweeps.
- **Built locally, not deployed:** bin-farm v2 (1% fee, Path B `treasury_*` ixs, `tax_bps`/`tax_reserve` Config fields, `expand_config_v2`), hopper v2 (4-way `RoutingConfig`, `dest_treasury`/`admin`/`ops`/`tax`).
- **Built + deployed devnet only:** proposal-whitelist-addin (`9Tpa3wZwm21yPFvZtDQYnJic5UGKPNQKqQqCiC6tkUnv`). End-to-end Path B rehearsal POSITIVE (whitelisted memo) + NEGATIVE (system-transfer drain blocked at weight 0) both passed.
- **Deferred:** HW wallet rotation (`DPr9NDe…`, never signed). Test against low-stakes admin tx first.

See `HANDOFF.md` for deploy ordering, env vars, post-deploy verification.
