# crank.money Security Audit Report (v2 — post PDA vault migration)

**Date:** 2026-04-12
**Auditor:** Claude (adversarial audit, fresh-context pass)
**Scope:** Full protocol — 5 on-chain programs, off-chain bot, SDK, Discord bot, infrastructure, Protocol-LP bot
**Primary focus:** PDA vault instructions + `deduct_gas` (deployed unaudited 2026-04-09)
**Commit:** `80bb9540501e449b5bf699df30ae4df7c5fdff42` (`80bb954`)
**Companion document:** `auditv1.md` — live findings from 2026-04-01 audit (do not duplicate)

---

## Addendum: Post-Amendment State (2026-04-13)

This audit was written against commit `80bb954` on 2026-04-12. One day later,
the Capture the Bag amendment and a same-day non-custodial distribution fix
shipped. The amendment changed the fee split, the sweep destinations, and the
`new_epoch` semantics of both distributors. This addendum re-evaluates each v2
finding against current-state code and notes four new findings surfaced by
the amendment. The original audit body below is preserved verbatim — re-scoring
is deliberately avoided; this is an append-only update.

### What changed since commit `80bb954`

- **bin-farm upgraded.** 40/40/20 hardcoded split replaced with curve-driven
  `sweep_rover` (`compute_curve(current_supply, initial_supply, burn_enabled)`).
  Three destinations: `burn_sol_vault` (new bin-farm-owned PDA), `trader_dest`
  (bridge_vault), `Config.bot`. `RoverAuthority` gained `initial_crank_supply`
  + `burn_enabled` carved from `_reserved`.
- **New bin-farm instructions:** `set_fee_bps` (direct setter, replaced
  `propose_fee`/`apply_fee` timelock), `initialize_burn_curve` (one-shot),
  `set_burn_enabled` (kill switch), `wrap_burn_sol`, `open_rover_bid_position`,
  `rover_burn_and_mint`. Fee bumped 30 → 50 bps.
- **New program deployed:** `bank-distributor` at
  `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M`. Fork of merkle-distributor
  with separate `declare_id!`. Parallel BANK distribution.
- **`new_epoch` rewritten on BOTH distributors (non-custodial).** Removed
  `funder_ata`, `mint`, `token_program`, `epoch_amount`. Now takes
  `(merkle_root, ipfs_cid)` only. Computes `epoch_amount = vault.amount +
  total_amount_claimed − total_amount_funded` on-chain. No transfer. Vault
  pre-funded by program flows (rover_burn_and_mint for BANK; drain_vault +
  sync_native for SOL).
- **Keeper:** 6-step daily sequence → 8 steps. Added `crankOpenRoverBids` +
  `crankRoverBurnAndMint` before epoch distribution. Added CRANK fee bypass
  in `crankOpenFeeRovers`. Dual-tree epoch (SOL + BANK).

### Per-finding status after the amendment

| ID | Post-amendment status | Notes |
|----|----------------------|-------|
| v2-C-01 | **Still open** | `/start` unchanged; no signature proof. |
| v2-C-02 | **Still open** | `propose_emergency_close` still targets any position. |
| v2-H-01 | **Still open** | `update_gas_lamports` still unbounded + no timelock. |
| v2-H-02 | **Still open** | `wrap_sol_in_vault` destination ATA still unchecked. (Note: the new `wrap_burn_sol` is for a bin-farm-owned vault only, not user vaults — less exposed but same pattern; see NEW-02 below.) |
| v2-H-03 | **Still open** | `harvest_bins` permissionless fallback still fires `deduct_gas` on zero-yield calls. |
| v2-H-04 | **Still open** | Wallet-DB rollback can still strand cumulative claims. The new non-custodial `new_epoch` doesn't change cumulative-entitlement semantics. |
| v2-H-05 | **Still open** | `registerUser` still allows multiple Discord IDs → same owner wallet. |
| v2-H-06 | **Still open** | Bearer auth fail-open + non-constant-time compare unchanged. |
| v2-H-07 | **Still open** | `/ws` WebSocket still has no auth. |
| **v2-H-08** | **Mitigated** | The old resubmit-drain vector required passing an attacker-controlled `epoch_amount`. The new `new_epoch(root, ipfs_cid)` takes no amount argument and the on-chain vault-balance delta is idempotent across resubmissions — publishing the same root twice produces identical state transitions. The previous H-08 exploit path is dead. Resume-path operational concerns (partial writes to `epoch-progress.json`) are unchanged — still covered by v2-M-09. |
| v2-H-09 | **Still open** | `apply-emergency-close.ts` still references `data.owner`; broken. |
| v2-M-01 … v2-M-09 | **Unchanged** | No structural changes to the affected components. |
| v2-M-10 | **Still open + applies to rover bids** | Deterministic 2-SOL + 70-bin-below-active threshold pattern now also applies to `crankOpenRoverBids` on the CRANK/SOL pool. Same MEV-sandwichable risk class as protocol-lp. Worth calling out explicitly in any future ops runbook. |
| v2-M-11 | **Unchanged** | IPFS CID still not locally verified against tree bytes — applies to both SOL tree and new BANK tree. |
| v2-M-12 | **Unchanged** | `deduct_gas` silent under-deduction unchanged. |
| v2-L-01 … v2-L-13 | **Unchanged** | No structural changes. |
| v2-I-01 … v2-I-06 | **Unchanged** | |

### New findings from the amendment

**NEW-01 (Low): `rover_burn_and_mint` destination is caller-supplied.**
**Component:** `programs/bin-farm/src/lib.rs` (new instruction).
`bank_distributor_vault: AccountInfo` is passed by the keeper and only
validated via `transfer_checked` mint+decimals (via `BANK_MINT_DECIMALS`
constant). Nothing on-chain constrains it to be the actual bank-distributor
vault PDA's ATA. The keeper always passes the correct destination, but a
compromised bot could point it at a bot-controlled ATA, recapturing the
custody vector the non-custodial rewrite eliminated.
**Impact:** Sub-issue of C-02. Not an external attacker vector. Still worth a
bin-farm upgrade adding `constraint = bank_distributor_vault.owner ==
bank_distributor_pda && bank_distributor_vault.mint == BANK_MINT`.
**Recommendation:** Hardcode the bank-distributor PDA + mint in the
instruction's account context. One-line constraint add on next bin-farm
upgrade.

**NEW-02 (Info): `wrap_burn_sol` destination (`rover_wsol_account`) is
constrained by owner but not by mint.**
**Component:** `programs/bin-farm/src/lib.rs` `WrapBurnSol` context.
The constraint `rover_wsol_account.owner == rover_authority.key()` is
present. Mint is implicit via the owner being rover_authority and the WSOL
ATA derivation — but not enforced on-chain. Keeper always passes the correct
WSOL ATA; a compromised bot could substitute a different owner-rover ATA
(e.g. a different token owned by rover) — but `sync_native` would fail on a
non-WSOL account, so this is bounded. Info-level: harden in the next upgrade
via `constraint = rover_wsol_account.mint == NATIVE_MINT`.

**NEW-03 (Info): `RoverAuthority.initial_crank_supply` is immutable with no
recovery path.**
**Component:** `initialize_burn_curve` one-shot in bin-farm.
If the snapshot is taken at the wrong moment (e.g. during a large CRANK
mint or burn), the curve behaves incorrectly forever. Current snapshot
(`1,935,388,154,207,285`) was taken 2026-04-13 on a stable supply; risk has
already passed. Documenting for future deploys on other tokens.
**Recommendation:** None urgent. If ever repeated (other tokens, governance
vote), require a two-step confirm + off-chain attestation of the snapshot
value.

**NEW-04 (Info): Non-custodial `new_epoch` eliminates v1 C-02's
reward-token-custody attack surface entirely.**
Positive change. The v1 executive summary characterized C-02 as "protocol's
worst-case loss is bounded only by the speed of an attacker holding the bot
key." Post-amendment, the bot key can still: flip the kill switch (routes
SOL to `Config.bot` — still goes to the normal protocol skim destination, no
external exfil), upgrade programs (largest remaining blast radius),
`propose_emergency_close` (v2-C-02 — 24hr delay, requires price coordination
for profit). It can **no longer** steal reward tokens mid-distribution.
**Recommendation:** Update the v1 C-02 risk posture in any future executive
summary. The keypair-separation priority is unchanged but the worst-case
impact is narrower.

### Executive summary addendum

Insert after the last paragraph of the Executive Summary below:

> **Update 2026-04-13:** The Capture the Bag amendment eliminated the
> reward-token-custody attack surface entirely. Both distributor `new_epoch`
> instructions now publish merkle roots only — the vaults are pre-funded by
> program flows and the on-chain instructions never move tokens. Combined
> with the PDA vault migration, this removes the two primary operator-custody
> vectors: user principal (solved 2026-04-08 by PDA vaults) and reward
> distribution flow (solved 2026-04-13 by non-custodial new_epoch). The
> remaining bot-key blast radius is program upgrades + emergency close +
> kill switch — all still serious, but bounded to griefing and infrastructure
> attacks, not direct reward-fund theft.

---

## Executive Summary

This audit re-targets crank.money after the 2026-04-08 PDA-vault migration removed all custodial keypairs and replaced them with on-chain `UserVault` PDAs seeded by `[b"user_vault", owner_wallet]`. The migration is architecturally sound — `vault.owner` is consistently re-derived from PDA seeds across all 8 new instructions and the 9 retrofitted `deduct_gas` callsites, and `withdraw_sol`/`withdraw_token` correctly constrain destinations to `vault.owner`. Two wallets cannot collide. The custodial code is gone (no `Keypair`, no encryption, no decrypt path) — `signer.ts` is bot-only, `wallet-service.ts` is a pure mapping store, `deposit-detect.ts` is a passthrough.

**However, the audit surfaced 4 issues at CRITICAL/HIGH severity in the new surface area:**

1. **`/start` accepts any Solana wallet address with no ownership proof** (CRITICAL). An attacker can claim a victim's wallet, blocking the victim from ever onboarding (the on-chain `createVault` is `init`, not `init_if_needed` — second call reverts) and quietly opening positions / votes against any SOL the victim later deposits. Funds remain withdrawable only to the genuine owner via PDA seed enforcement, so this is a sustained griefing + governance-hijack vector, not direct theft.
2. **`update_gas_lamports` has no upper bound and no timelock** (HIGH). An admin (= bot keypair under C-02) can spike gas to `u64::MAX`, then a single permissionless `harvest_bins` call against each vault drains all non-rent lamports in one sweep.
3. **`wrap_sol_in_vault` does not constrain the destination WSOL ATA** (HIGH). With bot-keypair compromise, vault SOL can be redirected to any account in a single call — bypassing the `withdraw_sol` owner-destination guard.
4. **Permissionless `harvest_bins` fires `deduct_gas` even on zero-yield calls** (HIGH). After 40s of bot staleness, anyone can repeatedly call harvest with a single in-range bin id and pull `gas_lamports` out of the victim's vault into their own wallet. At 125k lamports/op against thousands of positions during any bot outage, this is a measurable drain.

The Merkle distribution pipeline (Epoch 1 distributed 0.023 SOL on 2026-04-09) is mostly clean — keccak256 self-test fires, hash layout matches the on-chain verifier, cumulative accounting is sound — but the resume-from-progress path lacks on-chain idempotency checks and `epoch-progress.json` writes are non-atomic. A wallet-DB rollback combined with the cumulative scheme can permanently lock a user out of past entitlements (HIGH-04).

The single-keypair concentration risk (v1 C-02) remains the dominant threat. Several v2 findings are sub-issues of C-02: they would not be exploitable by external actors, but turn a bot-key compromise into instant total loss instead of capped drain. **Until the cold-admin/hot-bot split lands, the protocol's worst-case loss is bounded only by the speed of an attacker holding the bot key.**

**Risk posture vs. v1:** The migration eliminated 8 v1 findings (C-03, H-09, M-05, M-06, M-08, M-13, L-07, L-16) and reduced server-side blast radius dramatically. It introduced 4 high-severity issues in the new code path. Net: protocol is materially more secure for users than 2026-04-01, less secure on the operator-compromise axis (more code reachable from one key).

---

## Findings Summary Table

| # | Severity | Component | Title | Status |
|---|----------|-----------|-------|--------|
| v2-C-01 | Critical | discord-bot/start | `/start` allows claiming any wallet without signature proof | New |
| v2-C-02 | Critical | bin-farm | `propose_emergency_close` can target any user position; bot-key compromise → mass forced close | Worsens C-02 |
| v2-H-01 | High | bin-farm | `update_gas_lamports` unbounded + no timelock; one-shot drain vector | New |
| v2-H-02 | High | bin-farm | `wrap_sol_in_vault` destination ATA unchecked; bypasses withdraw owner-constraint | New |
| v2-H-03 | High | bin-farm | Permissionless `harvest_bins` fires `deduct_gas` on zero-yield calls | New |
| v2-H-04 | High | epoch-computer | Wallet-DB / progress rollback can permanently strand user cumulative claims | New |
| v2-H-05 | High | wallet-service | `registerUser` allows multiple Discord IDs to bind the same owner wallet | New |
| v2-H-06 | High | relay-server | Bearer auth fails open if `RELAY_AUTH_TOKEN` unset; non-constant-time compare | New |
| v2-H-07 | High | relay-server | `/ws` WebSocket has zero auth; leaks per-user trade events live | New |
| v2-H-08 | High | epoch-computer | Resume path re-submits `new_epoch` without on-chain idempotency check | New |
| v2-H-09 | High | scripts | `apply-emergency-close.ts` reads non-existent `data.owner` field — emergency rescue tool is broken | New |
| v2-M-01 | Medium | bin-farm | `vault_vote` forwards `remaining_accounts` to gauge-voter without owner check (inherits pending M-03) | Cross-ref |
| v2-M-02 | Medium | bin-farm | `withdraw_sol` rent guard hardcodes `UserVault::SIZE` constant | New |
| v2-M-03 | Medium | bin-farm | `vault_burn_and_mint` lacks defense-in-depth ATA owner constraints | New |
| v2-M-04 | Medium | bin-farm | `create_vault` rent permanently captured by first payer; no `close_vault` | New |
| v2-M-05 | Medium | wallet-service | `data/crankbot.json` writes are non-atomic; no schema validation | New |
| v2-M-06 | Medium | relay-server | `/api/positions` and `/ws` leak all users' vault PDAs and amounts to anyone with the shared token | New |
| v2-M-07 | Medium | discord-bot/close | `/close all` has no concurrency lock vs. in-flight harvest jobs | New |
| v2-M-08 | Medium | harvest-executor | Priority-fee retry loop can burn 0.8 SOL per griefable position | New |
| v2-M-09 | Medium | epoch-computer | `saveProgress` and `saveEpochState` non-atomic; partial JSON breaks resume | New |
| v2-M-10 | Medium | protocol-lp | Deterministic 2-SOL deployment threshold + fixed 70-bin offset = MEV-sandwichable | New |
| v2-M-11 | Medium | epoch-computer | IPFS CID not locally verified against tree bytes (Pinata-trust gap) | New |
| v2-M-12 | Medium | bin-farm | `deduct_gas` silent under-deduction; bot eats shortfall without event | New |
| v2-L-01 | Low | bin-farm | `withdraw_token` token_mint not program-owner constrained (transfer_checked catches) | New |
| v2-L-02 | Low | bin-farm | `unwrap_wsol_in_vault` returns ATA rent to caller; owner can race bot to pocket it | New |
| v2-L-03 | Low | bin-farm | `close_rover_position` could close third-party-funded rovers; rent to bot | New |
| v2-L-04 | Low | discord-bot/withdraw | `parseFloat`-based amount parsing loses precision >2^53 raw units | New |
| v2-L-05 | Low | discord-bot/range-parser | No upper bound on parsed values; pathological inputs reach on-chain | New |
| v2-L-06 | Low | epoch-vault | `drain_vault(amount=0)` drains everything; operator-typo footgun | New |
| v2-L-07 | Low | epoch-computer | Keccak self-test only at module import; not re-run per epoch | New |
| v2-L-08 | Low | scripts | `close-all-positions.ts` uses `skipPreflight: true` without local sim | New |
| v2-L-09 | Low | discord-bot | `getUserIdForOwner` collisions silently mis-route harvest DMs (sub-issue of v2-H-05) | New |
| v2-L-10 | Low | package.json | `helius-laserstream` uses `^0.3.1` caret range (other deps pinned per I-09) | New |
| v2-L-11 | Low | discord-bot/start | On-chain success / local-register failure leaves bot unable to recover cleanly | New |
| v2-L-12 | Low | discord-bot/close | `/close N` 1-based index unstable across in-flight closes | New |
| v2-L-13 | Low | scripts/backup | Verify-after-upload races itself when run per-minute | New |
| v2-I-01 | Info | bin-farm | `update_gas_lamports` emits no event | New |
| v2-I-02 | Info | bin-farm | `wrap`+`sync_native` invariant relies on caller bundling correctly | New |
| v2-I-03 | Info | geyser-subscriber | Helius x-token length logged at startup | New |
| v2-I-04 | Info | scripts/generate-clients | No CI check that local IDL matches deployed program | New |
| v2-I-05 | Info | discord-bot | `safety poll interval` docstring stale (says 5min, actual 5s) | New |
| v2-I-06 | Info | discord-bot/keeper | `GuildMembers` privileged intent added for crank-role pruner (2026-04-13); expands C-02 post-compromise blast radius from send-only to role-mutation | New |

---

## Critical Findings

### v2-C-01: `/start` allows claiming any Solana wallet with no ownership proof

**Component:** `packages/discord-bot/src/commands/start.ts:60–118`, `packages/core-sdk/wallet-service.ts:106–130`
**Description:** `/start wallet:<address>` validates that the string parses as a `PublicKey` (line 74) but never proves the caller controls it. The bot then signs `createVault({ owner: walletArg, … }).rpc()` (line 93–101), creating the on-chain UserVault with `owner = walletArg`, and writes the Discord-ID → owner mapping to `data/crankbot.json` via `walletService.registerUser` (line 104). `createVault` is `init` (not `init_if_needed`) — the second caller targeting the same `owner_wallet` reverts with "account already in use".
**Impact:**
- **DoS / squatting on real users.** Attacker pre-claims any real Solana address that may later try to use crank.money. When the legitimate owner runs `/start wallet:<their-address>`, the on-chain `createVault` reverts and the user receives a generic "Failed to create vault: account already in use" error. The legitimate user is blocked from registering with their own wallet under their own Discord ID. They can recover only by either (a) operator manually editing `data/crankbot.json` to reassign mapping, or (b) interacting on-chain directly bypassing the bot.
- **Governance hijack.** Attacker who claimed victim's wallet can freely call `/vote` and `/burn` on the victim's vault. If the victim ever sends $CRANK or BANK to the vault PDA address (it's a deterministic derivation — they will, if they ever try to use the protocol), the attacker can `/burn` it (locking BANK in vault) and `/vote` with it. Voting weight is permanently allocated by attacker.
- **Position-opening griefing.** Attacker can call `/buy` and `/sell` on the victim's vault. Funds remain withdrawable only to the real `vault.owner`, but each position open + close fires `deduct_gas` (125k lamports each). Any SOL deposited by victim can be drained to the bot via repeated open/close cycles.
- **Funds are NOT directly stealable** — `withdraw_sol`/`withdraw_token` enforce `destination == vault.owner` via PDA seed at the on-chain level. The attacker controls the position but not the exit.

**PoC:**
```
# Attacker (Discord user A)
/start wallet:9xQeWvG816bUx6EiwQc1ME35vXcK1cTwxXgKtVPwQYFf  # Vitalik's known Solana address
# Bot creates UserVault PDA with owner=Vitalik, A becomes Discord-side controller

# Vitalik (Discord user B, later)
/start wallet:9xQeWvG816bUx6EiwQc1ME35vXcK1cTwxXgKtVPwQYFf
# Bot tries createVault → on-chain "account already in use" → Vitalik blocked
```

**Recommendation:** Require a signed proof of wallet ownership before binding. Implementation:
1. `/start wallet:<addr>` issues a fresh nonce and instructs user to sign `"crank.money:start:<userId>:<nonce>"` with the wallet.
2. Provide `/start-confirm signature:<base58>` that verifies via `nacl.sign.detached.verify` against `addr`.
3. Only then call `createVault` and `registerUser`.

Short-term mitigation: in `registerUser`, also check `ownerIndex[ownerWallet]` and reject if already bound (covers v2-H-05). Add a recovery path so an operator can manually rebind a stolen claim.

---

### v2-C-02: `propose_emergency_close` can target ANY user position; with bot-key compromise it becomes mass-forced-close

**Component:** `programs/bin-farm/src/lib.rs:1186–1196` (`propose`), `:1202–1263` (`apply`), `:3398–3457` (context). Cross-ref `auditv1.md` C-02.
**Description:** Per the comment at line 1188, `propose_emergency_close` is intentionally permitted to target user positions ("intentional for stuck positions on deprecated pools"). Authority is the bot keypair (= sole admin under v1 C-02). After a 24-hour timelock, `apply_emergency_close` is permissionless. Funds return to `position.user_vault` (correct destination), but force-closing a single-sided limit order at a controlled `activeId` realizes IL the user otherwise would not have suffered.
**Impact:** With bot-key compromise: attacker (a) proposes emergency close on every active position in a single batch, (b) waits 24h, (c) at expiry, orchestrates a price move on the relevant pools (sandwich, dump), (d) calls `apply_emergency_close` permissionlessly during the bad price. Tokens go back to user vaults — but the user was holding a sell-the-rip waiting for a higher price; now they're sitting on token at the local bottom. Attacker extracts via separate position pre/post.
This is not a direct theft vector but realizes captured IL across the entire user base from one signature. The 24-hour delay is the only protection.
**PoC:** Compromise bot key → batch-call `propose_emergency_close(position)` for N positions in a single tx (limited only by CU). Wait 24h. Coordinate price drop on pools where users hold sell-positions. Permissionlessly call `apply_emergency_close` for each. Users' token-side positions get realized at the bottom; attacker's pre-positioned counter-trade profits.
**Recommendation:**
- Restrict `propose_emergency_close` targets to positions on a `is_deprecated` pool flag (set by separate authority-only ix) OR positions whose `position.user_vault` co-signs the proposal.
- Or: extend the timelock to 7 days for any position whose Meteora CPI has not been observed-failed on-chain (require a failed CPI signature as an unlock parameter).
- Until fixed, treat this as a major component of C-02's risk posture.

---

## High Findings

### v2-H-01: `update_gas_lamports` has no upper bound, no timelock, single-tx effect

**Component:** `programs/bin-farm/src/lib.rs:2223–2227`, `AdminOnly` context `:3377–3384`
**Description:**
```rust
pub fn update_gas_lamports(ctx: Context<AdminOnly>, gas_lamports: u64) -> Result<()> {
    ctx.accounts.config.gas_lamports = gas_lamports;
    Ok(())
}
```
No upper bound. No timelock. `deduct_gas` (`:2241–2245`) computes `available = vault.lamports - rent`, then `to_deduct = gas.min(available)` — will pull every available lamport out of the vault if `gas_lamports` exceeds the balance.
**Impact:** Admin (= bot keypair, C-02) sets `gas_lamports = u64::MAX`, then triggers any deduct_gas-bearing instruction against every vault. `harvest_bins` is permissionless after `priority_slots`, so the attack is one-shot on every vault: drain to rent-exempt minimum in a single tx per vault. Combined with v2-H-03, a third party that observes the gas-spike on-chain can race to be the gas recipient.
**PoC:** (1) `update_gas_lamports(u64::MAX)`. (2) For each open position, submit `harvest_bins(vec![activeBin])`. (3) Each call routes `vault.lamports - rent` to the caller's wallet via `deduct_gas`. (4) Drain protocol-wide in minutes.
**Recommendation:** Add a hard ceiling (`require!(gas_lamports <= 10_000_000, CoreError::GasTooHigh)` — 0.01 SOL absolute cap) and a 24h propose/apply timelock matching `set_revenue_dest`. Independently, `deduct_gas` should cap each deduction at a const protocol limit (e.g., `MAX_PER_OP_GAS = 1_000_000`) so a config corruption alone cannot drain.

---

### v2-H-02: `wrap_sol_in_vault` does not constrain the destination WSOL ATA — bypasses withdraw owner-constraint

**Component:** `programs/bin-farm/src/lib.rs:3249–3271` (context), `:2027–2028` (handler)
**Description:** `WrapSolInVault.vault_wsol_ata` is declared as `AccountInfo` with only `#[account(mut)]`. The handler at `:2027–2028` directly debits vault lamports and credits `vault_wsol_ata` via `try_borrow_mut_lamports`. Nothing checks that the destination is a WSOL ATA whose `authority == user_vault.key()` and `mint == NATIVE_MINT`. The doc comment promises this constraint exists — the constraint is not implemented.
The instruction is callable by `caller == config.bot || caller == user_vault.owner` (`:2013–2015`).
**Impact:**
- **Bot-keypair compromise (C-02 amplifier):** attacker signs `wrap_sol_in_vault(victim_vault, attacker_wallet, vault_lamports - rent)`. Lamports flow `victim_vault → attacker_wallet`. This bypasses the `withdraw_sol` destination constraint that limits funds to `vault.owner`.
- **Owner-as-caller is not a separate exploit** — the owner can withdraw to themselves and resend anywhere; their own funds are theirs. But the ability to redirect via `wrap_sol_in_vault` evades any future bot-side withdraw-velocity throttle or address-allowlist.
**PoC (bot-compromise):** Single tx: `wrap_sol_in_vault(amount = max, vault_wsol_ata = attacker_account)`. Lamport credit on the destination AccountInfo succeeds because Solana permits arbitrary lamport deposit. Attacker now holds vault's SOL in a regular system-owned wallet.
**Recommendation:** Constrain `vault_wsol_ata` properly:
```rust
#[account(
    mut,
    constraint = vault_wsol_ata.mint == anchor_spl::token::spl_token::native_mint::ID @ CoreError::InvalidMint,
    constraint = vault_wsol_ata.owner == user_vault.key() @ CoreError::InvalidAuthority,
)]
pub vault_wsol_ata: InterfaceAccount<'info, TokenAccount>,
```

---

### v2-H-03: Permissionless `harvest_bins` fires `deduct_gas` on zero-yield calls — griefer drains victim vault

**Component:** `programs/bin-farm/src/lib.rs:318–648` (handler), `:640–644` (deduct_gas), `:2853` (BotHarvest signer)
**Description:** `harvest_bins` allows any signer once `priority_slots` (~40s) of bot staleness has elapsed. The instruction at `:640–644` always calls `deduct_gas`, regardless of how much (if any) value was harvested. There is no early-return on `x_received == 0 && y_received == 0` — only a `msg!("warning")`.
**Impact:** During any bot outage (or one induced by a flood-attack on the relay), an attacker can submit `harvest_bins(vec![<any in-range bin>])` against every open position every ~40s. Each call costs the attacker ~5k lamports tx fee, drains 125k lamports (`config.gas_lamports`) from the victim's vault to the attacker's wallet, and earns the attacker the 10% `keeper_tip_bps` on any actual harvest. Net per call: ~120k lamports profit before considering harvest tip.
At 1,000 active positions × 1 call/40s × 0.0001 SOL = 0.1 SOL/40s = 9 SOL/hour drained from user vaults to attacker, independent of any actual conversion activity. Combined with v2-H-01, catastrophic.
**PoC:**
1. DoS the bot relay or wait for natural staleness.
2. For each position PDA, call `harvest_bins(remaining_accounts = [bin_arrays], bin_ids = vec![activeBin])` signed by attacker.
3. Even if `x_received == 0`, deduct_gas fires.
4. Attacker repeats every 40s.
**Recommendation:** In the permissionless path:
- Skip `deduct_gas` when `x_received + y_received == 0` (no value extracted), OR
- Always route `deduct_gas` recipient to `config.bot` (not to `caller`), so the user reimburses the protocol's actual fee-payer rather than an arbitrary caller. The keeper_tip is sufficient incentive for permissionless harvesters.

---

### v2-H-04: Wallet-DB / progress rollback can permanently strand user cumulative claims

**Component:** `bot/epoch-computer.ts:191–253, 315–319`, `programs/merkle-distributor/src/lib.rs:107–179`
**Description:** Distribution uses cumulative accounting: `delta = leaf.cumulative_amount - claim_status.cumulative_claimed`. The on-chain distributor stores only the latest `merkle_root` (single slot). If `data/crankbot.json` is restored from a per-minute backup after a crash and `state.cumulativeEntitlements` rewinds for some user X to a value LOWER than X's on-chain `claim_status.cumulative_claimed`, then for every subsequent epoch where X's new cumulative is still below the on-chain claimed value, X's claim reverts with `NothingToClaim` (`checked_sub` underflow → `Err`). X cannot fall back to the old root because it's been overwritten on-chain. X is silently locked out of past entitlements until cumulative re-crosses the on-chain claimed mark.
**Impact:** Every user whose harvest history rewinds during a DB restore loses access to undistributed-on-disk-but-already-claimed-on-chain shares until cumulative naturally catches up, which may never happen if their position was closed in the interim. Permanent partial loss from user's perspective.
**PoC:**
1. User has on-chain `cumulative_claimed = 1.0 SOL` and DB has `cumulativeEntitlements[user] = 1.0 SOL`.
2. Bot crashes. Operator restores `data/crankbot.json` from a backup taken before the harvest activity that produced the 1.0 SOL → `cumulativeEntitlements[user] = 0.5 SOL`.
3. Epoch N+1 adds 0.1 → cumulative 0.6 < 1.0 claimed → `NothingToClaim`.
4. User stays at zero new claims until cumulative > 1.0.
**Recommendation:**
- Before publishing each new tree, fetch `claim_status.cumulative_claimed` for every leaf; raise the leaf's `cumulative_amount` to `max(computed, on_chain_claimed)` OR abort the epoch with an alert.
- Migrate `cumulativeEntitlements` from overwrite-on-write JSON to an append-only log keyed by `(epoch, wallet)`. Reconstruct from the log on startup.
- Add operator-runbook check: before any DB restore, snapshot on-chain claim_status for all wallets and reconcile.

---

### v2-H-05: `registerUser` allows multiple Discord IDs to bind the same owner wallet

**Component:** `packages/core-sdk/wallet-service.ts:106–130`
**Description:** `registerUser(userId, ownerWallet)` checks `this.data.users[userId]` for an existing record but never inspects `this.data.ownerIndex[ownerWallet.toBase58()]`. Two Discord IDs can each register the same wallet; the last one wins for `ownerIndex`, breaking `getUserIdForOwner` reverse-routing used by harvest DM notifier and any per-user epoch logic.
**Impact:** Notifications, epoch-claim-reverse-routing, and any future "cancel pending op" UX for the rightful first registrant silently fail. Combined with v2-C-01, this is the implementation gap that allows the squatting attack to be silent (the legitimate user gets no notification that someone else claimed their wallet — they only discover it when `/start` reverts).
**Recommendation:** In `registerUser`, fail-fast if `this.data.ownerIndex[ownerStr]` exists and points to a different `userId`. Surface as `WalletAlreadyClaimed` error.

---

### v2-H-06: Relay Bearer auth fails open if `RELAY_AUTH_TOKEN` unset; non-constant-time compare

**Component:** `bot/relay-server.ts:528–535` (and surrounding)
**Description:** `if (authToken && path !== '/api/health') { … }` — when `RELAY_AUTH_TOKEN` is unset or empty, all 15 endpoints are open. The comparison `header !== \`Bearer ${authToken}\`` is non-constant-time. Comment ("backward compat") acknowledges the fail-open behavior. Per `claude.md`, the token IS set in production — but any env-reload bug, PM2 restart with stale environment, or rollback to an older `.env` silently degrades to fully open.
**Impact:** Silent security downgrade. Plus narrow timing-attack surface against the token (mitigated by TLS and the high-entropy of the token, but trivially fixable).
**Recommendation:** Fail closed: `if (!authToken) throw new Error('RELAY_AUTH_TOKEN required'); process.exit(1);`. Use `crypto.timingSafeEqual(Buffer.from(header), Buffer.from('Bearer ' + authToken))` for the comparison.

---

### v2-H-07: `/ws` WebSocket has zero authentication; leaks per-user trade events live

**Component:** `bot/relay-server.ts:441–479, 486–498`
**Description:** WebSocket upgrade requires only `url.pathname === '/ws'` — no token, no origin check, no per-IP throttle. On connect, server sends up to 50 cached feed events. Subsequent `harvestNeeded`, `harvestExecuted`, `positionClosed`, `roverTvlUpdated`, `activeBinChanged` events broadcast in real time and include `job.owner.toBase58()` (the user's vault PDA, which deterministically reveals which Solana wallet the activity belongs to via the seed `[b"user_vault", owner_wallet]` — though one-way without further enumeration, it is a stable identifier).
**Impact:** Anyone on the public internet can subscribe and:
- Build a cross-platform profile of every crank.money user's positions, sizes, and timing.
- Front-run discovered positions on Meteora directly (the vault PDA is sufficient to query position state).
- Exhaust connection slots by churning connections (100-cap is enforced but no per-IP rate-limit on connect).
**Recommendation:** Require `?token=` query param matching `RELAY_AUTH_TOKEN` (or a separate `WS_AUTH_TOKEN`) on upgrade. Add per-IP connect-rate limit (10/min). Redact `owner` from broadcast payloads — replace with a stable opaque hash.

---

### v2-H-08: Resume path re-submits `new_epoch` without on-chain idempotency check

**Component:** `bot/epoch-computer.ts:459–500`, particularly the `wrapped → published` transition
**Description:** Stage `wrapped` advances to `published` after `new_epoch` confirms, but if the RPC confirmation is dropped after the tx lands on-chain, `progress.stage` remains `wrapped`. On restart, `executeOnChainPipeline` re-enters the `wrapped` branch and resubmits `new_epoch` with the same root. The on-chain handler will overwrite `merkle_root`, increment `current_epoch`, and `transfer_checked` more WSOL — possibly succeeding (double-counting funded amount, advancing epoch twice for one logical epoch) or failing mid-way (leaving inconsistent state). `epoch-progress.json` is also non-atomically written (v2-M-09), so a corrupted file may force a fresh start while on-chain has already advanced.
**Impact:** Double-counted `total_amount_funded`, incorrect `current_epoch`, possible stranded WSOL in distributor vault if second `new_epoch` aborts after partial token transfer. Operationally, a stale-progress restart by an operator running `test-epoch.ts` against mainnet could overwrite a live root.
**Recommendation:** Before each stage in `executeOnChainPipeline`, fetch `distributor` account on-chain. If `distributor.merkle_root == progress.merkleRoot` (same root) and `distributor.current_epoch >= progress.epoch`, skip the `new_epoch` call and proceed to `claim` stage. Add explicit `assert(distributor.current_epoch === expected_epoch_before_new_epoch)` guard. Atomicize `saveProgress` writes (v2-M-09).

---

### v2-H-09: `apply-emergency-close.ts` reads non-existent `data.owner` field — emergency rescue tool is broken

**Component:** `scripts/apply-emergency-close.ts:52–54, 70–71`
**Description:** The `Position` struct (programs/bin-farm/src/lib.rs:2531–2542) has field `user_vault`, not `owner`. The script reads `data.owner as PublicKey`. At runtime this is `undefined`; `new PublicKey(undefined)` throws. The `owner_token_x/y` ATA derivations and the `owner` account passed to the on-chain ix are all wrong. Even if the deserialize step somehow returned an `owner` field, the on-chain `ApplyEmergencyClose.owner` constraint is `owner.key() == position.user_vault` — passing anything else reverts.
**Impact:** During a real emergency (Meteora pool deprecation, position bricked by hook-bearing token slipping past curator whitelist), the rescue tool does not function. Operator must hand-construct the tx.
**Recommendation:** `const owner = data.userVault as PublicKey` (Anchor camelCases `user_vault`). Add a devnet test fixture for this script.

---

## Medium Findings

### v2-M-01: `vault_vote` forwards `remaining_accounts` to gauge-voter without owner check (inherits pending M-03)

**Component:** `programs/bin-farm/src/lib.rs:2156–2220`
**Description:** The CPI loop at `:2201–2204` copies every `ctx.remaining_accounts` entry into the gauge-voter CPI as a mutable account. No pre-CPI check that `account.owner == GAUGE_VOTER_PROGRAM_ID`. With v1's pending M-03 fix not yet deployed in gauge-voter, the inner `vote()` instruction also lacks the owner check, so a malicious caller can pass attacker-owned look-alike accounts.
**Impact:** Governance manipulation: a vault owner can forward fake `PoolGauge` accounts and have gauge-voter mutate them under its own authority. Magnitude depends on what gauge-voter does with the mutated state, but as a class this allows weight injection on attacker-chosen targets.
**Recommendation:** Validate every remaining_account before CPI: `acc.owner == &GAUGE_VOTER_PROGRAM_ID`. Ideally derive the expected `PoolGauge` PDA from each `PoolAllocation.lb_pair` and require equality. Deploy v1 M-03 in the same release.

---

### v2-M-02: `withdraw_sol` rent guard hardcodes `UserVault::SIZE` constant

**Component:** `programs/bin-farm/src/lib.rs:1943–1949`
**Description:** Guard uses `Rent::get()?.minimum_balance(UserVault::SIZE)` (constant 41 bytes). If a future field is added without bumping `SIZE`, or Solana rent math changes, the guard under-reserves and the vault becomes rent-collected after withdraw, losing the PDA. Direct lamport mutation here is correct (vault is bin-farm-owned); the only safety is the rent calc.
**Impact:** Layout-drift latent bug. Currently safe (saturating_sub prevents underflow).
**Recommendation:** Use `user_vault.to_account_info().data_len()` rather than the constant.

---

### v2-M-03: `vault_burn_and_mint` lacks defense-in-depth ATA owner constraints

**Component:** `programs/bin-farm/src/lib.rs:3300–3342`
**Description:** `VaultBurnAndMint.vault_crank_ata` and `vault_bank_ata` are bare `AccountInfo` with only `#[account(mut)]`. Safety relies entirely on bank-mint's CPI callee constraints (`:196–210` enforces `associated_token::authority = user`). If bank-mint is ever upgraded loosely, bin-farm has no secondary check.
**Impact:** Currently safe via callee, but fragile.
**Recommendation:** Add `constraint = vault_crank_ata.owner == user_vault.key()` and same for `vault_bank_ata`. Mirror the pattern used in `withdraw_token` (which does this correctly).

---

### v2-M-04: `create_vault` rent permanently captured by first payer; no `close_vault`

**Component:** `programs/bin-farm/src/lib.rs:1916–1929`, `:3177–3195` (context)
**Description:** `create_vault` uses `init` with `payer = payer` — anyone can pay rent for any wallet. CLAUDE.md confirms `close_vault` is missing. Users can never reclaim vault PDA rent. If an attacker pre-creates vaults for a list of well-known wallets (v2-C-01 squatting), and a future `close_vault` is added, the rent refund destination question becomes important.
**Impact:** ~0.001 SOL × all squatted vaults captured by attacker (who also pays the rent — net-zero for attacker, lost permanently for victim).
**Recommendation:** Implement `close_vault` and either (a) track `rent_payer: Pubkey` in `UserVault` and refund to that pubkey, or (b) require `owner` to be a signer on `create_vault` (preferred — closes v2-C-01 simultaneously).

---

### v2-M-05: `data/crankbot.json` writes are non-atomic; no schema validation

**Component:** `packages/core-sdk/wallet-service.ts:70–81, 93–97, 127, 143`
**Description:** `fs.writeFileSync(filePath, JSON.stringify(...))` — synchronous but not atomic. Mid-write crash truncates the file; next start, `JSON.parse` throws or `emptyStore()` triggers (wiping all position/harvest tracking). On load, no schema validation — a tampered file with arbitrary `owner_wallet` values is loaded blindly. Per claude.md, DB loss is "inconvenience not fund loss" — but breaking position tracking breaks Merkle distribution accounting (per v2-H-04, can permanently strand claims).
**Impact:** Disk-full event corrupts DB; recoverable from per-minute backup but introduces v2-H-04 risk window. Tampered file mis-routes UI display (funds remain safe via on-chain seed enforcement).
**Recommendation:**
- Write to `${filePath}.tmp` then `fs.renameSync` (POSIX atomic).
- Add Zod schema validation on load. Quarantine records where `getUserVaultPDA(stored.owner_wallet)[0] !== stored.vault_pda`.
- On parse failure, attempt recovery from `${filePath}.pre-deploy` and `${filePath}.tmp` before falling through to `emptyStore`.

---

### v2-M-06: `/api/positions` and `/ws` leak all users' vault PDAs and amounts to anyone with the shared Bearer token

**Component:** `bot/relay-server.ts:625–659, 486–498`
**Description:** `handlePositions` returns `owner: pos.owner.toBase58()` (vault PDA), `initialAmount`, `harvestedAmount` for every position across all users. The single shared `RELAY_AUTH_TOKEN` gates this — anyone who has ever seen the token (ops staff, terminal history, log lines, settings backups, prior chat sessions) can enumerate every user's trading P&L.
**Impact:** Privacy disclosure of every user's positions and profit. Enables copy-trading and front-running.
**Recommendation:** Split into "public ops" and "admin" tokens. For analytics endpoints, redact `owner` to a stable opaque hash. For per-user endpoints, scope to a user-bound token (Discord OAuth or signed pubkey).

---

### v2-M-07: `/close all` has no concurrency lock vs. in-flight harvest jobs

**Component:** `packages/discord-bot/src/commands/close.ts:99–122`, `bot/harvest-executor.ts:125–132`
**Description:** `/close all` iterates positions and calls `closePosition` sequentially with no `withUserLock`. The executor's harvest-vs-harvest dedup uses `inflight` set keyed by position PDA, but does not coordinate with user-initiated closes. Race: user clicks `/close all` while gRPC-triggered harvest is mid-tx for the same position.
**Impact:** Partial execution, confusing failures, wasted gas. Not fund loss (on-chain idempotency rejects the loser), but UX degradation.
**Recommendation:** Wrap each close in `withUserLock(${userId}:${position.position_pda}, ...)`. The executor should acquire the same lock before submitting.

---

### v2-M-08: Priority-fee retry loop can burn 0.8 SOL per griefable position

**Component:** `bot/harvest-executor.ts:40–56`, `bot/retry.ts:6–20`
**Description:** `PRIORITY_FEE_CAP = 500_000` µL/CU × 400_000 CU = 0.2 SOL per tx. `withRetry` retries up to 4 times with exponential backoff. A griefer who can repeatedly cause a single position's harvest tx to fail (e.g., toggling state via micro-positions on the same bin array) makes the bot burn up to 0.8 SOL in priority fees per failed harvest.
**Impact:** Direct economic drain on the bot's operating budget. At 1 SOL/hour bot spend baseline, a sustained grief amplifies cost 5–10×.
**Recommendation:** Stop retrying on `SendTransactionError` from Meteora CPI specifically — those are deterministic failures that won't resolve. Track per-position failure rate and circuit-break (skip for 1h after 3 failures). Consider Jito-bundle submission to short-circuit the per-attempt priority fee.

---

### v2-M-09: `saveProgress` and `saveEpochState` non-atomic; partial JSON breaks resume

**Component:** `bot/epoch-computer.ts:138–144, 174–177`
**Description:** Direct `writeFileSync` without tmp+rename. Power loss or SIGKILL mid-write produces partial JSON. On startup, `loadProgress` catches the parse exception and treats as no-progress → re-runs `drain_vault` against a vault that may already have been drained. The vault-balance check at `:438–441` mitigates double-drain but wrap and publish stages have no equivalent on-chain idempotency check (see v2-H-08).
**Impact:** Combined with v2-H-08, can produce double-funded epochs or stranded WSOL.
**Recommendation:** Use the tmp+rename pattern from `tools/protocol-lp/state.ts:45–57`. Apply to both `saveProgress` and `saveEpochState`.

---

### v2-M-10: Protocol LP deployer threshold + bin offset is MEV-sandwichable

**Component:** `tools/protocol-lp/deployer.ts:41–42`, `tools/protocol-lp/config.ts:87`
**Description:** Deployment fires at `WSOL >= 2 SOL` (constant `MIN_REENTRY_LAMPORTS`), opening `activeId-70..activeId-1` with fixed slippage `50`. Anyone monitoring the LP wallet's WSOL balance can predict the deploy event, sandwich it, and capture value from the BidAsk-concentrated buy bins.
**Impact:** Predictable MEV extraction every cycle. Economic, not safety.
**Recommendation:** Randomize the threshold (±20%), randomize bin offset (±10), or submit as Jito bundle so the deploy tx isn't visible in the public mempool.

---

### v2-M-11: IPFS CID is not locally verified against tree bytes (Pinata-trust gap)

**Component:** `bot/epoch-computer.ts:355–379`, `programs/merkle-distributor/src/lib.rs:61`
**Description:** `ipfsCid` is taken from Pinata's `IpfsHash` response field and stored on-chain as `dist.ipfs_cid`. A compromised or malicious Pinata response could supply a CID that doesn't match the locally-uploaded bytes. On-chain Merkle proofs still validate against the true root, but users who fetch the tree via `ipfs.io/ipfs/<cid>` get a different tree (showing wrong entitlements). This is exploitable for phishing — "your real claim is X" displayed on a fake page driven by attacker tree.
**Impact:** UX confusion + phishing surface. Not direct fund loss.
**Recommendation:** Compute CID locally from the JSON bytes (`ipfs-only-hash` package) and `assert(localCid === pinataResponse.IpfsHash)`. Publish only the verified CID on-chain.

---

### v2-M-12: `deduct_gas` silent under-deduction; bot eats shortfall without event

**Component:** `programs/bin-farm/src/lib.rs:2241–2245`
**Description:** When a vault cannot afford the full `config.gas_lamports`, `deduct_gas` deducts `min(gas, available)`. Bot absorbs the difference. No event emitted. Long-tail of near-empty vaults silently subsidized by bot.
**Impact:** Operational; no security impact directly. Hides a class of free-rider behavior.
**Recommendation:** Emit `GasShortfallEvent { vault, requested, deducted, timestamp }` for monitoring.

---

## Low Findings

### v2-L-01: `withdraw_token` token_mint not program-owner constrained

`programs/bin-farm/src/lib.rs:3218–3244` — `token_mint` is bare `AccountInfo`. Mismatched mint is caught by `transfer_checked` decimals enforcement at CPI level, so unexploitable. Add `constraint = token_mint.owner == token_program.key()` for clarity.

### v2-L-02: `unwrap_wsol_in_vault` rent refund to caller — owner can race bot

`programs/bin-farm/src/lib.rs:2079–2082` — ATA rent goes to `caller`. Bot typically pays ATA rent on creation; if owner calls unwrap first, owner pockets ~0.002 SOL of bot operating cost. Minor unfairness, not a security issue. Route refund to `config.bot` explicitly.

### v2-L-03: `close_rover_position` may close third-party-funded rovers; rent to bot

`programs/bin-farm/src/lib.rs:1608–1736`, `:3691–3778` — constraint `position.user_vault == rover_authority.key()` matches both bot-funded fee rovers AND externally-opened rover positions (`open_rover_position` at `:1388+` sets the same field). Rent always returns to bot. External depositors lose ~0.004 SOL on close. Add `rent_payer` to Position; refund accordingly.

### v2-L-04: Discord `parseFloat` precision loss on large amounts

`packages/discord-bot/src/commands/withdraw.ts:160–165`, `commands/buy.ts:230–231` — `BigInt(Math.round(amount * 10^decimals))` loses precision for raw amounts > 2^53. Real for 6-decimal CRANK at 9B+ units. Use string-parse + manual split.

### v2-L-05: range-parser accepts unbounded values

`packages/core-sdk/range-parser.ts:36–53` — no upper cap on parsed `value`. Pathological input flows downstream. Cap at `value <= 1e15`.

### v2-L-06: `drain_vault(amount=0)` drains everything

`programs/epoch-vault/src/lib.rs:54` — `if amount == 0 { available }` is operator footgun. Bot never passes 0, but ad-hoc scripts might. `require!(amount > 0)`.

### v2-L-07: Keccak self-test only at module import

`bot/epoch-computer.ts:34–38` — re-run before each epoch tree build in case of memory corruption / hot-reload.

### v2-L-08: `close-all-positions.ts` uses `skipPreflight: true` without local sim

`scripts/close-all-positions.ts:129` — unlike `force-close-position.ts:112` which simulates first. Add local simulate; abort on `sim.value.err`.

### v2-L-09: `getUserIdForOwner` collisions silently mis-route DMs

Sub-issue of v2-H-05; covered there.

### v2-L-10: `helius-laserstream` uses `^0.3.1` caret range

`package.json:29` — only unpinned dep per I-09. Pin to exact `0.3.1`.

### v2-L-11: `/start` on-chain success / local-register failure recovery is brittle

`packages/discord-bot/src/commands/start.ts:92–118` — uses `.rpc()` not the `confirmAndCheck` pattern in `transactions.ts:234`. Wrap in try/catch with explicit `removeUser` compensation on partial failure.

**Update (2026-04-14):** The adjacent class of silent-failure bug — code calling `confirmTransaction()` without checking `confirmation.value.err` — was hit in production when a user's `/sell` landed in a block but failed execution (Custom:1 from under-funded vault) and the bot posted a false-positive "deposited" feed message. Migrated 7 call sites to `confirmAndCheck`: `packages/discord-bot/src/commands/buy.ts` ×2 (wrap + open), `packages/discord-bot/src/commands/close.ts`, `bot/harvest-executor.ts` ×2 (harvest + close), `bot/keeper.ts` ×2 (open_fee_rover + close_rover). L-11's specific `/start` finding remains open (it also needs the `removeUser` compensation logic on top of the confirmation check).

### v2-L-12: `/close N` 1-based index unstable

`packages/discord-bot/src/commands/close.ts:127–133` — list reordering between display and execute closes wrong position. Use PDA-prefix matching.

### v2-L-13: Backup verify-after-upload races itself

`scripts/backup-wallet-db.sh:39–57` — per-minute cadence + verify-against-latest creates spurious failures. Verify weekly or against timestamped object.

---

## Informational Findings

- **v2-I-01:** `update_gas_lamports` emits no `AdminConfigEvent`. Add for off-chain monitoring.
- **v2-I-02:** `wrap_sol_in_vault` requires caller to bundle a follow-up `sync_native` ix. If skipped, subsequent `unwrap_wsol_in_vault` reads a stale `amount=0` and routes wrapped lamports to `caller` as "rent". Bundle invariant should be enforced via a follow-up CPI in the same instruction or documented as a tx-builder requirement (it currently is, in code comments at `:2024–2026`).
- **v2-I-03:** `bot/geyser-subscriber.ts:560` logs Helius x-token length at startup. Drop the length, log only presence boolean.
- **v2-I-04:** `scripts/generate-clients.mjs` reads local IDL with no CI check vs. on-chain deployed program. Add `anchor idl fetch` diff to CI.
- **v2-I-05:** Safety-poll docstring at `bot/geyser-subscriber.ts:610` says "every 5 minutes"; constant at `:172` is `5 * 1000` (5 seconds). Update docstring.
- **v2-I-06:** Discord bot now requests `GatewayIntentBits.GuildMembers` when `DISCORD_ENABLE_MEMBER_INTENT=true` (added 2026-04-13 to support the crank-role pruner). Privileged intent — must be toggled in the Discord developer portal or the bot refuses login (first deploy hit exactly this). New post-compromise surface under C-02 (bot Discord token theft): attacker can now enumerate all guild members and remove the crank role in bulk; prior threat model was send-only. Mitigations: the pruner is gated (dry-run default, rate-limited by daily keeper cadence, reason-string logged on each `roles.remove`), and the Discord token is scoped to one guild. Recommend (a) separating the Discord token from the Solana bot keypair in the compromise blast-radius analysis, (b) enabling Discord's audit-log monitoring on the crank role, (c) leaving `CRANK_ROLE_PRUNE_DRY_RUN=true` until the candidate list is trusted.

---

## Known Issues Verification

Status of every live finding in `auditv1.md`, plus the prior audit's known issues:

| ID | v1 Status | v2 Verification | Delta |
|----|-----------|-----------------|-------|
| C-02 | Open | **Confirmed open. Worsened in practice** by v2-C-02 (emergency_close mass), v2-H-01 (gas spike), v2-H-02 (wrap drain). Cold/hot keypair split is now the single highest-impact remediation. | ↑ Severity in practice |
| H-01 | Open | Confirmed: bin-farm passes `RemainingAccountsInfo::empty_hooks()`. Defense-in-depth (curator whitelist + `hasTransferHook()`) verified in keeper/buy/sell. Status unchanged. | = |
| H-10 | Open | Confirmed. M-12 discriminator gate verified at `bot/geyser-subscriber.ts:118, 467–469, 582`. L-10 startup byte-offset validator verified at `:631–664`. Mitigations holding. | = |
| M-01 | Open | Confirmed: per-position vault ATAs not closed before per-position Vault PDA closes. ~0.004 SOL/close lost. Unchanged. | = |
| M-02 | Open | Confirmed: `set_trader_dest` no timelock. Combined with v2-C-02 and v2-H-01, this remains the fastest post-compromise drain vector. | = |
| M-03 | Pending deploy | Confirmed code-ready, not deployed. **Newly relevant** because v2-M-01 (`vault_vote`) inherits the gap. Deploy together. | ↑ Urgency |
| M-04 | Open | Confirmed at `programs/gauge-voter/src/lib.rs:86–101`. Verified epoch-computer normalizes by actual sum (epoch-computer.ts inspection — appears to handle non-10000 totals; recommend explicit assert). | = |
| M-09 | Open | Confirmed swap execution disabled. Code path safe. | = |
| L-01 | Open | Confirmed. | = |
| L-02 | Open | Confirmed at `:2589, 2599`. | = |
| L-03 | Pending deploy | Confirmed code-ready. Saturating-sub usage prevents underflow currently. | = |
| L-04 | Pending deploy | **Verified RESOLVED** in current source: `programs/merkle-distributor/src/lib.rs:208–211` requires `old_vault.amount == 0` before `update_mint`. Promote to "code-deployed-pending" verification — confirm on-chain program matches. | ↓ |
| L-05 | Open | Confirmed: `epoch-vault/src/lib.rs:49–77` destination unchecked, authority-gated. | = |
| L-06 | Open | Confirmed. | = |
| KI-1 | Fixed | Verified: keccak256 via `@noble/hashes` direct import in `bot/epoch-computer.ts:34–38` with self-test at module load. Test vector matches `9c22ff5f21...`. | ✓ |
| KI-2 | Open | = C-02. | = |
| KI-3 | Open | = M-09. | = |
| KI-4 | Open | $BANK metadata still missing. Cosmetic. | = |
| KI-5 | Accepted | Flash-loan voting economics still unfavorable at current TVL. Reassess at >$10M TVL. | = |

**Items obsoleted by PDA migration (C-03, H-09, M-05, M-06, M-08, M-13, L-07, L-16):** All confirmed obsolete. No vestigial code paths found in `wallet-service.ts` or `signer.ts`.

**Operational items completed per claude.md (verified):**
- `RELAY_AUTH_TOKEN`: code path active (with v2-H-06 fail-open caveat).
- `PINATA_JWT`: usage at `bot/epoch-computer.ts:355–379` (with v2-M-11 caveat).
- `gas_lamports = 125,000`: documented; no on-chain query performed in this audit.
- `emergency_close` cleared 2026-04-11: not on-chain-verified in this audit. **Recommend operator re-confirm** via `getAccountInfo(MeTGCG…)` and inspect `pending_emergency_close` and `emergency_close_at` fields are zero.
- Epoch 1 (0.023 SOL distributed 2026-04-09): not on-chain-verified in this audit. **Recommend** operator confirm distributor vault has no leftover WSOL beyond rent, and current Merkle root matches latest IPFS CID.

---

## Economic Model Review

### Fee-flow integrity (re-verified)
- `harvest_bins`: `(amount as u128) * fee_bps / 10_000` with u128 intermediates — no overflow.
- `sweep_rover`: 40/40/20 with rounding dust → operator. Sequential lamport adds to `bridge_vault` (revenue + trader, both pointing to same PDA) — no race.
- All 14 outbound transfers use `transfer_checked` (V2 / Token-2022 native).

### Gas reimbursement flow (new analysis)
The deduct_gas model is structurally sound for normal operation: bot signs and pays network fees; user reimburses fixed `config.gas_lamports` per op (currently 125K = ~0.000125 SOL). Bot recoups vault creation rent (~0.001 SOL) after ~8 user ops.

**Failure modes surfaced:**
1. **Unbounded gas spike (v2-H-01):** Single admin-key compromise drains all vaults in one sweep. Worst-case loss = sum(vault.lamports - rent) across all users.
2. **Permissionless harvest tax (v2-H-03):** External griefer extracts `gas_lamports` per call from any vault. Bounded only by attacker's tx-fee budget vs. `gas_lamports` margin (currently 25× — attacker pays 5K, gets 125K).
3. **Silent shortfall (v2-M-12):** Near-empty vaults consume bot operating capital without alert.

### MEV exposure
- **User positions:** Single-sided limit orders — deposit doesn't move market, harvest follows price move. No sandwich risk.
- **Permissionless harvest:** `keeper_tip_bps = 10%`; combined with v2-H-03 gas extraction, third-party harvest is now economically attractive against any vault with >0 fees AND >0 gas. Front-running the bot is profitable, not just neutral.
- **Fee rovers:** Spread across 69 bins, small-value. Sandwich profit < gas cost.
- **Protocol LP (v2-M-10):** Predictable BidAsk deploys. MEV-extractable per cycle.
- **Flash-loan voting:** Still uneconomic at current TVL.

### Supply cap
`bank_supply + crank_supply <= 2B` enforced per `burn_and_mint`. Verified at `programs/bank-mint/src/lib.rs`. PDA is sole mint authority.

---

## Infrastructure Assessment

### Single points of failure
- **One droplet** (NYC1, s-2vcpu-4gb). Funds safe in PDA vaults if it dies; harvesting halts — users' positions accumulate convertible bins until restoration.
- **One bot keypair** (C-02). Compounded by v2-C-02, v2-H-01, v2-H-02. Cold-admin/hot-bot split is the highest-leverage operational fix.
- **One Helius gRPC endpoint** (H-10). Sub-issue: stream exhaustion via fake events.
- **One Pinata account** (v2-M-11). Compromise enables phishing tree at on-chain CID.

### Disaster recovery
- Per-minute wallet DB backup to DO Spaces (encrypted). Verified at `scripts/backup-wallet-db.sh`. Note v2-L-13 race + v2-H-04 risk window during restore.
- No documented runbook for "bot keypair compromise detected" — cold-key separation is architectural prerequisite.
- No tested epoch-rollback procedure; v2-H-08 surfaces a path where stale progress overwrites a live root.

### Monitoring gaps
- No alerting on `update_gas_lamports` change (v2-I-01).
- No alert on persistent harvest CPI failures (v2-L-01-related).
- No alert on multiple Discord IDs claiming same wallet (v2-H-05).
- WebSocket connection patterns not instrumented (v2-H-07).
- gRPC parse-failure rate not alerted (would catch Meteora layout drift).

### Dependencies
- 14/15 npm deps pinned exactly per I-09.
- `helius-laserstream` uses `^0.3.1` (v2-L-10).
- Anchor 0.31.1 — current.
- `blake3` pinned to 1.5.5 for Rust 1.84 BPF compat.

### nginx
- HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy verified present.
- CORS restricted to crank.money origins (no localhost in production).
- Rate limit 10r/s burst 20.
- WebSocket limit 2 conns/IP at nginx layer (`v2-H-07` is at app layer — supplements this).

---

## Recommendations Priority Matrix

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| 1 | **v2-C-01:** `/start` ownership proof (signed nonce) | 4 hrs | Blocks user-squatting/governance hijack |
| 2 | **v2-H-01:** Cap + timelock `update_gas_lamports`; const cap in `deduct_gas` | 2 hrs | Removes one-shot drain via single admin call |
| 3 | **v2-H-02:** Constrain `vault_wsol_ata` mint + authority | 1 hr | Closes withdraw-bypass on bot compromise |
| 4 | **v2-H-03:** Skip `deduct_gas` on zero-yield permissionless harvest | 1 hr | Removes external griefer drain vector |
| 5 | **v2-H-04:** Reconcile cumulative entitlements vs on-chain claims before publishing tree | 4 hrs | Prevents permanent claim lock-out |
| 6 | **v2-H-05:** `registerUser` reject duplicate ownerWallet | 30 min | Companion fix for v2-C-01 |
| 7 | **v2-H-06:** Fail-closed relay auth + constant-time compare | 30 min | Removes silent open-by-default |
| 8 | **v2-H-07:** WebSocket auth + per-IP rate limit + redact owner | 2 hrs | Closes mass user-activity leak |
| 9 | **v2-H-08:** On-chain idempotency check before `new_epoch` resubmit | 2 hrs | Removes double-publish risk |
| 10 | **v2-H-09:** Fix `apply-emergency-close.ts` field name | 15 min | Restores emergency rescue tool |
| 11 | **v1 C-02 / KI-2:** Cold-admin / hot-bot keypair split (Ledger) | 1 day | Bounds blast radius across all bot-key drain vectors above |
| 12 | **v2-C-02:** Restrict `propose_emergency_close` targets | 1 day | Removes mass-IL-realization vector on bot compromise |
| 13 | **v1 M-03 + v2-M-01:** gauge-voter owner check + `vault_vote` pre-CPI validation | 2 hrs | Closes governance manipulation |
| 14 | v2-M-05, v2-M-09: atomic JSON writes | 1 hr | Prevents partial-state corruption |
| 15 | **v1 M-02:** Timelock on `set_trader_dest` | 1 hr | Bounds revenue-redirect compromise speed |
| 16 | v2-M-11: Local CID verification | 30 min | Closes Pinata phishing surface |
| 17 | v2-M-06: Split ops/admin tokens, redact owner | 4 hrs | Closes user-activity leak |
| 18 | v2-M-04 + missing `close_vault`: implement with `rent_payer` field | 4 hrs | UX + griefer-rent-recovery |
| 19 | Remaining Lows (v2-L-01 through v2-L-13) | 1 day total | Cleanup + minor surface reduction |

---

## Appendix A: Files Reviewed

**Prior audit context:**
- `auditv1.md`
- `claude.md`
- `reference/audit-prompt.md`

**On-chain (Rust):**
- `programs/bin-farm/src/lib.rs` (3971 lines — full read by sub-auditor)
- `programs/bin-farm/src/meteora_dlmm_cpi.rs`
- `programs/bank-mint/src/lib.rs`
- `programs/gauge-voter/src/lib.rs`
- `programs/merkle-distributor/src/lib.rs`
- `programs/epoch-vault/src/lib.rs`

**Off-chain bot:**
- `bot/anchor-harvest-bot.ts`
- `bot/geyser-subscriber.ts`
- `bot/harvest-executor.ts`
- `bot/keeper.ts`
- `bot/epoch-computer.ts`
- `bot/epoch-computer.test.ts`
- `bot/relay-server.ts`
- `bot/retry.ts`

**SDK:**
- `packages/core-sdk/wallet-service.ts`
- `packages/core-sdk/signer.ts`
- `packages/core-sdk/transactions.ts`
- `packages/core-sdk/pool-router.ts`
- `packages/core-sdk/range-parser.ts`
- `packages/core-sdk/price-source.ts`
- `packages/core-sdk/pda.ts`
- `packages/core-sdk/generated/bin-farm/instructions/*` (sampled discriminators)

**Discord bot:**
- `packages/discord-bot/src/index.ts`
- `packages/discord-bot/src/deposit-detect.ts`
- `packages/discord-bot/src/commands/{start,balance,deposit,buy,sell,withdraw,close,positions,vote,burn}.ts`

**Protocol-LP bot:**
- `tools/protocol-lp/index.ts`
- `tools/protocol-lp/harvester.ts`
- `tools/protocol-lp/deployer.ts`
- `tools/protocol-lp/config.ts`
- `tools/protocol-lp/state.ts`
- `tools/protocol-lp/health.ts`
- `tools/protocol-lp/ecosystem.config.cjs`

**Scripts:**
- `scripts/deploy.sh`
- `scripts/backup-wallet-db.sh`
- `scripts/preflight-check.ts`
- `scripts/test-epoch.ts`
- `scripts/close-all-positions.ts`
- `scripts/force-close-position.ts`
- `scripts/apply-emergency-close.ts`
- `scripts/generate-clients.mjs`

**Infra/config:**
- `deploy/nginx/bot.crank.money.conf`
- `bot/ecosystem.config.cjs`
- `package.json`
- `Anchor.toml`
- `curator.json`

---

## Appendix B: Tools & Methods Used

- Static review of all listed source files via Grep / Read.
- Cross-reference of v1 audit findings against current code (`auditv1.md` table walk).
- Three parallel adversarial sub-audits:
  1. bin-farm Anchor program (vault instructions + `deduct_gas`)
  2. Off-chain bot + Discord bot + relay
  3. Epoch pipeline + Protocol-LP + scripts + crypto
- Verification of two highest-impact findings (v2-C-01 wallet hijack, v2-H-02 unchecked WSOL ATA) by direct source inspection in main thread.
- Manual hash-layout cross-check between `bot/epoch-computer.ts` and `programs/merkle-distributor/src/lib.rs:118–122`.
- Discriminator spot-check in `packages/core-sdk/generated/bin-farm/instructions/*`.
- Git commit / branch verification via `git rev-parse HEAD`.
- **Not performed:** on-chain RPC verification of live program state (deployed program byte-code vs. repo, current `Config` fields, `pending_emergency_close` cleared, distributor vault drained, epoch state). **Operator should perform these checks** to close out the audit per Section 5 verification requirements.

---

*End of audit-v2.md. Companion document: `auditv1.md`.*
