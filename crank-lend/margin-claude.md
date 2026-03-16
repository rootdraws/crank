# crank-lend

Fork of marginfi-v2, rebranded as a custom Solana lending protocol for the CRANK token. Enables shorting CRANK (against USDC collateral) and leveraged staking loops with crankSOL (an SPL stake pool LST). Includes a protocol-owned liquidator vault that converts seized collateral into buy-side DLMM liquidity.

## Programs

| Program | Cargo Package | Program ID |
|---------|--------------|------------|
| crank-lend | `crank-lend` | `GAWPC7CS46St5BxsuicijpzSG4GRWf6csaPvKRdZb314` |
| liquidator-vault | `liquidator_vault` | `ANSWdD2DCkAgfBATyVsGc25oiAapqBKBZUSUHcpNj2ZS` |

## Build Notes

- The Rust package name is `crank-lend`, not `marginfi`. Internal references use `crank_lend::`.
- Must use `--no-default-features` for crank-lend:
  ```
  PATH="$HOME/.cargo/bin:$PATH" anchor build -p crank_lend -- --no-default-features
  ```
- The `PATH` prefix is required because Homebrew's cargo shadows rustup's cargo on this machine.
- liquidator-vault builds without the flag:
  ```
  PATH="$HOME/.cargo/bin:$PATH" anchor build -p liquidator_vault
  ```
- A pre-existing BPF stack warning (`Once::call Stack offset of 10496 exceeded max offset of 4096`) comes from a dependency's thread-once init, not from our code. It is safe to ignore.

## Test Notes

- When running tests for any purpose (checking if tests pass, debugging failures, etc.), use the @agent-test-runner-analyzer agent
- The test-runner-analyzer agent will handle running the full test suite and extracting relevant results for specific tests
- **No tests exist yet for new code** (hybrid oracle, keeper oracle, liquidator vault, dry powder instructions). The existing test suite covers original marginfi functionality only.

## TypeScript Error Checking

- To check TypeScript errors, use the MCP IDE diagnostics tool:
  - For a specific file: `mcp__ide__getDiagnostics` with `uri` parameter
  - For all open files: `mcp__ide__getDiagnostics` without parameters
- Do NOT use `npx tsc --noEmit` as it's not configured correctly for this project

## Architecture

### Oracle: HybridDlmmKeeper

Single oracle variant for CRANK pricing. TVL-weighted average of two sources:

1. **DLMM TWAP** (trustless) — reads Meteora DLMM on-chain oracle samples over a 300s window, converts to USD via crankSOL exchange rate (Sanctum stake pool) x Pyth SOL/USD
2. **Keeper price** (Pumpswap) — off-chain bot posts CRANK/USD price + Pumpswap TVL to a `KeeperOracleState` account

If the keeper is stale, falls back to DLMM price alone with 5% synthetic confidence. No circuit breaker.

**oracle_keys in BankConfig** (4 of MAX_ORACLE_KEYS=5 used):
- `[0]` LbPair (DLMM)
- `[1]` StakePool (Sanctum, `SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY`)
- `[2]` PythSolUsd
- `[3]` KeeperOracle (owned by crank-lend program)

**Remaining accounts per bank**: 7 oracle AIs + 1 bank = 8 total (handled by `get_remaining_accounts_per_bank` in `marginfi_account.rs`).

### Liquidator Vault

Separate program holding CRANK reserves for protocol-owned liquidation. Instructions:
- `execute_liquidation` — CPI into crank-lend's `lending_account_liquidate`, vault PDA signs as authority
- `swap_usdc_to_sol` — CPI into Jupiter
- `mint_cranksol` — CPI into Sanctum SPL Stake Pool DepositSol
- `place_dlmm_bids` — CPI into bin-farm's `open_position_v2`

Emits Anchor events (`LiquidationExecuted`, `DryPowderSwap`, `DryPowderMint`, `DryPowderBid`) for dashboard monitoring.

### Backup Liquidation

Uses the receivership mechanism (`start_liquidation` / `end_liquidation`) — a capital-less, permissionless two-phase liquidation within a single transaction. Not flash loans.

## Key Files

| File | Purpose |
|------|---------|
| `programs/marginfi/src/state/price.rs` | All oracle logic: DLMM TWAP helpers, hybrid oracle, PriceAdapter trait |
| `programs/marginfi/src/state/keeper_oracle.rs` | `KeeperOracleState` struct (price, confidence, pumpswap_tvl_usd) |
| `programs/marginfi/src/state/marginfi_account.rs` | `get_remaining_accounts_per_bank` — returns 8 for HybridDlmmKeeper |
| `programs/marginfi/src/instructions/marginfi_group/update_keeper_oracle.rs` | Keeper oracle update instruction (takes price, confidence, pumpswap_tvl_usd) |
| `programs/marginfi/src/instructions/marginfi_account/liquidate.rs` | Legacy `lending_account_liquidate` (10 named accounts) |
| `programs/marginfi/src/instructions/marginfi_account/liquidate_start.rs` | Receivership `start_liquidation` |
| `programs/marginfi/src/instructions/marginfi_account/liquidate_end.rs` | Receivership `end_liquidation` |
| `programs/liquidator-vault/src/instructions/execute_liquidation.rs` | Vault CPI into crank-lend liquidation |
| `programs/liquidator-vault/src/instructions/dry_powder.rs` | USDC->SOL->crankSOL->DLMM pipeline |
| `programs/liquidator-vault/src/state/vault.rs` | `VaultState` with inventory tracking fields |
| `type-crate/src/types/bank.rs` | `OracleSetup` enum (HybridDlmmKeeper=15, slots 13/14 reserved) |
| `programs/marginfi/src/constants.rs` | `SANCTUM_STAKE_POOL_PROGRAM_ID`, `METEORA_DLMM_PROGRAM_ID`, `DLMM_TWAP_MIN_WINDOW_SECS` |
| `liquidation_bot.md` | Full bot spec for the crank-money repo (program interfaces, account layouts, gRPC, PM2) |

## Token Addresses

| Token | Mint |
|-------|------|
| CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` |
| crankSOL (PEGGED) | `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1` |
| Sanctum Stake Pool | `9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg` |
| Pumpswap CRANK/SOL pool | `GpQ5UTPHSD5SQsqpxbYxXd75JAmex3tu4Dq292FZ4Pqh` |

## What's Not Done

- **Tests**: No tests for hybrid oracle, keeper oracle, liquidator vault, or dry powder instructions.
- **DLMM pool**: The CRANK/crankSOL Meteora DLMM pool does not exist yet. Must be created via `createPermissionlessLbPair` before the oracle can function.
- **Bots**: All off-chain bots (keeper oracle updater, poke/arb bot, liquidation monitor, backup liquidator, market making agent) will be built in the `crank-money` repo. The spec is in `liquidation_bot.md`.
- **Stale scaffold**: `bots/liquidation-keeper/` contains an early placeholder scaffold. Ignore it — the real implementation goes in `crank-money`.
- **Deployment prerequisites**: KeeperOracle account must be initialized, banks configured with HybridDlmmKeeper oracle_keys, vault's marginfi account created and linked to VaultState.
- **Audit**: None. New oracle math and CPI forwarding are compiler-verified only.
