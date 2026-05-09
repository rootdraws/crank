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

**Treasury matching (Path B):** spot leg copy-trades user buys into a parallel NTP-owned position via SPL Governance. The `proposal-whitelist-addin` returns voter weight 0 for any proposal whose inner ixs aren't on the whitelist — so a compromised bot cannot author a drain proposal. Whitelist: `treasury_open_position`, `treasury_user_close`, `record_settle_meta`, `settle_proposer`, `close_settle`, `harvest_bins`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`, SPL Memo. Council side ungated — used for emergency / admin operations, signer is the council-mint holder (currently FFwq, planned move to HW).

**Operating thesis:** crank is the execution layer for cross-venue funding-rate arb. Spot leg is the bin-farm DLMM. Perp leg (Hyperliquid) is in flight, not built. Protocol revenue routes on-chain via the Hopper program.

## Programs (mainnet)

| Program | ID |
|---------|------|
| bin-farm (core) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| hopper (routing) | `2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF` |
| proposal-whitelist-addin | `9Tpa3wZwm21yPFvZtDQYnJic5UGKPNQKqQqCiC6tkUnv` |

**Authority (current):** all three programs' upgrade authority + bin-farm `Config.authority` + hopper `RoutingConfig.admin` + bin-farm `Config.bot` = `FFwqCuYTw7DFWWRQD3tYcPBPpmaAQjT1JV5kqG15QPsL`. **Single key for everything; separation is the next operational milestone.** HW wallet `DPr9NDewhqDMY58fpAZSBqjTfDYm9N8NKjP2o2RZLU9A` has signed one no-op tx (gate passed) but admin rotation is not yet executed. Bot/admin separation will follow.

**Payout admin:** `Config.payout_admin` = Native Treasury PDA (`A9Ko5BBnobV82WDukujNYo9BcC5YiFqBY148BH5JKsdn`). Set via `init_payout_config` post-bootstrap. Changes to `payout_bps` / `match_ratio_bps` from here on require a passed governance proposal.

## Tokens

| Token | Mint | Decimals | Program |
|-------|------|----------|---------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 | Token-2022 |
| $BANK (retired) | `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA` | 6 | legacy SPL |

$BANK no further mints. Existing holders can hold/transfer; user vaults may hold residual BANK withdrawable via `/withdraw token`.

**CRANK is Token-2022.** ATA derivation, `getMint`, `createTransferInstruction`, `createAssociatedTokenAccountIdempotentInstruction` all need `TOKEN_2022_PROGRAM_ID` passed explicitly — defaults are legacy SPL and silently fail with `IncorrectProgramId` or `InvalidAccountData`. CRANK has no transfer-hook extension, so `transfer_checked` works without hook accounts.

## Governance (mainnet)

Realm `crank.money` runs on SPL Governance + the proposal-whitelist-addin. The Native Treasury PDA owns the bin-farm UserVault used by Path B.

| Artifact | Address |
|---------|---------|
| Realm | `Y62sT9Xdqa2gFxZVBykWLAgPYdFnYneE3Xq2Dk9sSBC` |
| Governance | `EkNgm2mUHGbPK6WG9HLwCQKPKVAn3oKuvMmKpqtRNYud` |
| Native Treasury PDA (NTP) | `A9Ko5BBnobV82WDukujNYo9BcC5YiFqBY148BH5JKsdn` |
| Treasury UserVault (bin-farm) | `DgSDbnE2hPAE6AofJaMLCRGi96p7FRQsna6WmyM85kU5` |
| Council mint | `Z8qs4GLpPQBMp8RDXASCYSywkxsBbJB8gPfesDhKeBt` |
| Proposal-perm mint (community, bot delegate) | `H2AkWcqYoubEZUZSNv65kecRE5SSL3PjQBgo6nZnoG4t` |

Council axis is ungated (used for emergency / admin operations). The lone council token is currently held by the operator's hot wallet (FFwq); it'll move to the HW wallet `DPr9NDe…` post-rotation. Community axis is gated by the addin: any proposal whose inner ixs aren't all on the registrar whitelist returns voter weight 0 and stays in Voting indefinitely.

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
- `RoutingConfig` — `[b"routing_config"]` = `6VvNCC7kGYGGTAQCBamt7UoBRvxaenwprBcWkzjz7xZ9` (v2, in-place migrated from v1 via `expand_routing_config_v2`)
- `HopperVault` — `[b"hopper_vault"]` = `4bugEHcAr1F6bg39nu26M3steAGwGAdtGzq3iwYjWs1b` — receives all `harvest_bins.fee_taken`
- `TokenRoute` — `[b"token_route", mint]`

**proposal-whitelist-addin:**
- `Registrar` — `[b"registrar", realm, governing_token_mint]`
- `VoterWeightRecord` — `[b"voter_weight_record", realm, governing_token_mint, governing_token_owner]`

## bin-farm instruction surface

**User-facing (Path A):** `create_vault`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`, `withdraw_sol`, `withdraw_token`, `open_position_v2` (takes `rent_lamports`), `harvest_bins`, `close_position`, `user_close`, `claim_fees`.

**Treasury (Path B, governance-only):** `treasury_open_position`, `treasury_user_close`, `record_settle_meta`, `settle_proposer`, `close_settle`. `record_settle_meta` enforces `caller == user_vault.owner`, which on the treasury vault is the NTP — only signable via `invoke_signed` from a passed governance proposal. The addin gates which proposals can pass, so a compromised bot cannot author a drain.

**Admin (FFwq-signed, one-shot first; payout-admin txs require NTP signer post-bootstrap):** `set_fee_bps`, `set_fee_dest` (retargets `Config.fee_dest`), `set_tax_config(tax_bps, tax_reserve)`, `init_payout_config(payout_bps, match_ratio_bps, payout_admin)` (one-shot), `update_payout_config` (signed by `payout_admin` = NTP), `set_payout_admin` (admin-side migration of payout_admin), `expand_config_v2` (one-shot V1→V2 realloc — uses `UncheckedAccount` since v2-typed deserializer can't read v1-sized account), `update_bot`, `update_keeper_tip_bps`, `update_priority_slots`, `update_gas_lamports`, `transfer_authority`/`accept_authority`, `pause`/`unpause`, `bot_pause`/`bot_unpause`, `propose_emergency_close`/`apply_emergency_close`.

`Config.fee_dest` currently = HopperVault PDA. Bot resolves at startup and falls back to `Config.bot` when default. Restart bot after admin retarget.

## hopper instruction surface (v2 4-way)

**Admin:** `initialize(dest_treasury, dest_admin, dest_ops, dest_tax, sol_split_bps[4], threshold, tip_bps)`, `update_routing` (4 optional pubkeys + bps array), `register_token_route(threshold)`, `update_token_route(threshold?, enabled?)`, `transfer_admin`/`accept_admin`, `pause`, `expand_routing_config_v2` (one-shot v1→v2 realloc, idempotent, uses `UncheckedAccount` and explicitly writes the canonical bump byte post-realloc — without that, `bump = routing_config.bump` PDA validation fails on every subsequent ix).

**Permissionless (anyone cranks):** `sweep_sol` (4-way split per `sol_split_bps[4]`, default 25/25/25/25, plus cranker tip), `sweep_token(mint)` (4-way using same `RoutingConfig` destinations; cranker pays for `init_if_needed` ATAs).

Replay safety: every sweep handler validates passed destination accounts against current `RoutingConfig` at handler time. Admin retargets render queued sweeps inert (revert), no fund misroute.

**Current routing destinations (mainnet, post-bootstrap):**
- `dest_treasury` = NTP `A9Ko5BBn…`
- `dest_admin` = HW pubkey `DPr9NDe…` (target for the admin-share post-rotation)
- `dest_ops` = FFwq (placeholder; will become a dedicated bot keypair post-separation)
- `dest_tax` = `77QfJ6GLuFGWd9fYYUVcrjS5RH7aNgJjwDnZWuxcwtj4`

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
  geyser-subscriber.ts                 Yellowstone gRPC (Alchemy primary, Helius legacy)
  harvest-executor.ts                  job queue, dust filter, fee_dest pass-through
  treasury-runtime.ts                  Path B init (gated on GOVERNANCE_REALM_NAME)
  treasury-match.ts                    proposal-payload builder (matched-trade ix sequence)
  treasury-orchestrator.ts             proposal orchestrator (queue, retry, lifecycle)
  keeper.ts                            daily 3-step: hopper_sweep / refresh_supplies / stats_post
  relay-server.ts                      REST + WS, Bearer-gated except /api/health
  price-syncer.ts                      pool-config price refresh
  alerter.ts, logger.ts, retry.ts, meteora-accounts.ts

packages/
  core-sdk/                            shared constants, PDAs, math, pool-config,
                                       price-source, jup-quote, wallet-service, transactions,
                                       treasury-{validator,proposal,payloads}.ts,
                                       whitelist-addin.ts, generated/ Codama clients
  discord-bot/                         slash commands, notifier, formatter

scripts/
  deploy.sh                            rsync + npm install + pm2 restart
  generate-clients.mjs                 Codama TS clients from target/idl
  preflight-check.ts                   pre-deploy on-chain sanity
  bootstrap-realm.ts                   one-shot SPL Governance realm + addin bootstrap
  bootstrap-verify.ts                  end-to-end memo proposal lifecycle test
  init-hopper.mjs                      one-shot hopper v2 4-way init
  init-payout-config.ts                one-shot bin-farm payout_admin = NTP
  expand-config-v2.ts                  one-shot bin-farm Config v1→v2 realloc
  expand-routing-config-v2.ts          one-shot hopper RoutingConfig v1→v2 realloc
  set-fee-bps.ts                       admin: bin-farm fee_bps
  set-tax-config.ts                    admin: bin-farm tax_bps + tax_reserve
  set-fee-dest.mjs                     admin: bin-farm fee_dest
  update-routing.ts                    admin: hopper update_routing (4-way)
  transfer-authority.ts                admin: bin-farm transfer_authority + hopper transfer_admin (atomic)
  fix-payout-bps-2500.ts               admin: temp-revoke + update_payout_config + restore (3-ix atomic)
  realm-check.ts, tor-check.ts,
  vwr-check.ts, parser-check.ts        diagnostic readers
  unwrap-stuck-wsol.ts, force-close-position.ts,
  close-all-positions.ts, drain-residue.ts
  apply-emergency-close.ts             emergency-close apply step (24hr post-propose)
  reclaim-atas.ts, close-wsol.ts       cleanup
  setup-droplet.sh, backup-wallet-db.sh
  devnet-rehearsal.ts                  Path B rehearsal (devnet)
  probe-alchemy-grpc.ts                gRPC subscription probe
  repoint-hopper.ts                    LEGACY (3-way) — replaced by update-routing.ts

tools/
  depth.ts                             ASCII depth chart
  protocol-lp/                         per-wallet harvester for protocol-owned LP

runbooks/                              droplet-recovery.md, keypair-separation.md
curator.json                           pool registry
Anchor.toml                            bin-farm + hopper + proposal-whitelist-addin
README.MD                              public-facing entry point
```

## Critical runtime gotchas

- **SBF build:** Homebrew cargo lacks `+toolchain`. Use `PATH="$HOME/.cargo/bin:$HOME/.rustup/shims:$PATH" anchor build`.
- **`Box<>` wrappers required** on `InterfaceAccount` / `Account` fields in bin-farm AND hopper `SweepToken` — BPF 4KB stack overflow without them. Hit at 4288 B in hopper v2; box-wrapped 9 fields, ~2.2 KB recovered.
- **Anchor's `Account<T>` deserializes BEFORE realloc constraint runs.** Growing a v1-sized on-chain account into a v2-shaped struct via `#[account(realloc = X::SIZE)]` fails at deserialize, not realloc. Migration ixs must use `UncheckedAccount` + manual auth byte-check + `info.realloc(new_size, true)` + manual structural-field rewrites. See `expand_config_v2` (bin-farm) and `expand_routing_config_v2` (hopper).
- **Realloc + zero-extend doesn't reposition fields.** When growing a struct that adds fields at the end, the existing reserved-tail bytes don't shift to align with the v2 layout. Specifically `bump` ends up at the wrong byte offset (or zero in the new bytes). Migration ixs must explicitly write the canonical bump from `ctx.bumps` and zero out structural fields the next ix will populate.
- **`getMint` defaults to legacy `TOKEN_PROGRAM_ID`.** Token-2022 mints (CRANK!) silently fail with `InvalidAccountData`. Always `getMint(connection, mint, undefined, programId)` after detecting program from `getAccountInfo(mint).owner`. Same for `getAssociatedTokenAddressSync`, `createAssociatedTokenAccountIdempotentInstruction`, `createTransferInstruction` — pass `programId`.
- **SPL Governance error 0x20d (`Can't execute transaction within its hold up time`)** fires when `executeTransaction` is sent in the same slot as the vote that completed the proposal. `holdUpTime=0` doesn't prevent it. `core-sdk/treasury-proposal.ts` retries with exponential backoff (~150 s ceiling). Same retry needed in `bootstrap-realm.ts` step 6.
- **`packages/core-sdk/package.json` needs `"type": "module"`** for tsx-run scripts to resolve named exports correctly. Without it, `import { BIN_FARM_PROGRAM_ID } from '@crankbot/core-sdk'` fails with "does not provide an export named X" in ESM strict mode.
- **Anchor methods need BN, not BigInt.** `new BN(amount.toString())` for every arg.
- **`getTransaction` lags confirmation.** Retry 3× with 2s delay.
- **WSOL must always be unwrapped after use.** Any path touching WSOL needs `unwrap_wsol_in_vault` at the end (harvest, close, /withdraw SOL, /buy leftover). Recovery: `scripts/unwrap-stuck-wsol.ts`.
- **Gas model:** bot is sole signer + fee payer. 9 user-facing instructions call `deduct_gas` pulling `config.gas_lamports` from vault PDA → bot. Capped on-chain at `MAX_GAS_LAMPORTS = 0.01 SOL`. `open_position_v2` also pulls `rent_lamports` (bot-computed, capped at 0.2 SOL). Closes refund Meteora rent to vault, not bot.
- **`harvest_bins` dust gate:** gas deducted only when `is_authorized_bot && had_yield`. Permissionless keepers get `keeper_tip_bps` from fees.
- **fee_dest validation:** `harvest_bins`, `close_position`, `user_close` validate the passed `fee_dest` account against `Config.fee_dest` (or `Config.bot` if default). Mismatched fee_dest reverts `InvalidFeeDest`.
- **Token-2022 transfer hooks unsupported.** CPI passes `empty_hooks()`. Bot rejects hook-bearing mints via `hasTransferHook()` in `/buy` + `/sell`.
- **Hopper anchor IDL gotcha:** when a program keypair file is regenerated locally, `anchor build` stamps the new pubkey into the IDL `address` field even if `declare_id!` is correct. Symptom: tx routes to a non-existent program ID. Fix: edit IDL `address` field manually + regenerate Codama clients.
- **`bot/idl/*.json` lags `target/idl/*.json`.** After every `anchor build`, sync: `cp target/idl/bin_farm.json bot/idl/ && cp target/idl/hopper.json bot/idl/ && node scripts/generate-clients.mjs`. Stale `bot/idl` makes Codama-generated clients miss new ix surfaces.
- **Helius rate-limits program-deploy write transactions.** Use Alchemy for `solana program deploy` — Helius failed at 16/79 chunks even with `--max-sign-attempts 60`. Buffer SOL is recoverable via `solana program close <buffer>`.
- **Solana CLI `program deploy` recovery seed phrase** is for the BUFFER signer, not your wallet. If a deploy fails mid-write, `solana program close <buffer> --bypass-warning --recipient <admin>` recovers the buffer's SOL; the seed is only needed to resume the same buffer (rarely worth it — fresh deploy is faster than seed recovery).
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
1. `solana program deploy target/deploy/<p>.so --program-id <ID> --upgrade-authority ~/.config/solana/id.json --url <Alchemy> --max-sign-attempts 100`
2. `cp target/idl/{bin_farm,hopper}.json bot/idl/ && node scripts/generate-clients.mjs` (sync IDLs, regen Codama clients)
3. Run any one-shot migration ixs (`tsx scripts/expand-*.ts`, then config setters)
4. `./scripts/deploy.sh` (rsync + pm2 restart)
5. `pm2 logs crank-harvester --lines 50` to verify boot

The bot doesn't need to be stopped before program deploy — the v2 program runs against existing accounts, and any in-flight ixs the bot was about to send will simply fail and retry. Only stop it if you're keypair-rotating the program ID.

Wallet DB → `s3://crank-backups/` every minute (`flock`). Restore path verified end-to-end; decrypt with `openssl -aes-256-cbc -pbkdf2`. See `runbooks/droplet-recovery.md`.

## Security

- **Single-key state (current):** bot keypair = upgrade authority = `Config.authority` = `RoutingConfig.admin` = FFwq. Single-key compromise = bot operations + program upgrades + admin txs. **This is a known interim state**; HW rotation + bot-keypair separation is the next milestone.
- **Path B drain protection:** even with FFwq compromised, a Path B drain proposal cannot pass — the proposal-whitelist-addin returns voter weight 0 for any community-side proposal whose inner ixs aren't all on the registrar whitelist. The whitelist contains `treasury_open_position`, `treasury_user_close`, `record_settle_meta`, `settle_proposer`, `close_settle`, `harvest_bins`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`, SPL Memo. Council axis is ungated — emergency / admin operations require the council mint, currently held only by the operator's hot wallet. Once HW rotates, council mint moves to HW.
- **`payout_admin` post-bootstrap is NTP.** Changes to payout/match params require a passed governance proposal. The `set_payout_admin` admin ix can rotate this back to a hot wallet in a 3-ix atomic tx (`set_payout_admin → update_payout_config → set_payout_admin`), gated by `Config.authority`.
- Relay Bearer-gated, fail-closed (`RELAY_AUTH_TOKEN` required at `attach()`, `timingSafeEqual`). WS at `/ws` requires Bearer via `Authorization` header or `?token=` query.
- Token-2022 transfer hooks rejected.

## Relay endpoints

All `https://bot.crank.money/api/*` require Bearer except `/api/health`. Surviving routes: `/api/stats`, `/api/pools`, `/api/positions`, `/api/pending-harvests`, `/api/bot-wallet`, `/api/rovers`, `/api/feed`, `/api/protocol-pnl`. WebSocket at `/ws`. (`/api/fees` retired.)

## State (2026-05-09)

- **All three programs live on mainnet.** bin-farm v2 (1% fee, Path B treasury ixs, tax fields), hopper v2 (4-way splits 25/25/25/25, in-place migrated from v1), addin (`9Tpa3wZw…`) deployed mainnet with FFwq upgrade authority.
- **Realm `crank.money` bootstrapped.** `setRealmAuthority` transferred to governance — irreversible.
- **bin-farm Config:** authority=FFwq, fee_bps=100, tax_bps=2500, payout_bps=2500, payout_admin=NTP, fee_dest=HopperVault. Settle math is 25% proposer / 25% tax / 50% treasury.
- **Treasury seeded:** 1M CRANK in NTP-owned bin-farm UserVault `DgSDbnE2…`.
- **Bot:** restarted on droplet 2026-05-09 with new env (governance vars + NTP) and new code (Path B treasury runtime + Token-2022 keeper fix + hold-up retry). Geyser stream healthy, daily keeper running.
- **bootstrap-verify passed:** end-to-end memo proposal lifecycle works (proposal `4AZ2N1B4…`).

**Open / deferred:**
- HW wallet rotation — DPr9NDe… has signed one no-op tx (gate passed). Full `transfer_authority` + `accept_authority` rotation across bin-farm + hopper not yet executed.
- Bot-keypair separation — `Config.bot` is currently FFwq itself. Plan: generate dedicated bot keypair, update_bot to it, harden droplet so bot keypair is the ONLY thing on the box.
- Path B real-trade verification — bootstrap-verify exercises the lifecycle but no real `/buy` has triggered a treasury match yet. End-to-end settle math (25/25/50 fan-out at user_close) verifiable on first real Path B fire.
- Synthetic drain test (negative addin assertion) — manual via Realms UI, expect weight=0.
