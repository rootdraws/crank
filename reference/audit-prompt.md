# AUDIT-PROMPT.md — Adversarial Security Audit for crank.money

> **Instructions:** Feed this entire file to a fresh Claude session alongside the crank-money repository. The auditor should read every file referenced below, apply every attack vector, and produce a single `audit-v2.md` report at the repository root. Do not overwrite the existing `audit.md` — it contains the collapsed live findings from the previous audit.

---

## 0. YOUR ROLE

You are a senior Solana security auditor performing a comprehensive adversarial review of the **crank.money** protocol — a non-custodial DLMM limit-order farming system built on Meteora, live on Solana mainnet. You have been hired to find every bug, every exploit path, every operational risk, and every economic attack that could cost users or the protocol money.

You are not here to compliment the code. You are here to break it.

**Primary focus:** The PDA vault migration (2026-04-08) introduced 8 new bin-farm instructions and added `deduct_gas` to 9 existing instructions. **This code has never been audited.** It is the largest uncharted attack surface in the repo. Prioritize this area.

**Secondary focus:** Re-audit the previously reviewed surfaces for regressions. The original audit (2026-04-01) produced 53 findings, of which 33 were remediated and 8 were rendered obsolete by the migration. The live open findings are in `audit.md` at the repository root — **read it first** and do not re-report those issues unless you find them worse than currently believed.

**Audit date:** The current date when you are reading this.

**Output:** Produce `audit-v2.md` at the repository root with your complete findings using the report structure defined in Section 9.

---

## 1. WHAT YOU ARE AUDITING

crank.money is a **non-custodial DLMM limit-order protocol** that:
- Holds user funds in on-chain **UserVault PDAs** seeded by the user's real Solana wallet: `[b"user_vault", owner_wallet]`
- Bot is a **stateless operator** — holds no user keys, server wipe loses zero user funds
- Withdrawals are enforced to `vault.owner` by PDA seed derivation (immutable)
- Bot is the **sole tx signer + fee payer**; each user-facing instruction calls `deduct_gas()` to reimburse the bot from the user's vault
- Opens ranged limit-order positions on Meteora DLMM pools via on-chain programs
- Harvests filled bins automatically via an off-chain bot (gRPC event stream + job queue)
- Collects 0.3% fees on harvest/close, split 40% holders / 40% traders / 20% operations
- Distributes revenue as WSOL via a Merkle distributor (daily epochs) — auto-claimed to user vault ATAs
- Exposes a Discord bot (12 slash commands) as the primary user interface
- Runs on a single DigitalOcean droplet with PM2 process management

**This is a live, mainnet system holding real user funds.** Treat it accordingly.

**Architecture change (2026-04-08):** The previous custodial keypair model (encrypted AES-256-GCM keypairs in a JSON file) was replaced by UserVault PDAs. No `WALLET_ENCRYPTION_KEY`, no custodial keypairs, no deposit-address-based withdraw locking. All user funds live on-chain. The bin-farm program still needs `anchor upgrade` to activate the new instructions on mainnet.

---

## 2. ARCHITECTURE OVERVIEW

### 2.1 On-Chain Programs (5 Anchor programs, Solana mainnet)

| Program | ID | Purpose |
|---------|------|---------|
| **bin_farm** | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` | Core: UserVaults, positions, harvesting, fee rovers, fee splitting, gas deduction |
| **bank_mint** | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` | Burn $CRANK -> mint $BANK 1:1 |
| **gauge_voter** | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` | BANK-weighted pool gauge voting |
| **merkle_distributor** | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` | Cumulative WSOL Merkle distribution |
| **epoch_vault** | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` | SOL fee accumulator (bridge vault) |

### 2.2 PDA Vault Instructions (bin-farm, added 2026-04-08 — UNAUDITED)

| Instruction | Purpose | Gas deducted? |
|-------------|---------|---------------|
| `create_vault(owner)` | Creates UserVault PDA. Anyone can pay rent. PDA seed = owner wallet. | No (initial bootstrap) |
| `wrap_sol_in_vault(amount)` | Debit vault lamports → credit WSOL ATA + sync_native | Yes |
| `unwrap_wsol_in_vault()` | Close vault WSOL ATA → lamports to vault PDA | Yes |
| `withdraw_sol(amount)` | Vault PDA lamports → owner wallet (rent-exempt guard) | Yes |
| `withdraw_token(amount)` | Vault ATA → owner ATA (vault PDA signs) | Yes |
| `vault_burn_and_mint(amount)` | CPI to bank-mint: burn CRANK from vault → mint BANK to vault | No |
| `vault_vote(allocations)` | CPI to gauge-voter: vote with vault's BANK | No |
| `update_gas_lamports(amount)` | Admin sets per-operation gas reimbursement | N/A (admin-only) |

**Plus `deduct_gas` added to 9 existing instructions:** `open_position_v2`, `harvest_bins`, `close_position`, `user_close`, `claim_fees`, `withdraw_sol`, `withdraw_token`, `wrap_sol_in_vault`, `unwrap_wsol_in_vault`.

**Scrutinize:**
- Can `deduct_gas` be spammed to drain a user's vault? Is there a rate limit or per-op cap?
- Can the rent-exempt guard on `withdraw_sol` be bypassed?
- Does `wrap_sol_in_vault` correctly verify the WSOL ATA owner is the vault PDA?
- Does `unwrap_wsol_in_vault` close to the vault PDA, or can it leak to an attacker-controlled account?
- Does `vault_burn_and_mint` correctly constrain the CRANK source and BANK destination to vault ATAs?
- Does `vault_vote` constrain the gauge account owner (see M-03 in audit.md)?
- Is the UserVault PDA seed `[b"user_vault", owner_wallet]` unique enough to prevent cross-user collisions?
- Is there a `close_vault` instruction? (CLAUDE.md says it's missing — confirm and assess impact on rent recovery.)
- Does `update_gas_lamports` have a timelock? Can the admin spike it to drain all vaults in one tx?

### 2.3 Off-Chain Infrastructure

| Component | File | Purpose |
|-----------|------|---------|
| **Harvester Bot** | `bot/anchor-harvest-bot.ts` | Main orchestrator, health server :8080 |
| **Geyser Subscriber** | `bot/geyser-subscriber.ts` | Helius LaserStream gRPC, raw LbPair parsing, position registry, bin detection |
| **Harvest Executor** | `bot/harvest-executor.ts` | Job queue, Token-2022 aware, tx execution, dedup, concurrency cap |
| **Keeper** | `bot/keeper.ts` | Daily 5-step fee sequencer (close WSOL → sweep → epoch → fee rovers → close exhausted) |
| **Epoch Computer** | `bot/epoch-computer.ts` | Merkle tree builder, IPFS pinning, auto-claim (27 unit tests) |
| **Relay Server** | `bot/relay-server.ts` | REST API + WebSocket (15 endpoints) |
| **Price Syncer** | `bot/price-syncer.ts` | Arb detection (disabled, swap execution pending) |
| **Alerter** | `bot/alerter.ts` | Discord feed alerts |
| **Price Source** | `packages/core-sdk/price-source.ts` | DexScreener (non-SOL) + Pyth (SOL) |

### 2.4 Shared SDK (`packages/core-sdk`)

| Module | Purpose |
|--------|---------|
| `constants.ts` | Program IDs, offsets, layout constants |
| `pda.ts` | PDA derivations (14 PDAs across 5 programs + Meteora + Metaplex) |
| `math.ts` | Bin ↔ price conversions |
| `pool-config.ts` | Pool registry (curator.json) |
| `range-parser.ts` | User input → bin range |
| `pool-router.ts` | Multi-pool routing, auto-split |
| `price-source.ts` | DexScreener + Pyth oracle |
| `wallet-service.ts` | **User vault PDA mapping + position/vote/harvest tracking (no keypairs, no encryption)** |
| `signer.ts` | **Bot-only tx signing (no user keypairs)** |
| `transactions.ts` | TX building, CU budgets, priority fees |
| `meteora.ts` | Pool resolution helpers |

### 2.5 Discord Bot (`packages/discord-bot`)

| File | Purpose |
|------|---------|
| `src/index.ts` | DiscordBot class, command wiring |
| `src/commands/*.ts` | 12 slash commands: start, balance, deposit, buy, sell, positions, close, withdraw, pools, vote, burn, help |
| `src/notifier.ts` | DM + feed channel notifications |
| `src/formatter.ts` | Message formatting |
| `src/deposit-detect.ts` | **Returns owner wallet (PDA seed enforcement replaces deposit-based locking)** |
| `src/deploy-commands.ts` | Register slash commands with Discord API |

### 2.6 Fee Flow (Critical Path)

```
harvest/close -> 0.3% fee -> rover_authority ATAs
  (remaining 99.7% -> vault ATAs, not external wallet)
  |
  SOL: WSOL ATA -> close_rover_token_account (unwrap) -> sweep_rover
  Tokens: rover ATA -> open_fee_rover (BidAskImBalanced DLMM) -> natural conversion -> SOL
  |
  sweep_rover splits 40/40/20:
    80% -> bridge_vault (revenue_dest + trader_dest both point here)
    20% -> Config.bot (operations self-funding)
  |
  Every user-facing ix also calls deduct_gas(config.gas_lamports):
    vault PDA lamports -> Config.bot
  |
  Daily epoch-computer:
    drain_vault -> wrap SOL to WSOL -> fund merkle-distributor -> auto-claim to vault ATAs
    (claim bundled with unwrap_wsol_in_vault in single tx; vault pays via deduct_gas on unwrap)
```

### 2.7 Key Design Decisions

- **Non-custodial PDA vaults:** Funds live on-chain, vault seed `[b"user_vault", owner_wallet]`
- **Stateless operator:** Bot holds no user keys. `wallet-service.ts` only maps Discord ID → owner wallet.
- **Withdraw address immutable:** `vault.owner` baked into PDA seed, cannot be changed.
- **Gas reimbursement:** Bot signs + pays, vault reimburses via `deduct_gas` on 9 instructions.
- **Permissionless harvesting:** Anyone can call `harvest_bins` after `priority_slots` (100 slots ~40s), earns `keeper_tip_bps` (10%)
- **Flash-loan gauge voting accepted:** `gauge_voter` acknowledges this, cost = swap fees + loan interest
- **Single bot keypair (known risk):** Holds all 5 program upgrade authorities, `Config.authority`, `Config.bot`, drain authority, merkle authority, gauge authority, bank mint authority. Keypair separation planned. See C-02 in audit.md.
- **bin-farm program upgrade pending:** PDA vault instructions are in the repo, compiled, IDL generated — but not yet deployed to mainnet. Existing positions must be force-closed first.

---

## 3. FILES YOU MUST READ

Read these files **in full** before writing any findings. Do not skim. Do not skip.

**First, read the collapsed previous audit:**
```
audit.md                                         (live findings from the 2026-04-01 audit)
claude.md                                        (codebase context — architecture, conventions, known issues)
```

### 3.1 On-Chain Programs (Rust/Anchor)

All five programs are single-file `lib.rs` — there are no `state.rs`, `instructions/`, or `errors.rs` subdirectories.

```
programs/bin-farm/src/lib.rs                     (3054+ lines — PDA vaults, positions, harvest, rovers, 40/40/20)
programs/bin-farm/src/meteora_dlmm_cpi.rs        (CPI module, V2 only, 375 lines)
programs/bin-farm/Cargo.toml

programs/bank-mint/src/lib.rs                    (295 lines — burn CRANK → mint BANK, 2B cap)
programs/bank-mint/Cargo.toml

programs/gauge-voter/src/lib.rs                  (460 lines — PPB math, per-pair voting)
programs/gauge-voter/Cargo.toml

programs/merkle-distributor/src/lib.rs           (441 lines — cumulative WSOL claims, update_mint)
programs/merkle-distributor/Cargo.toml

programs/epoch-vault/src/lib.rs                  (189 lines — drain_vault, bridge_vault PDA)
programs/epoch-vault/Cargo.toml
```

### 3.2 Off-Chain Bot (TypeScript)

```
bot/anchor-harvest-bot.ts
bot/geyser-subscriber.ts
bot/harvest-executor.ts
bot/keeper.ts
bot/epoch-computer.ts
bot/epoch-computer.test.ts                       (27 unit tests — Merkle proof, share computation)
bot/relay-server.ts
bot/price-syncer.ts
bot/alerter.ts
bot/meteora-accounts.ts
bot/retry.ts
bot/logger.ts
bot/bot.test.ts                                  (unit tests — bin detection, byte parsing, dedup)
bot/ecosystem.config.cjs
```

### 3.3 Core SDK

```
packages/core-sdk/index.ts
packages/core-sdk/constants.ts
packages/core-sdk/pda.ts
packages/core-sdk/math.ts
packages/core-sdk/pool-config.ts
packages/core-sdk/range-parser.ts
packages/core-sdk/pool-router.ts
packages/core-sdk/price-source.ts
packages/core-sdk/wallet-service.ts              (PDA mapping — NOT keypairs anymore)
packages/core-sdk/signer.ts                      (bot-only signing — NOT user keypairs anymore)
packages/core-sdk/transactions.ts
packages/core-sdk/meteora.ts
```

### 3.4 Discord Bot

```
packages/discord-bot/src/index.ts
packages/discord-bot/src/notifier.ts
packages/discord-bot/src/formatter.ts
packages/discord-bot/src/deploy-commands.ts
packages/discord-bot/src/deposit-detect.ts
packages/discord-bot/src/commands/*.ts           (all 12: start, balance, deposit, buy, sell,
                                                  positions, close, withdraw, pools, vote, burn, help)
```

### 3.5 Scripts & Config

```
scripts/deploy.sh
scripts/setup-droplet.sh
scripts/backup-wallet-db.sh                      (per-minute backup of PDA mappings, convenience only)
scripts/preflight-check.ts
scripts/generate-clients.mjs
scripts/test-epoch.ts                            (epoch dry-run + live test)
scripts/close-all-positions.ts                   (force-close for PDA vault migration)
scripts/force-close-position.ts
scripts/apply-emergency-close.ts
scripts/close-wsol.ts
scripts/reclaim-atas.ts
scripts/close-rover.ts
scripts/recycle-fee-rover.ts

deploy/nginx/bot.crank.money.conf
Anchor.toml
curator.json
package.json
todo.md
```

---

## 4. ATTACK SURFACE MAP

Audit every item below. For each, ask: **"What happens if an attacker controls this input?"**

### 4.1 On-Chain Attack Vectors (PDA vault priority)

| Vector | Target | Question |
|--------|--------|----------|
| **UserVault PDA seed collision** | `create_vault`, all vault instructions | Can two different owner wallets derive the same vault PDA? Is the seed `[b"user_vault", owner_wallet]` sufficient? |
| **Cross-vault drain** | `withdraw_sol`, `withdraw_token` | Can an attacker craft remaining_accounts or instruction data to withdraw from someone else's vault? |
| **Owner substitution** | All vault instructions | Is `vault.owner` always re-derived from seeds, never read from account data? |
| **Rent-exempt bypass** | `withdraw_sol` | Can the rent-exempt guard be bypassed by calling with `amount = lamports - min_rent + 1`? |
| **WSOL wrap/unwrap invariant** | `wrap_sol_in_vault`, `unwrap_wsol_in_vault` | Can the vault's lamport balance diverge from `WSOL ATA + native lamports`? Can sync_native be skipped? |
| **WSOL ATA hijack** | `wrap_sol_in_vault` | Can the WSOL ATA be created on an attacker-controlled authority and still satisfy the constraint check? |
| **`vault_burn_and_mint` source/dest** | bin-farm → bank-mint CPI | Can the CRANK source or BANK destination be redirected off the vault? |
| **`vault_vote` gauge constraints** | bin-farm → gauge-voter CPI | Are gauge PoolGauge accounts owner-checked (see audit.md M-03)? Does vault_vote propagate this check? |
| **`deduct_gas` drain** | Every user-facing ix | Can an attacker spam operations (e.g. `wrap`/`unwrap` or `claim_fees`) to drain a victim's vault via accumulated gas deductions? Is there any per-op or per-epoch cap? |
| **`update_gas_lamports` attack** | Admin-only | Is there a timelock? Can the admin spike `gas_lamports` to drain all vaults in one sweep? What's the upper bound? |
| **Missing `close_vault`** | bin-farm | Users cannot reclaim vault PDA rent. Any attack path that creates + abandons vaults to grief rent? |
| **Account substitution** | All instructions | Can an attacker pass a fake `Config`, `Position`, `Vault`, `UserVault`, or `RoverAuthority`? Are all PDAs properly derived and verified? |
| **Remaining accounts injection** | `harvest_bins`, `close_position`, `open_fee_rover`, `vault_vote` | Can malicious remaining_accounts drain funds or alter behavior? |
| **Arithmetic overflow/underflow** | Fee calcs, bin math, supply cap, gas deduction | Can overflow bypass the 40/40/20 split? Can underflow in the supply cap allow infinite minting? Can repeated `deduct_gas` underflow vault lamports? |
| **Reentrancy via CPI** | All Meteora CPI calls | Can a malicious Token-2022 transfer hook reenter the program mid-instruction? |
| **Permissionless harvest griefing** | `harvest_bins` after `priority_slots` | Can an attacker front-run the bot to steal keeper tips? Can they grief by harvesting empty positions? |
| **Fee rover manipulation** | `open_fee_rover`, `sweep_rover` | Can an attacker manipulate the BidAskImBalanced position to extract value? |
| **Upgrade authority** | All 5 programs | Who holds upgrade authority? (Known: single key — see C-02 in audit.md) |
| **Close account drain** | `close_position`, `user_close`, `apply_emergency_close` | Does closing return all lamports to the right destination? See L-02, M-01 in audit.md. |
| **Timelock bypass** | `propose_revenue_dest` / `apply_revenue_dest` | Can the timelock be bypassed? Can `set_trader_dest` be abused (no timelock — see M-02 in audit.md)? |
| **Token-2022 hooks** | All token transfers | bin-farm passes `empty_hooks()` — can a hook-bearing token brick a position? (Known: H-01 in audit.md, program upgrade needed) |
| **Flash loan + vote** | `gauge_voter` `vote()` | Accepted by design — verify the economic analysis still holds at current scale. |
| **Merkle proof forgery** | `merkle_distributor` `claim()` | Can a forged proof drain the vault? Is keccak256 actually being used now (fixed in C-01)? |
| **Cumulative claim overflow** | `claim()` cumulative accounting | Can `cumulative_amount - already_claimed` underflow? Can a user claim more than entitled? |
| **Epoch manipulation** | `new_epoch()` | Can a stale or replayed Merkle root be submitted? Can epoch be skipped? |
| **`drain_vault` destination** | `epoch_vault` `drain_vault()` | Destination is unchecked (known: L-05) — verify authority-gating is sufficient in current code. |
| **Bin range manipulation** | `open_position_v2` | Can an attacker open a position with a manipulated bin range that games fee collection? |

### 4.2 Off-Chain Attack Vectors

| Vector | Target | Question |
|--------|--------|----------|
| **Wallet-service tamper** | `data/crankbot.json` | DB holds PDA mappings, not keys. Can tampering redirect a user's vault to an attacker's? (Answer should be NO — `vault.owner` is re-derived from seeds on-chain.) |
| **Backup pipeline** | `scripts/backup-wallet-db.sh` | Per-minute convenience backup to DO Spaces. Can a compromised backup cause user re-registration or lock users out? |
| **RPC manipulation** | All on-chain reads | Can a malicious RPC return fake account data? Is there verification before acting on it? |
| **gRPC stream poisoning** | `geyser-subscriber.ts` | Can a compromised Helius endpoint feed fake events that trigger incorrect harvests? (Known: H-10 in audit.md) |
| **Priority fee manipulation** | Dynamic priority fees | Fee cap exists (fixed in H-02) — verify it holds and the cap value is sane. |
| **Race conditions** | `harvest-executor.ts` job queue | Can concurrent harvests double-spend or corrupt state? |
| **Stale price oracle** | `price-source.ts` (DexScreener + Pyth) | Pyth staleness check exists (L-09) — verify. DexScreener deviation guard exists (M-07) — verify the threshold. |
| **Discord command injection** | All 12 slash commands | Can crafted inputs cause unexpected behavior? Parser edge cases? Mcap/price range confusion? |
| **Relay API abuse** | `relay-server.ts` (15 endpoints) | Info disclosure? Auth bypass? The Bearer token gate (H-04) requires `RELAY_AUTH_TOKEN` — verify it's enforced and not leaked. |
| **WebSocket flooding** | `/ws` endpoint | Connection cap exists (H-05) — verify. |
| **Deploy script safety** | `scripts/deploy.sh` rsync | Does rsync properly exclude `data/`? Wallet DB loss = inconvenience (users re-register), NOT fund loss, but still degrades UX. |
| **PM2 crash loop** | `ecosystem.config.cjs` | Can an attacker trigger a crash loop that prevents harvesting? Death alerting exists (M-10) — verify. |
| **IPFS pinning** | `epoch-computer.ts` Pinata JWT | Can a compromised Pinata key inject false Merkle trees? |
| **Epoch crash recovery** | `epoch-computer.ts` staged progress | Recovery path exists (H-03) — verify it handles all failure modes (drain-but-not-wrap, wrap-but-not-publish, publish-but-not-claim). |

### 4.3 Economic Attack Vectors

| Vector | Question |
|--------|----------|
| **Gas deduction DoS** | Can a third party call user-facing instructions on behalf of a victim vault and drain it via `deduct_gas`? Is the operator gated? |
| **Sandwich attacks on fee rovers** | Fee rovers open BidAskImBalanced positions. Can an attacker sandwich the open/close to extract value? |
| **Dust position spam** | Can an attacker open many tiny positions to exhaust the bot's gas budget? Does the `deduct_gas` refund cover this? |
| **Keeper tip extraction** | Can someone profitably front-run every harvest to steal 10% keeper tips? |
| **Gauge weight manipulation** | Beyond flash loans: can a whale permanently skew pool weights to their advantage? |
| **Fee split gaming** | Can a position be structured to maximize fee extraction vs. actual trading value? |
| **Epoch-skip attack** | If the keeper misses a day, do funds get stuck? Can this be forced? |
| **Bridge vault drainage** | Can `sweep_rover` be called repeatedly to drain dust? |
| **Supply cap bypass** | Can `bank_supply + crank_supply` exceed 2B through any sequence of operations? |
| **Rent extraction via create_vault spam** | Can an attacker mass-create vaults to bloat on-chain state? Who pays the rent? |
| **Orphan ATA rent griefing** | Known (M-01): per-position vault ATAs are not closed on position close. Can this be amplified into a meaningful drain? |

### 4.4 Infrastructure & Operations

| Vector | Question |
|--------|----------|
| **Single point of failure** | One droplet, one bot keypair, one operator. What happens if the droplet dies? (Funds are safe in PDA vaults, but harvesting stops.) |
| **Bot keypair compromise** | Still the single biggest risk. Controls all 5 program authorities + `Config.bot` + drain authority. |
| **Backup integrity** | Are wallet DB (PDA mapping) backups verified? Verification exists (M-14) — confirm. |
| **SSH access** | Key-only? fail2ban configured? |
| **nginx rate limiting** | Effective against DDoS? Security headers in place (L-14)? |
| **Secrets management** | Where are bot keypair, Discord token, Pinata JWT, Helius gRPC key, `RELAY_AUTH_TOKEN` stored? File permissions? |
| **Dependency supply chain** | `package.json` pinned to exact versions (I-09) — verify. Any known vulnerabilities? |

---

## 5. KNOWN ISSUES (DO NOT RE-REPORT — VERIFY STATUS INSTEAD)

**First read `audit.md`** — it is the authoritative list of the 11 live open findings from the previous audit, the 3 pending-deploy findings (code ready but not yet on mainnet), and the 8 accepted informational items. Do not re-report any of these as new findings. If you find any of them **more severe** than currently documented, escalate and note the delta.

Additionally verify these known issues:

1. **PDA vault migration not deployed on mainnet** — Code is in the repo, IDL generated, binaries built, but `anchor upgrade` has not run. Existing positions must be force-closed first. Confirm the migration plan is sound.
2. **Keccak256 vs sha3-256** — Fixed in original C-01 via direct `@noble/hashes` import + startup self-test. **VERIFY** the import still resolves and the self-test still runs.
3. **Single bot keypair controls all authority roles** — Still open, see C-02 in audit.md. Verify no new authority was added that also funnels to this key.
4. **Price syncer swap execution disabled** — Arb detection works, swap execution pending direct Meteora DLMM integration. See M-09 in audit.md.
5. **$BANK has no token metadata** — Cosmetic. Verify no new security implications.
6. **Flash-loan voting is accepted by design** — Verify the economic analysis still holds at current TVL.
7. **Token-2022 transfer hooks unsupported on-chain** — H-01, needs program upgrade. Defense-in-depth via curator whitelist + `hasTransferHook()` detection. Verify the off-chain guards still reject hook-bearing mints.
8. **`close_vault` instruction missing** — Users cannot reclaim vault PDA rent. Confirm and assess whether this creates any griefing or UX attack surface.
9. **Epoch-computer never run live on mainnet** — 27 unit tests pass, dry-run script exists (`scripts/test-epoch.ts`). Untested in production.

---

## 6. AUDIT METHODOLOGY

For each component, apply these passes **in order:**

### Pass 1: Access Control
- Who can call each instruction/function?
- Are all signers verified?
- Are all PDAs properly derived with correct seeds? **Especially UserVault.**
- Can any authorization check be bypassed?
- Is the `authority` / `bot` / `owner` / `vault.owner` distinction enforced everywhere?
- Is `vault.owner` always derived from seeds, never trusted from account data?

### Pass 2: Arithmetic Safety
- Check every math operation for overflow/underflow
- Verify fee calculations (0.3% split into 40/40/20)
- Verify bin math (`binToPrice`, `priceToBin`, `binIdToBinArrayIndex`)
- Verify supply cap enforcement (`bank_supply + crank_supply <= 2B`)
- Verify `deduct_gas` cannot underflow vault lamports
- Check for precision loss in u64/u128 conversions
- Verify Merkle proof verification math

### Pass 3: State Consistency
- Can any instruction leave the system in an inconsistent state?
- What happens if a transaction partially fails?
- Are all state transitions atomic?
- Can state be corrupted by concurrent operations?
- Can `wrap_sol_in_vault` + `unwrap_wsol_in_vault` diverge vault lamport accounting from WSOL ATA balance?
- Are close/cleanup operations safe from race conditions?

### Pass 4: Economic Soundness
- Model the fee flow end-to-end: does every lamport go where it should?
- Model the gas reimbursement flow: bot pays network, vault refunds via `deduct_gas` — can this be gamed?
- Can any actor extract more value than intended?
- Are there extractable MEV opportunities?
- Is the keeper incentive structure sound?
- Does the gauge voting math preserve invariants?

### Pass 5: Input Validation
- Every external input (user commands, RPC data, gRPC events, API requests)
- Every on-chain account passed to instructions
- Every numeric parameter (amounts, bin IDs, BPS values, gas_lamports)
- Every string parameter (addresses, token symbols, range inputs)

### Pass 6: Cryptographic Correctness
- Merkle tree construction in `epoch-computer.ts`
- Keccak256 hash function usage (should be direct `@noble/hashes` now)
- PDA derivation correctness — especially the new `user_vault` PDA
- Any use of randomness

### Pass 7: Operational Security
- Secret storage (bot keypair, Discord token, Pinata JWT, Helius gRPC key, RELAY_AUTH_TOKEN)
- Backup integrity and disaster recovery
- Deploy safety (rsync exclusions, rollback plan)
- Monitoring gaps (what failures go undetected?)
- Single points of failure

### Pass 8: Dependency & Supply Chain
- Check `Cargo.toml` and `package.json` for known vulnerabilities
- Verify pinned versions (should be exact pins now per I-09)
- Check for typosquatting risk
- Verify Anchor version compatibility (0.31.1)
- Check for deprecated or unmaintained dependencies

---

## 7. SEVERITY CLASSIFICATION

Use this scale. Be precise — do not inflate or deflate.

| Severity | Definition | Example |
|----------|------------|---------|
| **CRITICAL** | Direct loss of user funds, or complete protocol compromise, exploitable today | PDA seed collision allowing cross-vault withdrawals |
| **HIGH** | Loss of funds under specific conditions, or systemic risk to protocol operation | Arithmetic overflow in fee calculation allowing drain |
| **MEDIUM** | Degraded security, economic inefficiency, or exploitable with significant effort | Stale price oracle causing incorrect bin placement |
| **LOW** | Minor issues, best practice violations, theoretical attacks | Missing input validation on non-critical parameter |
| **INFORMATIONAL** | Code quality, gas optimization, documentation gaps | Unused error variants, suboptimal CU budget |

---

## 8. SPECIAL ATTENTION AREAS

### 8.1 The PDA Vault Model (PRIMARY FOCUS)

This is the biggest uncharted attack surface. The entire custody model was replaced on 2026-04-08. Audit:

- **Seed binding:** Is `[b"user_vault", owner_wallet]` guaranteed unique? Can `owner_wallet` ever be an attacker-controlled address masquerading as a user?
- **Owner derivation:** Is `vault.owner` always derived from the seed, or is it ever read from account data (spoofable)?
- **Signer authority:** The bot signs every user-facing tx. What prevents the bot from withdrawing to an arbitrary address? (Answer should be: the PDA seed constrains `withdraw_sol` / `withdraw_token` destination to `vault.owner`.)
- **Gas deduction:** Is there any per-call, per-user, or per-epoch cap on `deduct_gas`? Can spam drain a vault?
- **WSOL accounting:** Can `wrap_sol_in_vault` / `unwrap_wsol_in_vault` break the invariant `vault_lamports_for_wsol == wsol_ata.amount`?
- **Cross-program CPI:** `vault_burn_and_mint` and `vault_vote` are CPIs to bank-mint and gauge-voter. Are the CPI signer seeds correct? Can the CPI be redirected?
- **Rent recovery:** No `close_vault` exists. Is this a griefing vector? Is there a cleanup plan?
- **Migration path:** The bin-farm upgrade requires force-closing all existing positions first. Is this atomic? What if the upgrade runs while a user has an open position?

### 8.2 The Merkle Distribution Pipeline

Still largely untested on mainnet (unit tests only):
- Merkle tree construction correctness (27 unit tests in `epoch-computer.test.ts`)
- Hash function (keccak256 via `@noble/hashes` — verify the self-test fires)
- Cumulative accounting (can someone claim more than entitled?)
- What happens if epoch-computer crashes mid-pipeline? (Recovery added per H-03 — verify all failure modes)
- IPFS pinning — is the CID verified against the on-chain root?
- Epoch claim bundles `claim() + unwrap_wsol_in_vault()` in a single tx — are both signed correctly? Who pays gas? (Answer: vault via `deduct_gas` on the unwrap.)

### 8.3 The Fee Rover Lifecycle

Complex multi-step flow with MEV exposure:
- `open_fee_rover` creates BidAskImBalanced DLMM positions — sandwichable?
- `sweep_rover` splits SOL — rounding errors accumulate?
- `close_exhausted_rovers` — can an attacker keep rovers open to prevent sweeps?
- What happens if a fee rover position is manipulated externally?

### 8.4 The Permissionless Harvest Path

After `priority_slots`, anyone can harvest:
- Front-running the bot for `keeper_tip_bps`
- Griefing by harvesting positions with zero filled bins
- Interaction between keeper tips and the 40/40/20 fee split
- Does the heartbeat/staleness check actually work?
- Does `deduct_gas` still fire if a third party harvests? Who gets reimbursed?

### 8.5 Cross-Program Interactions

5 programs that interact with each other AND Meteora:
- `bin_farm` → Meteora DLMM CPI (positions, harvests, bin arrays)
- `bin_farm` → `bank_mint` (new: `vault_burn_and_mint`)
- `bin_farm` → `gauge_voter` (new: `vault_vote`)
- `bin_farm` → `epoch_vault` (sweep_rover → bridge_vault)
- `epoch_vault` → `merkle_distributor` (drain → fund → distribute)
- Can any CPI be exploited via crafted return data?

### 8.6 Byte-Level Parsing

The geyser subscriber parses raw 904-byte LbPair account data:
- Are offsets correct? (`activeId @ 76`, `binStep @ 80`, mints @ 88/120, reserves @ 152/184, token program flags @ 880/881)
- L-10 startup validation added — verify the SDK cross-check still runs on boot.
- What happens if Meteora updates their account layout?
- Can malformed account data crash the subscriber?

---

## 9. REQUIRED OUTPUT FORMAT

Produce `audit-v2.md` with exactly this structure:

```markdown
# crank.money Security Audit Report (v2 — post PDA vault migration)

**Date:** [audit date]
**Auditor:** Claude (adversarial audit)
**Scope:** Full protocol — 5 on-chain programs, off-chain bot, SDK, Discord bot, infrastructure
**Primary focus:** PDA vault instructions + deduct_gas (never audited)
**Commit:** [git commit hash at time of audit]

## Executive Summary
[2-3 paragraphs: overall assessment, critical findings count, risk posture, delta vs. audit.md]

## Findings Summary Table
| # | Severity | Component | Title | Status |
|---|----------|-----------|-------|--------|

## Critical Findings
### C-01: [Title]
**Component:** [file path]
**Lines:** [line numbers]
**Description:** [what's wrong]
**Impact:** [what an attacker can do]
**Proof of Concept:** [step-by-step exploit path]
**Recommendation:** [specific fix]

[repeat for each severity class]

## High Findings
## Medium Findings
## Low Findings
## Informational Findings

## Known Issues Verification
[For each known issue from Section 5 AND each live finding from audit.md: current status, severity assessment, any escalation. Explicitly note which audit.md findings you verified are still open, still valid, and still correctly scoped.]

## Economic Model Review
[Fee flow analysis, gas reimbursement flow, MEV exposure, incentive alignment, game theory]

## Infrastructure Assessment
[Operational security, disaster recovery, monitoring gaps]

## Recommendations Priority Matrix
| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| 1 | ... | ... | ... |

## Appendix A: Files Reviewed
[Complete list of every file read during the audit]

## Appendix B: Tools & Methods Used
[What you checked, how you checked it]
```

---

## 10. RULES OF ENGAGEMENT

1. **Read `audit.md` first.** It has the live findings from the previous audit. Do not re-report them. Escalate only if you find them worse than documented.
2. **Read before you judge.** Read every file listed in Section 3. Do not make assumptions about code you haven't read.
3. **No false positives.** Every finding must reference specific lines of code. "This could potentially be an issue" is not a finding.
4. **No softballing.** If something is critical, say so. The PDA vault model is new and untested — if you find a flaw, that's a potential total loss of funds — don't downplay it.
5. **Verify known issues.** Section 5 lists what the team already knows. Verify current status and escalate if warranted.
6. **Think like an attacker.** For every finding, describe the exploit path. Who does it? What do they need? What do they get?
7. **Check the math.** Every fee calculation, every bin conversion, every supply cap check, every `deduct_gas` call — verify the arithmetic by hand.
8. **Check the bytes.** The geyser subscriber parses raw bytes. Verify every offset against the Meteora IDL and the L-10 startup validator.
9. **Follow the money.** Trace every lamport from vault deposit through harvest, fees, rovers, bridge vault, Merkle distribution, and back to vault ATAs. Find where money can leak.
10. **Test the edges.** What happens at `u64::MAX`? At bin ID -443636? At 0 BANK supply? At 2B supply cap exactly? At epoch 0? At vault lamports = min_rent?
11. **Don't skip infrastructure.** The deploy script, nginx config, PM2 setup, and backup pipeline are all attack surface.
12. **Prioritize PDA vault code.** It has never been audited. Everything else has had one pass.

---

## 11. CONTEXT THE TEAM WANTS YOU TO KNOW

- **PDA vault migration shipped 2026-04-08.** bin-farm program upgrade is built, IDL regenerated, but not yet deployed on mainnet. All existing positions must be force-closed first.
- **Bot is sole tx signer + fee payer.** Every user-facing instruction reimburses the bot via `deduct_gas(config.gas_lamports)` which transfers lamports from the user's vault PDA to `Config.bot`. 9 instructions deduct gas. Protocol operations (sweep_rover, fee rovers, epoch claims bundled with unwrap) are funded by the 20% operations split.
- **Both `revenue_dest` and `trader_dest` point to `bridge_vault`.** This is intentional — the 80% fee share (40% holders + 40% traders) all flows to one PDA for simplicity. The gauge_voter weights determine how epoch-computer splits the trader 40% across pools off-chain.
- **Token-2022 support is via V2 CPI only.** All V1 Meteora code has been removed. All 14 outbound transfers use `transfer_checked`.
- **Transfer hooks unsupported in bin-farm.** `RemainingAccountsInfo::empty_hooks()` is passed to all Meteora CPI. Defense-in-depth: curator.json whitelist + `hasTransferHook()` detection in keeper/buy/sell. Full hook resolution needs a program upgrade (H-01).
- **Flash-loan gauge voting is a known and accepted design tradeoff.**
- **`binIdToBinArrayIndex` uses `Math.trunc`, not `Math.floor`.** This is a deliberate fix for negative bin IDs. Verify it matches Meteora's SDK.
- **SOL price comes from Pyth, not DexScreener.** DexScreener was returning FOGO prices for SOL due to pair contamination.
- **$PEGGED is dead.** Related staking/bridge code was removed. `epoch_vault` is the former `pegged_bridge` with the same program ID, repurposed.
- **`wallet-service.ts` is NOT a keypair store.** It only maps Discord ID → owner wallet + tracks positions/votes/harvests. No encryption, no keypairs. DB loss = users re-register, NOT fund loss.
- **`signer.ts` signs only with the bot keypair.** It does not sign with user keypairs — they don't exist.
- **curator.json is the pool registry.** Multiple pools across several trading pairs.

---

## 12. GO

Read everything. Trust nothing. Find everything. Report everything.

Start with `audit.md` and `claude.md`. Focus on the PDA vault instructions. Don't re-report live findings.

Produce `audit-v2.md`.
