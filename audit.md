# crank.money Security Audit — Live Findings

**Original audit:** 2026-04-01 (commit `5194807f2231d8f607da5ac8d44f1f93c962e683`)
**Collapsed:** 2026-04-09 — post PDA-vault migration (2026-04-08)
**Server-side activation:** 2026-04-11 — RELAY_AUTH_TOKEN set (H-04 fully active), backup.key set (H-09 ready)
**Scope:** 5 on-chain programs, off-chain bot, SDK, Discord bot

---

## Why this document was collapsed

The original audit (53 findings, 33 remediated) was written against a **custodial
keypair architecture** — user funds held in encrypted keypairs in a flat JSON
file, protected by a single `WALLET_ENCRYPTION_KEY`. On 2026-04-08 that
architecture was replaced by **UserVault PDAs**: funds live on-chain, keyed by
the user's real Solana wallet, withdrawn only to `vault.owner` via PDA seed
derivation. Server compromise now loses zero user funds.

Eight findings from the original audit became moot — they described attacks on
a system that no longer exists. They are listed at the bottom under "Obsolete".
The 33 remediations that applied to code still in the repo stand as-is and are
not re-documented here — the fixes are in git history. This file contains only
the live findings plus the on-chain audit notes that remain current.

**Important:** The PDA vault instructions added in the 2026-04-08 migration
(`create_vault`, `withdraw_sol`, `withdraw_token`, `wrap_sol_in_vault`,
`unwrap_wsol_in_vault`, `vault_burn_and_mint`, `vault_vote`,
`update_gas_lamports`, plus `deduct_gas` on 9 instructions) **have not been
audited**. A fresh review is needed before mainnet upgrade.

For the full historical report with PoCs, see git history.

---

## Open findings

| # | Severity | Component | Title |
|---|----------|-----------|-------|
| C-02 | Critical | Architecture | Single bot keypair controls all authority roles |
| H-01 | High | bin-farm | Token-2022 transfer hooks cause permanent fund lock |
| H-10 | High | geyser-subscriber | No authentication on gRPC stream data |
| M-01 | Medium | bin-farm | Orphaned per-position vault ATAs lose ~0.004 SOL each |
| M-02 | Medium | bin-farm | set_trader_dest has no timelock (unlike revenue_dest) |
| M-04 | Medium | gauge-voter | remove_pool does not redistribute weight |
| M-09 | Medium | price-syncer | Trusts arbitrary Jupiter swap instructions (disabled) |
| L-01 | Low | bin-farm | Deposit transfers use raw SPL Transfer, not TransferChecked |
| L-02 | Low | bin-farm | Emergency close rent goes to caller, not position owner |
| L-05 | Low | epoch-vault | drain_vault destination unchecked (authority-gated) |
| L-06 | Low | gauge-voter | Rounding correction on first pool can fail at edge |

### Pending deploy (code ready, awaits `anchor upgrade`)

| # | Severity | Component | Fix |
|---|----------|-----------|-----|
| M-03 | Medium | gauge-voter | Owner check on `remaining_accounts` in `vote()` |
| L-03 | Low | bin-farm | `total_positions` decrement on close |
| L-04 | Low | merkle-distributor | `update_mint` requires old vault drained |

### Accepted informational (I-01 – I-08)

Saturating counters, LP-fee-on-close by design, unconstrained rover token
programs, `sweep_rover` not heartbeat-gated, unused `vault_bump` in `drain_vault`,
manual `SIZE` constant, `total_burned` cosmetic undercount, `init_if_needed` on
`ClaimStatus`. Documented, no changes planned.

---

## Critical

### C-02: Single keypair controls all authority roles

**Component:** Architecture (cross-cutting)
**Status:** Open — needs Ledger

One keypair (`BOT_KEYPAIR_PATH`) holds:
- Program upgrade authority for all 5 on-chain programs
- bin-farm `Config.authority` (pause, fee BPS, revenue dest, emergency close)
- bin-farm `Config.bot` (receives 20% of all protocol revenue)
- epoch-vault drain authority (can drain accumulated SOL to any address)
- merkle-distributor authority (can publish arbitrary Merkle roots)
- gauge-voter authority (add/remove pools)
- bank-mint authority
- Runtime tx signer for harvests, closes, keeper operations

The PDA vault migration removed user-side custodial risk, but every *protocol*
authority still resolves to this one key. Compromise = drain accumulated fees
(`drain_vault`), redirect 40% trader share instantly (`set_trader_dest`, see
M-02), publish fake Merkle roots, or upgrade programs to arbitrary code.

**Recommendation:**
- Cold admin key (Ledger): program upgrade, `Config.authority`, drain authority
- Hot bot key: `Config.bot`, runtime signer, keeper operations
- Extend timelock pattern to all admin operations (currently only fee BPS + `revenue_dest`)

---

## High

### H-01: Token-2022 Transfer Hooks Cause Permanent Fund Lock

**Component:** `programs/bin-farm/src/lib.rs:125-133`
**Status:** Open

bin-farm passes `RemainingAccountsInfo::empty_hooks()` to all Meteora CPI. A
position opened with a Token-2022 mint that has a mandatory transfer hook will
succeed on open, then fail at every harvest/close — hook extra accounts are
never provided. Position stuck, ~0.06 SOL rent permanently locked.

Defense-in-depth in place: `curator.json` mint whitelist, `hasTransferHook()`
detection in keeper/buy/sell. But a direct transaction bypassing the Discord
bot can still create a stuck position.

**Recommendation:** On-chain check in `open_position_v2` that reads mint account
data and rejects Token-2022 mints with the TransferHook extension. Program
upgrade required.

---

### H-10: No Authentication on gRPC Stream Data

**Component:** `bot/geyser-subscriber.ts:612-634`
**Status:** Open — inherent to Helius endpoint

gRPC stream from Helius LaserStream is trusted without data verification. A
MITM or compromised endpoint can inject fake `lb_pair` updates with manipulated
`activeId` values. The executor re-validates against RPC before executing, and
on-chain is the final authority — worst case is wasted gas on failed tx.
Sustained fake-event flooding could:

1. Exhaust bot SOL via failed tx fees
2. Trigger excessive `buildRegistry()` RPC load
3. Mask legitimate events in the processing queue

Partial mitigation: M-12 fix validates bin-farm `Position` discriminator on
large account updates; L-10 startup validation cross-checks Meteora byte offsets
against the SDK.

**Recommendation:** Verify gRPC TLS cert chain explicitly. Rate-limit
`handleLbPairUpdate` per pool. Cross-validate `activeId` changes against a
second RPC for large deltas.

---

## Medium

### M-01: Orphaned Per-Position Vault ATAs on Close

**Component:** `programs/bin-farm/src/lib.rs` (`close_position`, `user_close`)
**Status:** Open

The **per-position** Vault PDA (seeds: `[b"vault", meteora_position.key()]`)
holds token X and token Y ATAs during the position lifetime. On close, the
Vault PDA is closed (rent returned), but the ATAs are not closed first. Their
authority no longer exists — ~0.004 SOL per position (2 ATAs × ~0.002) is
permanently locked.

> Note: this is the *per-position* Vault PDA, distinct from the *per-user*
> UserVault PDA added in the 2026-04-08 migration. UserVault ATAs persist
> across positions and are not affected.

10K positions ≈ 40 SOL stranded.

**Recommendation:** Close vault ATAs before closing the Vault PDA, via
`invoke_signed` with vault seeds.

---

### M-02: set_trader_dest Has No Timelock

**Component:** `programs/bin-farm/src/lib.rs:1252-1266`
**Status:** Open

`revenue_dest` changes use a 24-hour timelock (propose/apply). `set_trader_dest`
takes effect immediately. A compromised authority can redirect 40% of sweep
revenue (trader share) instantly.

Combined with C-02, this is the fastest post-compromise drain vector.

**Recommendation:** Add the same 24-hour propose/apply pattern.

---

### M-04: remove_pool Does Not Redistribute Weight

**Component:** `programs/gauge-voter/src/lib.rs:86-101`
**Status:** Open

When a pool is removed, its `weight_bps` vanishes. The total across remaining
pools drops below 10,000 bps. The emitted event includes
`redistributed_weight_bps` which is misleading — no redistribution occurs.
Between removal and the next `vote()`, gauge weights sum to less than 10,000.

Self-heals on the next `vote()` (rounding correction forces sum back to 10,000),
but during the window, the epoch-computer would under-distribute the trader 40%.

**Recommendation:** epoch-computer MUST normalize by actual weight sum, not
assume 10,000. Alternatively, `remove_pool` should redistribute proportionally
before closing the account.

---

### M-09: Price Syncer Trusts Arbitrary Jupiter Swap Instructions

**Component:** `bot/price-syncer.ts:441-507`
**Status:** Open — swap execution currently disabled

Price syncer fetches swap instructions from Jupiter's API and executes them
faithfully. A compromised Jupiter endpoint could return malicious instructions
that drain the bot wallet. Currently mitigated because swap execution is
disabled pending direct Meteora DLMM swap integration.

**Recommendation:** When re-enabled, whitelist program IDs (Jupiter, Meteora,
SPL Token) in the deserialized instruction stream. Reject unknown targets.

---

## Low

### L-01: Deposit Transfers Use Raw SPL Transfer

**Component:** `programs/bin-farm/src/lib.rs:143-157, 1332-1346, 1569-1591`
User deposits use SPL Transfer (discriminator `3`), which does not verify mint
or decimals. All outbound transfers correctly use `transfer_checked`. Not
exploitable (Meteora CPI validates), but inconsistent.
**Fix:** `transfer_checked` for all transfers.

### L-02: Emergency Close Rent Goes to Caller, Not Position Owner

**Component:** `programs/bin-farm/src/lib.rs:2589, 2599`
`apply_emergency_close` closes Position and Vault PDAs to `caller`, not `owner`.
~0.004 SOL in PDA rent goes to the caller as execution incentive. Owner loses it.
**Fix:** Document clearly, or send rent to owner + separate tip mechanism.

### L-05: drain_vault Destination Is Unchecked

**Component:** `programs/epoch-vault/src/lib.rs:49-77`
Authority-gated but `destination` has no constraints. Bot can drain to ANY
address. Documented as intentional (bot drains to itself for WSOL wrapping).
**Fix:** Add `destination` field to BridgeConfig, set via timelocked admin ix.

### L-06: Gauge Voter Rounding Correction Edge Case

**Component:** `programs/gauge-voter/src/lib.rs:197-215`
If `total_new_bps > 10000` by more than the first pool's weight, `checked_sub`
returns error, reverting the tx. Max rounding error = N bps where N ≤ 32.
**Fix:** Adjust the largest-weight pool instead of always the first pool.

---

## Program audit notes (reviewed 2026-04-01, still current)

**epoch-vault** — Clean. `drain_vault` uses direct lamport manipulation on the
PDA (no CPI needed — vault is system-owned). `vault_bump` stored but unused in
`drain_vault` — not a bug. `destination` unchecked — see L-05.

**merkle-distributor** — Clean. `update_mint` authority-gated, validates new
vault ATA is owned by distributor PDA and denominated in new mint. Uses
`transfer_checked` via `token_interface` — works with SPL Token and Token-2022.
Cumulative accounting sound (delta from `cumulative_amount -
claim_status.cumulative_claimed`).

**gauge-voter** — Solid. PPB math uses u128 intermediates to avoid overflow.
Rounding dust correction on first pool is correct. Flash-loan voting
acknowledged and accepted (see below). `remove_pool` has the M-04 issue.

**bank-mint** — Clean. Supply cap invariant `bank_supply + crank_supply <= 2B`
checked on every `burn_and_mint`. PDA is sole mint authority (verified at
initialize).

**bin-farm** — 3054 lines (pre-migration). `sweep_rover` 40/40/20 hardcoded and
correct. `trader_dest` constraint validates against
`rover_authority.trader_dest` → `bridge_vault`. **PDA vault migration
(2026-04-08) added 8 new instructions and `deduct_gas` on 9 existing
instructions — not re-audited.**

**Cross-program:** Both `revenue_dest` and `trader_dest` point to
`bridge_vault` (`B9gTfe...`). 40% + 40% = 80% to the same account, sequential
lamport adds in a single instruction — no race. Remaining 20% → `Config.bot`.

---

## Economic model review (2026-04-01, still current)

**Fee math verified:**
- `harvest_bins`: `(amount as u128) * fee_bps / 10_000` with u128 intermediates
- `sweep_rover`: `holder = sweepable * 4000 / 10000`, `trader = sweepable * 4000 / 10000`, `operator = sweepable - holder - trader` (rounding dust → operator)

**Lamport leakage points:**
1. Orphaned per-position vault ATAs (~0.004 SOL/close) — M-01
2. Rent-exempt minimums in `rover_authority` and `bridge_vault` — by design

**MEV exposure:**
1. **Fee rovers:** Sandwichable in theory — position is small (protocol fees
   only), spread across 69 bins. Sandwich profit minimal vs. gas cost.
2. **Permissionless harvest front-running:** After `priority_slots` (100 slots,
   ~40s), anyone can harvest and earn `keeper_tip_bps` (10%). At 0.3% fee rate,
   the tip is 0.03% of position value — likely below MEV threshold.
3. **No sandwich risk on user positions:** Single-sided limit orders; deposit
   doesn't move the market. Harvest triggered by price movement that already
   occurred.

**Flash-loan gauge voting:** Accepted by design. Incremental revenue from
weight manipulation must exceed flash-loan swap fees (~0.3%) + interest. At
current protocol scale, economics don't favor the attack. Reassess at higher
TVL.

---

## Remaining priority matrix

| Priority | Finding | Effort | Category |
|----------|---------|--------|----------|
| 1 | **PDA vault audit pass** (8 new instructions + `deduct_gas`) | 4-8 hrs | Must-do before upgrade |
| 2 | **C-02:** Keypair separation (cold admin + hot bot, Ledger) | 4-8 hrs | Architecture |
| 3 | **M-03:** gauge-voter owner check (code ready) | 30 min | Program upgrade |
| 4 | **L-03:** `total_positions` decrement (code ready) | 30 min | Program upgrade |
| 5 | **L-04:** merkle-distributor drain check (code ready) | 30 min | Program upgrade |
| 6 | **M-02:** Timelock on `set_trader_dest` | 1 hr | On-chain (future) |
| 7 | **H-01:** On-chain transfer hook guard | 2-4 hrs | On-chain (future) |
| 8 | **M-04:** `remove_pool` weight redistribution | 1 hr | On-chain (future) |
| 9 | **M-01:** Orphaned per-position vault ATAs | 2 hrs | On-chain (future) |
| 10 | **H-10:** gRPC rate limit + cross-validate | 2 hrs | Defense-in-depth |
| 11 | **M-09:** Jupiter swap validation (when re-enabled) | 30 min | Off-chain |
| 12 | **L-01, L-02, L-05, L-06** | Various | Low priority |

---

## Obsolete findings (superseded by PDA vault migration, 2026-04-08)

These described a custodial keypair architecture that no longer exists. Listed
for historical completeness — no action required.

| # | Why obsolete |
|---|--------------|
| C-03 | Wallet encryption key in plaintext `.env` → no encryption key exists |
| H-09 | Wallet DB backups unencrypted → DB has no secrets, backups are convenience |
| M-05 | Withdraw address hijack → withdraw is `vault.owner`, baked into PDA seed |
| M-06 | Wallet DB world-readable → DB holds no secrets, only PDA mappings |
| M-08 | Custodial keys in JS heap → no custodial keypairs exist |
| M-13 | Key rotation gap → nothing to rotate |
| L-07 | Sync flush data loss window → wallet data is reconstructable from chain |
| L-16 | Old rotation backups accumulate → no rotation |

**H-08** (bot runs as root) was originally marked fixed, but the `crankbot`
service user was never provisioned and deploy script reverted to `root`.
Accepted operational tradeoff under the current stateless-operator model — the
bot holds no user keys, RCE blast radius is limited to protocol authority
(which is the C-02 concern, not a user-fund concern).

---

## Known issues status

- **KI-1** (keccak256 fallback): Fixed in original C-01 — direct `@noble/hashes` import + startup self-test
- **KI-2** (single keypair): Open — see C-02
- **KI-3** (price syncer swap disabled): Unchanged — see M-09
- **KI-4** ($BANK metadata missing): Unchanged — not a security issue
- **KI-5** (flash-loan voting accepted): Unchanged — see Economic Model Review

---

*Original audit 2026-04-01. PDA vault migration 2026-04-08. This document
reflects live findings as of the migration. The 33 remediated findings and
full PoCs from the original audit are available in git history.*
