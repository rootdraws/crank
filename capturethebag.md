# Capture the Bag — Implementation Doc

Living document for the rewards-system amendment. Design spec is frozen; this
file tracks implementation state + integration notes.

## Design (frozen)

**What's changing:** fee 0.3 → 0.5%, 40/40/20 split → supply-driven burn curve.

**One curve, one formula, one switch.** Let `remaining = crank_mint.supply / INITIAL_SUPPLY`.

```
burn_ratio      = min(1.0, remaining / 0.75)        // holds at 1.0 while remaining ≥ 75%
protocol_skim   = 0.20 × (1 − burn_ratio)           // 0 → 0.20 as supply depletes
trader_sol_frac = 1 − burn_ratio − protocol_skim    // trader SOL share
```

**Per incoming SOL fee:**
- `burn_sol = total × burn_ratio` → rover places DLMM resting bids → fills → burn CRANK → mint BANK → traders (pro-rata by harvest volume, via Merkle).
- `trader_sol = total × trader_sol_frac` → trader SOL Merkle tree (pro-rata by harvest volume).
- `protocol_sol = total × protocol_skim` → `Config.bot` wallet.

**CRANK fees** (token-side of a CRANK trade): always straight to burn → BANK. The existing `crankOpenFeeRovers` keeper step sells non-CRANK fee tokens for SOL; CRANK bypasses that path.

**Kill switch** (`burn_enabled` bool on `RoverAuthority`): when off, `burn_ratio` clamps to 0. All SOL flows 80% trader / 20% protocol. Supply curve keeps advancing regardless.

**Voting** stays, rewards nothing. Gauges direct trader distribution among themselves — selfish fights, no extra issuance.

## Phases in plain English

- **100% → 75% supply — magnesium.** 100% burn. Every fee SOL is a bid; every bid fill burns CRANK; every burn mints BANK for traders. Zero protocol cut. Root's LP revenue is peak because rover is constantly bidding.
- **75% → 0% supply — dimming.** Burn fades linearly to 0; SOL yield emerges; protocol skim grows 0 → 20%.
- **0% CRANK — embers.** 100% SOL yield, 80 traders / 20 protocol. Indefinite sustainability.

## Sizing defaults (CRANK/SOL pool — binStep 80)

| Parameter | Default | Source |
|---|---|---|
| Bins per bid deployment | 70 | DLMM hard cap; `open_fee_rover` formula |
| Min SOL to deploy a bid | 2 SOL | `tools/protocol-lp/config.ts:87` prior art |
| Burn vault rent reserve | rent-exempt min | Same pattern as `sweep_rover`'s rover_authority rent skim |
| Strategy | BidAskImBalanced | Concentrates liquidity at range edges; bigger fills on bigger dips |
| Price range at binStep 80 | ~74% below active | `(1.008)^70 − 1 ≈ 0.7414` |

Both configurable via env: `ROVER_BID_BIN_COUNT`, `ROVER_BID_MIN_LAMPORTS`.

## Implementation status

- [x] **#1** RoverAuthority extended (`initial_crank_supply`, `burn_enabled`) — carved from `_reserved`, no realloc.
- [x] **#2** `set_fee_bps` direct setter replaces `propose_fee`/`apply_fee` timelock.
- [x] **#3** `initialize_burn_curve` (one-shot, snapshots `crank_mint.supply`, creates `burn_sol_vault` PDA) + `set_burn_enabled`.
- [x] **#4** `compute_curve()` ppb helper + `sweep_rover` rewritten (three destinations: `burn_sol_vault`, `trader_dest`, `Config.bot`).
- [x] **#5** `wrap_burn_sol` + `open_rover_bid_position` (buy-side BidAsk, Y-only WSOL).
- [x] **#6** `rover_burn_and_mint` (CPI bank-mint, forwards minted BANK to bot's BANK ATA for next epoch funding).
- [x] **#7** `bank-distributor` — fork of merkle-distributor at new program ID `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M`.
- [x] **#8** `core-sdk`: `DEFAULT_FEE_BPS = 50`, new constants (ppb, rover bid sizing), new PDAs (`getBurnSolVaultPDA`, `getBankDistributorPDA`), `burn-curve.ts` TS mirror.
- [x] **#9** `keeper.ts` — 8-step sequence (`crankOpenRoverBids` + `crankRoverBurnAndMint` inserted between sweep and epoch), CRANK fee bypass in `crankOpenFeeRovers`.
- [x] **#10** `epoch-computer.ts` — `runBankEpoch` added alongside `runEpoch`, same `computeShares` weighting, separate `epoch-state-bank.json` state file.
- [x] **#11** `/burn status` subcommand — reads CRANK/BANK supply, RoverAuthority curve state, renders curve + kill switch status.
- [x] **#12** `scripts/init-burn-curve.ts` — one-shot bootstrap (dry-run by default, `--execute` to send).
- [x] **#13** `bot/burn-curve.test.ts` — 16 vitest cases covering reference values, invariants, kill switch, edge cases.

All 6 Rust programs compile clean. All 43 vitest cases pass (including 16 new curve tests).

Deferred (not blocking ship):
- Anchor integration tests for on-chain `sweep_rover` / `rover_burn_and_mint` / `open_rover_bid_position` — smoke on devnet per the runbook covers these in practice.
- Regenerating Codama TS clients (`node scripts/generate-clients.mjs`) — run after `anchor build` produces fresh IDLs.

## Key addresses (resolved)

| Item | Value |
|---|---|
| bank-distributor program ID | `9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M` |
| `burn_sol_vault` PDA | `C3kNgWtLurmvfvf27wdsz4V9zrQL956KY5DTjF6JMnD6` |
| bank-distributor PDA | `9pQBWUhCeFeJpYgPsP6NsxvSXyLbmX8F3tekrVi3Wtrf` |
| bank-distributor vault | BANK ATA owned by bank-distributor PDA (created during init) |
| rover BANK ATA | BANK ATA owned by `rover_authority` PDA (created during init) |
| Deploy / curve init authority | `FFwqCuYTw7DFWWRQD3tYcPBPpmaAQjT1JV5kqG15QPsL` |

## CRANK supply at curve activation

- **Snapshot taken (2026-04-13):** `1,935,388,154` CRANK (raw `1,935,388,154,207,285` with 6 decimals). Verified on-chain.
- Originally 2B cap; ~3.2% already burned via user-side `vault_burn_and_mint` before the curve activated.
- `initial_crank_supply` is now **immutable** on-chain in RoverAuthority.
- Burn-ratio breakpoint (75% of initial) lands at: `~1,451,541,116` CRANK supply.

## Mainnet activation (2026-04-13)

| Step | Tx |
|---|---|
| `bank_distributor` first deploy | `2Gskt1yfunKkbQXWmCiUEpwErVTQmE3EdiPYJJNw358P8poTz56DthNqSajjHmDMhVUu8gKyq18PkpeXLHkyQ5TV` |
| `bin_farm` upgrade | `JFd3WABoobeTTtD15LPh4AZXyQi7CpjJwXsojARNoLXskDtM2YsC64m7VnSHMsKMzuN3wKubjUpd4kd3xQ9qfen` |
| `initialize_burn_curve` | `2DaHATspGLDdUyfLvxqhFpXwLnk2zXhiNemFCRd2Ei5yQNFnZkrxogTY3hjL5yFtDrLbRA8dPLZyQnxVQJNozbaU` |
| `set_fee_bps(50)` | `5UEJ1WFt39r14D2FEMbKnYcMZ3Gt3D3MKRknvDr1qEfBs3eordNcFCBe74fygZRREow13c5mDf5GigPi6XnPgggR` |
| `bank_distributor.initialize` | `4m7krnRtESHRSr8dQ3B3dR12ch3sy269vYroNrpME2WdFLHPWfNnfFskq619hUhwY7kip2UqJFzbDBd2H436JSCG` |
| Rover + bot BANK ATAs created | `3DKEYetYLa7VH35sdeaSEhgaH8vJvMGfaYr83JH4FDZeZCUj2M85pLfi2TRNV19W5o7MNFrsDx4daWyWCuf6KHLK` |
| Bank distributor vault ATA | `DLLD7r62rp9AEbH2CiTtkKuJCrSmiehseMByNPvoySo6` |
| Rover BANK ATA | `Fqq5Cp1LoNFdntcz6crjB2pCfK6Axtrt9YyuWjzjfKtg` |
| Bot BANK ATA (funder) | `BHbT2YPnRXzPKvGYu1XSNqGo4fJmzUjEj8BHx7gbktns` |

**First BANK epoch fired same hour:** `epoch=1`, 64.4M BANK distributed to 1 user (Root, sole harvester), tree pinned at IPFS `QmUThu8fbAPJGrzLJjbkBY58S5SBs8wgQmRiMXxL1iVyFZ`, auto-claim 1/1 succeeded.

## Amendment: Non-Custodial Fix (2026-04-13 later same day)

First-cycle activation surfaced a tax/accounting flaw: the daily distribution
pipelines made value briefly land in the bot/admin keypair's wallet before
reaching the trader distributor vaults. Even as an in-and-out hop in the same
tx, it would read as "operator received revenue, then distributed it."

Fixed by removing the funder-ATA transfer from both `new_epoch` instructions
and computing `epoch_amount` on-chain from the vault balance delta:

```
epoch_amount = vault.amount + total_amount_claimed - total_amount_funded
```

Vaults are pre-funded by program flows — `rover_burn_and_mint` forwards BANK
directly to the bank-distributor vault, and `drain_vault` targets the
merkle-distributor's WSOL vault directly (SPL `sync_native` promotes the
lamports into the WSOL balance). Operator keypair signs `new_epoch` only to
publish the merkle root — never holds reward-bound tokens.

| Step | Tx |
|---|---|
| `bank_distributor` upgrade (non-custodial new_epoch) | `2jbS4Kwf1oyVemGp58R3zkBBTaPbT3dsZZh1iJ3qsQBYDMsGgYuDTHtYMAGoSGB42ADCkAsbZeZDjMhu2rbf7k41` |
| `merkle_distributor` upgrade (same diff) | `5L5sMNZFKfWanyAagH3Kw8XGKUXPb5nwPJQHi4CJuGD3Vu8W1yfyNr6cHhnhzz2dtZHCh59dtSvgdC166bVjvSAH` |

**First post-fix cycle verified the behavior:**
```
[bank-epoch] delta 0 (vault=0 funded=64400000000000 claimed=64400000000000) < 1000 — skipping
[keeper] Skipping fee rover — CRANK burns via rover_burn_and_mint
```

vault=0 (drained by prior claim), funded=64.4M, claimed=64.4M → delta=0 → skip.
No BANK flowed through any keypair. Next rover burns will pre-fund the vault
directly, producing a positive delta on the next daily cycle.

The 64.4M BANK is still in Root's trading vault PDA from the pre-fix cycle —
no action needed.

## Fee flow (end state)

```
harvest/close → 50 bps fee → rover_authority ATAs
  SOL fee (WSOL) → close_rover_wsol (unwrap) → sweep_rover
  CRANK fee → rover_burn_and_mint → bank-distributor vault (NEW, bypasses open_fee_rover)
  Other token fee → open_fee_rover → BidAsk sell → SOL (unchanged for non-CRANK)

sweep_rover curve split (new):
  burn portion  → burn_sol_vault PDA
  trader SOL    → bridge_vault (via rover_authority.trader_dest, unchanged)
  protocol skim → Config.bot (unchanged)

wrap_burn_sol + open_rover_bid_position (NEW, daily):
  burn_sol_vault → rover WSOL ATA (sync_native) → DLMM buy-side position
  ~70 bins below active on CRANK/SOL. Bids fill over the day as price dips.

harvest fills on rover bids → CRANK accumulates in rover CRANK ATA → next cycle:
  rover_burn_and_mint → BANK minted into bank-distributor vault

Daily epoch-computer (new):
  1) Compute trader weights from harvests table (unchanged function)
  2) SOL tree: drain bridge_vault → WSOL → SOL distributor new_epoch + claims (unchanged)
  3) BANK tree: bank-distributor vault balance → new_epoch + claims (NEW, parallel path)
```

## Events (for indexing / /burn status)

- `SweepCurveEvent { total_sweepable, burn_sol, trader_sol, protocol_sol, burn_ratio_ppb, protocol_skim_ppb, crank_supply, initial_crank_supply, burn_enabled, timestamp }` — emitted on every `sweep_rover`.
- `BurnCurveInitializedEvent` — one-shot on `initialize_burn_curve`.
- `BurnEnabledEvent` — on kill-switch toggle.
- `BurnAndMintEvent` (bank-mint) — unchanged; fires under the hood when `rover_burn_and_mint` runs.

## Runbook (same as plan file)

Day 1: build + vitest + anchor tests. Day 2: devnet deploy + smoke. Day 3: mainnet upgrade + one-time init + bot redeploy.

One-time init tx batch (script: `scripts/init-burn-curve.ts`):
1. `initialize_burn_curve` — snapshots `crank_mint.supply`, enables burn, creates `burn_sol_vault`.
2. `set_fee_bps(50)` — atomic fee bump.
3. `bank_distributor.initialize` — creates Distributor PDA + vault ATA for BANK.
4. Create rover BANK ATA (so `rover_burn_and_mint` has a destination to mint into).

Mainnet smoke checks: `pm2 logs` shows `SweepCurveEvent` with `burn_ratio_ppb = 1_000_000_000`, `/burn status` returns sensible numbers, first daily cycle shows CRANK supply ↓ + BANK supply ↑ by equal deltas.

## File map

| Path | Role |
|---|---|
| `programs/bin-farm/src/lib.rs` | curve math, sweep_rover, wrap_burn_sol, open_rover_bid_position, rover_burn_and_mint, initialize_burn_curve, set_fee_bps, set_burn_enabled |
| `programs/bank-distributor/src/lib.rs` | BANK Merkle distributor (fork of merkle-distributor) |
| `packages/core-sdk/constants.ts` | fee bps, program IDs, curve ppb constants, rover bid sizing |
| `packages/core-sdk/pda.ts` | PDA derivers including burn_sol_vault + bank-distributor |
| `packages/core-sdk/burn-curve.ts` | TS mirror of `compute_curve` |
| `bot/keeper.ts` | daily sequence with new steps (TODO #9) |
| `bot/epoch-computer.ts` | dual tree output (TODO #10) |
| `packages/discord-bot/src/commands/burn.ts` | /burn status (TODO #11) |
| `scripts/init-burn-curve.ts` | one-time init batch (TODO #12) |

## Notes for future-me

- `wrap_burn_sol` must be followed by SPL `sync_native` in a separate ix in the same tx — same constraint as existing `wrap_sol_in_vault`. The keeper composes both in one tx before calling `open_rover_bid_position`.
- `open_rover_bid_position` currently uses 1M CU by analogy to `open_fee_rover`. Confirm during devnet smoke.
- Bin-farm's `RoverAuthority.revenue_dest` + `pending_revenue_dest` + `revenue_dest_change_at` are LEGACY fields — the curve doesn't reference them. Keep for account-layout compat; don't break them.
- BANK `transfer_checked` uses hardcoded `BANK_MINT_DECIMALS = 6`. If BANK ever migrates mint (shouldn't), update both the const and anywhere decimals are read from the mint account.
- `propose_fee` / `apply_fee` / `cancel_pending_fee` were removed. `NoPendingFeeChange` / `FeeTimelockNotExpired` errors stay (used by `apply_revenue_dest` which still has its own timelock).
