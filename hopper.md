# Hopper — routing program design

## Goal

A Solana program that holds protocol revenue (SOL + tribe tokens) and routes it on-chain by rule. Replaces the off-chain "Hopper as a wallet" idea — routing rules become public, verifiable, and admin-changeable without redeploys.

Inputs:
- `bin-farm.harvest_bins.fee_taken` (SOL or token, after `set_fee_dest(hopper_vault_pda)`)
- Treasury strategy PnL (manual deposits to HopperVault)
- Crankbot per-tribe fees (TBD — `Config.bot` routing decision deferred)

Bypass:
- Pumpswap LP fees → direct to Personal wallet (never touches Hopper)

Outputs:
- SOL → 40/40/20 split to W-Buy / Treasury / Personal
- Each tribe token → its registered W-{TOKEN} wallet (operator-managed DLMM ladder)

## Architecture

### PDAs

```
RoutingConfig             [b"routing_config"]                  bump
  admin: Pubkey
  pending_admin: Pubkey
  w_buy: Pubkey                                                ← SOL recipient (40%)
  treasury: Pubkey                                             ← SOL recipient (40%)
  personal: Pubkey                                             ← SOL recipient (20%)
  sol_split_bps: [u16; 3]                                      ← [4000, 4000, 2000]
  sol_threshold_lamports: u64                                  ← skip sweep below this
  cranker_tip_bps: u16                                         ← tip for permissionless cranker
  paused: bool
  bump: u8

TokenRoute                [b"token_route", mint]               bump
  mint: Pubkey
  destination: Pubkey                                          ← W-{TOKEN} wallet
  threshold: u64                                               ← min token amount to sweep
  enabled: bool
  bump: u8

HopperVault               [b"hopper_vault"]                   bump
  (program-owned PDA; holds SOL via direct lamport debit/credit;
   owns token ATAs via PDA-derived ATAs. Same pattern as bin-farm's
   BurnSolVault — keeps the codebase consistent and avoids the
   System-Program-CPI dance for every sweep.)
```

### Instructions

**Admin:**
- `initialize(w_buy, treasury, personal, sol_split_bps[3], sol_threshold, cranker_tip_bps)` — one-shot
- `update_routing(field: enum { WBuy, Treasury, Personal, SolSplit, SolThreshold, CrankerTip }, value)` — single setter, simpler than separate ix per field
- `register_token_route(mint, destination, threshold)` — admin-only; init's the TokenRoute PDA + the HopperVault ATA for that mint
- `update_token_route(mint, destination?, threshold?, enabled?)` — admin
- `transfer_admin(new_admin)` — sets pending_admin
- `accept_admin()` — pending_admin signs to take over
- `pause(bool)` — kill switch on permissionless sweeps

**Permissionless:**
- `sweep_sol()` — reads HopperVault SOL balance. If ≥ threshold, splits and transfers via system_program. Tip slice goes to caller. Validates `w_buy / treasury / personal` accounts in `Accounts` against on-chain `RoutingConfig` fields.
- `sweep_token(mint)` — reads HopperVault's ATA for `mint`. If ≥ TokenRoute.threshold, transfers full balance to `TokenRoute.destination`'s ATA. Cranker tip in SOL (if any) requires SOL on the Hopper, separate concern.

### Permission model

- v1: single admin key (`FFwq...QPsL` initially).
- v2: admin is a multisig (Squads or similar). `transfer_admin` swap, no code change.

## Sweep mechanics

### sweep_sol

```rust
let balance = hopper_vault.lamports();
let rent_min = Rent::get()?.minimum_balance(0);  // SystemAccount has 0 data
let sweepable = balance.saturating_sub(rent_min);
require!(sweepable >= cfg.sol_threshold_lamports, BelowThreshold);
require!(!cfg.paused, Paused);

// Validate destination accounts match RoutingConfig
require!(ctx.accounts.w_buy.key() == cfg.w_buy, InvalidDestination);
require!(ctx.accounts.treasury.key() == cfg.treasury, InvalidDestination);
require!(ctx.accounts.personal.key() == cfg.personal, InvalidDestination);

let tip = sweepable * cranker_tip_bps / 10_000;
let net = sweepable - tip;
let buy = net * sol_split_bps[0] / 10_000;
let treasury = net * sol_split_bps[1] / 10_000;
let personal = net - buy - treasury;

// Transfer via lamport manipulation (HopperVault is system-owned PDA; bin-farm
// pattern of direct lamport debit/credit applies).
**hopper_vault.try_borrow_mut_lamports()? -= sweepable;
**w_buy.try_borrow_mut_lamports()?      += buy;
**treasury.try_borrow_mut_lamports()?   += treasury;
**personal.try_borrow_mut_lamports()?   += personal;
**cranker.try_borrow_mut_lamports()?    += tip;

emit!(SolSwept { sweepable, buy, treasury, personal, tip, ts: now });
```

**Replay safety (important).** Every sweep handler MUST validate that the destination accounts passed in the tx match the current `RoutingConfig` fields. If admin retargets `w_buy` between when a sweep tx is queued and when it lands, the queued tx will fail the require check and revert. Cranker eats the tx fee; no funds end up at the old destination. This is the only thing standing between admin retargets and a race-condition fund-misroute — do not skip these checks.

### sweep_token

```rust
let route = ctx.accounts.token_route;  // PDA seeded by mint
require!(route.enabled, Disabled);
require!(!cfg.paused, Paused);
require!(ctx.accounts.destination.key() == route.destination, InvalidDestination);

let amount = ctx.accounts.hopper_ata.amount;
require!(amount >= route.threshold, BelowThreshold);

token::transfer_checked(
  CpiContext::new_with_signer(token_program, TransferChecked {
    from: hopper_ata, to: dest_ata, mint, authority: hopper_vault,
  }, &[hopper_vault_seeds]),
  amount, decimals,
)?;

emit!(TokenSwept { mint, amount, destination, ts: now });
```

`init_if_needed` on `dest_ata` so admins don't have to pre-create destination ATAs. (Cranker pays rent ~0.002 SOL per first-time mint sweep — acceptable.)

## Build sequence

1. **Scaffold** — `anchor init programs/hopper`, add to `Anchor.toml [programs.mainnet]` + `Cargo.toml [workspace] members`.
2. **Generate program keypair** — `solana-keygen new -o target/deploy/hopper-keypair.json --no-bip39-passphrase`. Capture pubkey for `declare_id!`.
3. **Implement** — instructions + Account contexts. ~500-700 LOC Rust.
4. **Unit tests** — pure-math (split rounding, tip calc, threshold edge cases). ~10-15 cases.
5. **Integration tests on devnet** — full lifecycle: init → register → fund → sweep → verify destination balances. LiteSVM or surfpool.
6. **Self-review** — replay safety, signer checks, math overflow, ATA owner checks.
7. **Deploy mainnet** — `~5 SOL` rent for the program account.
8. **`initialize`** — admin tx setting w_buy/treasury/personal/split.
9. **Generate per-wallet keypairs** — W-Buy, Treasury, W-Sell-CRANK. Personal already exists (Pumpswap LP wallet). Store cold; protocol-lp instances get scoped read-only access where possible.
10. **`register_token_route(CRANK_MINT, w_sell_crank_pubkey, threshold)`** — first route.
11. **`bin-farm.set_fee_dest(hopper_vault_pda)`** — single admin tx. Fees redirect immediately.
12. **First sweep** — manual `sweep_sol` to validate end-to-end.

## Bot integration

### bin-farm side
- After step 11 above, every `harvest_bins.fee_taken` lands on `hopper_vault_pda` (SOL) or its mint ATA (token). No bin-farm code change needed — just an admin tx.

### Bot keeper
Add a new step (or separate cron) that calls `sweep_sol` + `sweep_token(mint)` for each registered route. Permissionless, so anyone can crank — but the bot crank guarantees weekly cadence.

```ts
// bot/keeper.ts new step
private async crankHopperSweep(): Promise<void> {
  // Fetch HopperVault SOL balance; if ≥ threshold, send sweep_sol.
  // For each enabled TokenRoute: fetch HopperVault ATA; if ≥ threshold, send sweep_token.
  // Cranker tip credits the bot keypair (small subsidy for keeper ops).
}
```

Cadence: weekly (per pivot.md). Add to `runDailySequence` with a day-of-week gate, or split into a separate weekly cron.

### Dashboard pane

Read these via single `getMultipleAccountsInfo` batch:
- `RoutingConfig` PDA (admin, splits, threshold, paused)
- `HopperVault` PDA (SOL balance)
- For each enabled `TokenRoute` PDA: route + the corresponding HopperVault ATA balance
- 5 destination wallet balances (W-Buy / Treasury / Personal / W-Sell-CRANK / W-{TRIBE…})

Renders as: "X SOL pending sweep, Y CRANK pending → W-Sell, Z ZEREBRO pending → W-ZEREBRO, …"

## Wallet topology (concrete)

| Role | Generated when | Notes |
|------|----------------|-------|
| Admin | exists (FFwq…QPsL) | Hopper admin authority. Eventually multisig. |
| Bot signer | exists | bin-farm Config.bot. Unchanged. |
| HopperVault | PDA | Derived from `[b"hopper_vault"]`. Holds SOL + token ATAs. |
| W-Buy | new keypair | SOL-only. Single-sided lower DLMM bins on CRANK/SOL. |
| Treasury | new keypair | SOL idle or deployed in strategies. |
| Personal | exists (Pumpswap LP wallet) | 20% sweep + Pumpswap LP fees direct. |
| W-Sell-CRANK | new keypair | CRANK-only. Single-sided upper DLMM bins. |
| W-{TRIBE} per token | new keypair | Per-tribe sell-back wallet. Created when tribe is enabled. |

Each non-Hopper wallet is a separate keypair, distinct from bot signer (envelope discipline per `pivot.md`).

## Open / deferred

- **Anti-grief on permissionless sweeps.** Threshold guard prevents no-op sweeps. If attacker spams `sweep_sol` they pay tx fees and lose to threshold revert. Acceptable for v1.
- **Cranker tip** — small slice (e.g. 10 bps) keeps permissionless cranking economically rational. Optional; can ship with `cranker_tip_bps = 0` and add later.
- **Multisig migration.** Defer until v1 is operational.
- **Time-locks on routing changes.** Defer. Admin is trusted in v1; if compromised, attacker controls admin key anyway.
- **Per-token split.** v1 is "one mint → one destination." Multi-destination per token is a later feature.
- **Crankbot per-tribe fee routing.** Today fees flow to `Config.bot`. Decision deferred — observe activity for 30-60 days post-Hopper, decide whether to redirect into Hopper or keep separate.
- **Cross-chain hopper.** Treasury strategies may produce non-SOL revenue (Hyperliquid USDC, etc.). Off-chain bridge step before Hopper deposit. v1 is Solana-only.

## Cost + time

- **SOL:** ~5 for Hopper program rent + ~0.01 for init/register txs.
- **Time:** ~2 weeks of focused work to ship v1 (program + tests + audit + bot integration + dashboard).
- **Per new tribe:** ~hours (generate keypair, deploy protocol-lp instance, `register_token_route` tx).

## Sequencing vs. existing work

```
Now            Branch bin-farm-cleanup committed locally
                bin-farm cleanup live on mainnet
                5 retired programs closed, 10 SOL recovered
                Bot online with Config.fee_dest = default → fees route to bot keypair

Week 1-2       Hopper program implementation + audit + devnet test
Week 2 end     Hopper deploy mainnet + initialize + register CRANK route
Week 3 start   set_fee_dest(hopper_vault_pda) — fees redirect
                W-Buy + W-Sell-CRANK keypairs generated, first protocol-lp instances
Week 3-4       Weekly sweep cron, dashboard pane
Ongoing        Per-tribe expansion (zerebro, fartcoin, …) as desired
```
