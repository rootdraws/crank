# Liquidation Bot Spec — crank-money Integration

This document contains all reference data needed by the `crank-money` repo to build:
1. **Keeper Oracle Bot** — posts Pumpswap CRANK/SOL price + TVL to the on-chain KeeperOracleState
2. **Poke / Arb Bot** — keeps DLMM TWAP fresh via dust swaps, optionally arbs DLMM↔Pumpswap
3. **Primary Liquidation Bot** — monitors health, executes liquidations via the `liquidator-vault` program
4. **Backup Liquidation Bot** — receivership-based, capital-less liquidation as a fallback
5. **Dry Powder / Market Making Agent** — converts USDC → SOL → crankSOL → DLMM bids

---

## 1. Program IDs & Key Addresses

| Item                        | Address                                              |
|-----------------------------|------------------------------------------------------|
| **crank-lend program**      | `7YZdRiBRbxFhSwRHJ7g2h5dLFcYEnU7hWnkJqqYEswcP`     |
| **liquidator-vault program**| `ANSWdD2DCkAgfBATyVsGc25oiAapqBKBZUSUHcpNj2ZS`     |
| **bin-farm program**        | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia`     |
| **Meteora DLMM program**   | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`       |
| **Sanctum Stake Pool prog** | `SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY`       |
| **Jupiter aggregator**      | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`       |
| **Pumpswap program**        | `PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP`       |
| **CRANK mint**              | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump`     |
| **crankSOL (PEGGED) mint**  | `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1`     |
| **Sanctum Stake Pool acct** | `9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg`       |
| **Pumpswap CRANK/SOL pool** | `GpQ5UTPHSD5SQsqpxbYxXd75JAmex3tu4Dq292FZ4Pqh`       |
| **Pumpswap pool base token**| `D5CbT8sjwseWJYKbs3fT5xnA46UHA9DLpvsjSyqhmwwg` (CRANK)|
| **Pumpswap pool quote token**| `93BYP4biPkgZKN7J7zLUwPMWYZJ4zW2kCcwCjry9gEzz` (SOL)|

---

## 2. Keeper Oracle

### On-Chain State: `KeeperOracleState`

```rust
#[account(zero_copy)]
#[repr(C)]
pub struct KeeperOracleState {
    pub authority: Pubkey,           // 32 bytes
    pub price: WrappedI80F48,        // 16 bytes — Pumpswap CRANK/USD price
    pub confidence: WrappedI80F48,   // 16 bytes — absolute confidence in USD
    pub last_updated_at: i64,        // 8 bytes
    pub pumpswap_tvl_usd: WrappedI80F48, // 16 bytes — Pumpswap pool TVL in USD
    pub _reserved: [u8; 48],         // 48 bytes
}
```

Total size: 8 (discriminator) + 136 = 144 bytes.

### Instruction: `update_keeper_oracle`

**Discriminator:** `hash("global:update_keeper_oracle")[..8]`

**Args (Borsh):**
- `price: WrappedI80F48` (16 bytes)
- `confidence: WrappedI80F48` (16 bytes)
- `pumpswap_tvl_usd: WrappedI80F48` (16 bytes)

**Accounts:**
| # | Name           | Writable | Signer |
|---|----------------|----------|--------|
| 0 | keeper_oracle  | W        |        |
| 1 | authority      |          | S      |

### What the bot posts

1. **price** — Pumpswap CRANK/USD: `(reserve_sol / reserve_crank) * pyth_sol_usd`
2. **confidence** — synthetic 2% of price: `price * 0.02`
3. **pumpswap_tvl_usd** — `reserve_sol * pyth_sol_usd * 2` (standard AMM assumption)

### Pumpswap Pool Data Layout

Pool account `GpQ5UTPHSD5SQsqpxbYxXd75JAmex3tu4Dq292FZ4Pqh`:
- `base_mint` (CRANK): `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump`
- `quote_mint` (SOL): `So11111111111111111111111111111111111111112`
- `pool_base_token_account`: `D5CbT8sjwseWJYKbs3fT5xnA46UHA9DLpvsjSyqhmwwg`
- `pool_quote_token_account`: `93BYP4biPkgZKN7J7zLUwPMWYZJ4zW2kCcwCjry9gEzz`

**To compute Pumpswap price:** Subscribe via gRPC to both `pool_base_token_account` and
`pool_quote_token_account`. Read `amount` (u64) at byte offset 64 from each SPL token account.

```
pumpswap_crank_per_sol = reserve_crank / reserve_sol
pumpswap_crank_usd = (reserve_sol / reserve_crank) * pyth_sol_usd
pumpswap_tvl_usd = reserve_sol * pyth_sol_usd * 2
```

### gRPC Subscription

Extend `buildSubscriptionRequest()` in `geyser-subscriber.ts` to add:

```typescript
pumpswap_reserves: {
  account: [
    "D5CbT8sjwseWJYKbs3fT5xnA46UHA9DLpvsjSyqhmwwg",  // CRANK reserve
    "93BYP4biPkgZKN7J7zLUwPMWYZJ4zW2kCcwCjry9gEzz",  // SOL reserve
  ],
  filters: [],
}
```

Route in the data handler by pubkey → `handlePumpswapReserveUpdate(pubkey, data)`.

---

## 3. Poke / Arb Bot

### DLMM TWAP Heartbeat

The oracle requires at least one trade within every 300s window
(`DLMM_TWAP_MIN_WINDOW_SECS = 300`). Run a dust swap every ~250 seconds.

### Meteora DLMM `swap2` Instruction

**Program:** `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`

**Discriminator:** `[65, 75, 63, 76, 235, 91, 91, 136]`

**Accounts (16):**

| # | Name                      | W | S | Notes                                    |
|---|---------------------------|---|---|------------------------------------------|
| 0 | lb_pair                   | W |   |                                          |
| 1 | bin_array_bitmap_extension|   |   | Optional (pass DLMM program ID if none)  |
| 2 | reserve_x                 | W |   | from LbPair @ offset 152                 |
| 3 | reserve_y                 | W |   | from LbPair @ offset 184                 |
| 4 | user_token_in             | W |   | your ATA for token you're selling        |
| 5 | user_token_out            | W |   | your ATA for token you're receiving      |
| 6 | token_x_mint              |   |   | from LbPair @ offset 88                  |
| 7 | token_y_mint              |   |   | from LbPair @ offset 120                 |
| 8 | oracle                    | W |   | PDA: seeds [b"oracle", lb_pair]          |
| 9 | host_fee_in               | W |   | Optional (pass DLMM program ID if none)  |
| 10| user                      |   | S | bot wallet                               |
| 11| token_x_program           |   |   |                                          |
| 12| token_y_program           |   |   |                                          |
| 13| memo_program              |   |   | MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr |
| 14| event_authority           |   |   | PDA: seeds [b"__event_authority"]         |
| 15| program                   |   |   | DLMM program itself                      |

**Remaining accounts:** Bin array(s) traversed by the swap. For a dust swap staying in the
current bin, pass just one:
```
PDA seeds = [b"bin_array", lb_pair.to_bytes(), (active_id / 70).to_le_bytes()]
```

**Args (Borsh after discriminator):**
- `amount_in: u64` — dust amount (e.g. 1 lamport)
- `min_amount_out: u64` — 0 for dust poke
- `remaining_accounts_info: { slices: [] }` — empty for no transfer hooks

### Arb Execution

When price divergence between DLMM and Pumpswap exceeds a threshold and the bot wallet has
capital, execute a dual-swap: buy on the cheaper venue, sell on the more expensive.
Poke function always runs regardless of arb capital.

---

## 4. Primary Liquidation Bot (via liquidator-vault)

### Health Monitoring

Subscribe via gRPC to all `MarginfiAccount` loaders in the crank-lend group. For each account:

1. Parse balances from `MarginfiAccount.lending_account.balances[]`
2. For each active balance, fetch the bank data and compute weighted asset/liability values
3. If `maint_health < 0`, the account is liquidatable

### `execute_liquidation` Instruction

**Program:** `ANSWdD2DCkAgfBATyVsGc25oiAapqBKBZUSUHcpNj2ZS` (liquidator-vault)

**Discriminator:** `hash("global:execute_liquidation")[..8]`

**Named accounts:**

| # | Name              | W | S |
|---|-------------------|---|---|
| 0 | vault_state       | W |   |
| 1 | admin             |   | S |
| 2 | vault_authority   |   |   |
| 3 | crank_lend_program|   |   |

**Args (Borsh):**
- `asset_amount: u64`
- `liquidatee_remaining_count: u8`
- `liquidator_remaining_count: u8`

**remaining_accounts (9+ items, in crank-lend's expected order WITHOUT authority):**

| Idx | Account                        | W | Notes                      |
|-----|--------------------------------|---|----------------------------|
| 0   | group                          |   |                            |
| 1   | asset_bank                     | W |                            |
| 2   | liab_bank                      | W |                            |
| 3   | liquidator_marginfi_account    | W | vault's crank-lend account |
| 4   | liquidatee_marginfi_account    | W |                            |
| 5   | bank_liquidity_vault_authority |   |                            |
| 6   | bank_liquidity_vault           | W |                            |
| 7   | bank_insurance_vault           | W |                            |
| 8   | token_program                  |   |                            |
| 9+  | oracle + observation accounts  |   | see below                  |

The vault program inserts `vault_authority` (PDA signer) at index 4 in the CPI accounts,
making it the `authority` field in crank-lend's `LendingAccountLiquidate`.

### Computing `liquidatee_remaining_count` and `liquidator_remaining_count`

After index 8 (token_program), the remaining accounts are:
1. **Bank oracle accounts** — for each of asset_bank and liab_bank (used to fetch prices)
2. **Liquidator observation accounts** — for each active balance in the liquidator's marginfi account
3. **Liquidatee observation accounts** — for each active balance in the liquidatee's marginfi account

For each balance, the number of accounts = `get_remaining_accounts_per_bank(bank)`:
- `OracleSetup::Fixed`: 1 (bank only)
- `OracleSetup::HybridDlmmKeeper`: 8 (bank + 7 oracle accounts)
- `ASSET_TAG_STAKED`: 4 (bank, oracle, lst_mint, lst_pool)
- Default (PythPush, SwitchboardPull): 2 (bank, oracle)

**`liquidator_remaining_count`** = sum of `get_remaining_accounts_per_bank` for each active
balance in the liquidator's marginfi account.

**`liquidatee_remaining_count`** = sum of `get_remaining_accounts_per_bank` for each active
balance in the liquidatee's marginfi account.

The remaining_accounts after index 8 should be ordered as:
`[asset_bank_oracles..., liab_bank_oracles..., liquidator_observation_ais..., liquidatee_observation_ais...]`

---

## 5. Backup Liquidation Bot (Receivership)

This is a simpler, capital-less alternative. The bot acts as the `liquidation_receiver` and
directly withdraws collateral / repays debt using the liquidatee's own funds within a single tx.

### Flow (single transaction):

1. `init_liquidation_record` (if not already initialized for the target account)
2. `start_liquidation` — snapshots health, marks account in receivership
3. `lending_account_withdraw` — withdraw collateral (e.g. USDC) from liquidatee to receiver
4. Swap USDC → CRANK (via Jupiter or DLMM within the same tx)
5. `lending_account_repay` — repay CRANK debt
6. `end_liquidation` — validates health improved, deducts flat SOL fee

### Instruction: `init_liquidation_record`

**Discriminator:** `hash("global:marginfi_account_init_liq_record")[..8]`

| # | Account             | W | S | Notes                                              |
|---|---------------------|---|---|----------------------------------------------------|
| 0 | marginfi_account    | W |   |                                                    |
| 1 | fee_payer           | W | S | pays rent for LiquidationRecord PDA               |
| 2 | liquidation_record  | W |   | PDA: `[LIQUIDATION_RECORD_SEED, marginfi_account]` |
| 3 | system_program      |   |   |                                                    |

### Instruction: `start_liquidation`

**Discriminator:** `hash("global:start_liquidation")[..8]`

| # | Account              | W | S | Notes                                          |
|---|----------------------|---|---|-------------------------------------------------|
| 0 | marginfi_account     | W |   | has_one = liquidation_record                   |
| 1 | liquidation_record   | W |   |                                                |
| 2 | liquidation_receiver |   |   | unchecked — whoever signs end_liquidation later |
| 3 | instruction_sysvar   |   |   | `Sysvar1nstructions1111111111111111111111111`  |

**remaining_accounts:** All bank + oracle accounts needed to compute the account's health.
Same pattern as the risk engine — for each active balance, pass bank loader + oracle accounts.

**Transaction constraints:**
- `start_liquidation` must be the first crank-lend instruction in the tx
- `end_liquidation` must be the last crank-lend instruction in the tx
- Only `withdraw`, `repay`, and `init_liquidation_record` are allowed in between
- Cannot be called via CPI

### Instruction: `end_liquidation`

**Discriminator:** `hash("global:end_liquidation")[..8]`

| # | Account              | W | S | Notes                                         |
|---|----------------------|---|---|-----------------------------------------------|
| 0 | marginfi_account     | W |   | has_one = liquidation_record                  |
| 1 | liquidation_record   | W |   | has_one = liquidation_receiver                |
| 2 | liquidation_receiver | W | S | must match what was set in start_liquidation  |
| 3 | fee_state            |   |   | PDA: `[FEE_STATE_SEED]`                       |
| 4 | global_fee_wallet    | W |   | validated via fee_state                       |
| 5 | system_program       |   |   |                                                |

**remaining_accounts:** Same as start_liquidation — all bank + oracle accounts for health computation.

**Validation:**
- Health must not get worse (post_health >= pre_health)
- Seized asset value ≤ (1 + max_fee) × repaid liability value
- Small flat SOL fee transferred from liquidation_receiver to global_fee_wallet

---

## 6. Dry Powder Pipeline

The liquidator-vault program exposes three instructions for the USDC → SOL → crankSOL → DLMM bids
flow. Each uses a generic `DryPowderAction` context with remaining_accounts for the target program.

### `swap_usdc_to_sol`

CPI into Jupiter. The bot builds the full Jupiter route instruction off-chain and passes all
required accounts via remaining_accounts.

**Args:** `amount: u64` (USDC amount)

### `mint_cranksol`

CPI into Sanctum SPL Stake Pool DepositSol (variant index 14).

**Args:** `lamports: u64`

**remaining_accounts:** `[stake_pool, withdraw_authority, reserve_stake, pool_fee_account,
dest_token_account, manager_fee_account, vault_authority (SOL source), pool_mint, token_program]`

### `place_dlmm_bids`

CPI into bin-farm `open_position_v2`.

**Args:** `amount: u64, min_bin_id: i32, max_bin_id: i32`

**remaining_accounts:** All accounts from bin-farm's `OpenPositionV2` context:
`[user (vault_authority), config, lb_pair, position_counter, meteora_position,
bin_array_bitmap_ext, reserve_x, reserve_y, position, vault, user_token_account,
vault_token_x, vault_token_y, token_x_program, token_y_program, system_program,
bin_array_lower, bin_array_upper, event_authority, dlmm_program, token_x_mint, token_y_mint]`

Set `min_bin_id` and `max_bin_id` below the current `active_id` to create buy-side positions.
Max position width: 70 bins. Min deposit: 10,000 lamports.

### Dry Powder Trigger

Monitor Coinglass SOL liquidations API. When 24h liquidation volume exceeds a configurable
threshold (systemic drawdown), automatically deploy dry powder. Also support manual trigger.

---

## 7. HybridDlmmKeeper Oracle — Account Layout

When a bank uses `OracleSetup::HybridDlmmKeeper`, 7 oracle accounts are required
(in addition to the bank loader = 8 total per bank in remaining_accounts).

**oracle_keys in BankConfig:**
| Index | Account                |
|-------|------------------------|
| 0     | LbPair                 |
| 1     | StakePool (Sanctum)    |
| 2     | PythSolUsd             |
| 3     | KeeperOracle           |

**remaining_accounts per bank (7 oracle AIs):**
| Idx | Account      | Validated by       |
|-----|--------------|--------------------|
| 0   | LbPair       | oracle_keys[0]     |
| 1   | DlmmOracle   | derived from LbPair data @ oracle offset |
| 2   | ReserveX     | derived from LbPair data @ offset 152 |
| 3   | ReserveY     | derived from LbPair data @ offset 184 |
| 4   | StakePool    | oracle_keys[1], owner = Sanctum program |
| 5   | PythSolUsd   | oracle_keys[2]     |
| 6   | KeeperOracle | oracle_keys[3], owner = crank-lend program |

### Price Computation (on-chain)

1. DLMM TWAP bin computed from oracle samples (300s window)
2. `twap_price_in_crankSOL = bin_id_to_price(twap_bin, bin_step)`
3. `crankSOL_USD = (total_lamports / pool_token_supply) * pyth_sol_usd`
4. `dlmm_price_usd = twap_price_in_crankSOL * crankSOL_USD`
5. DLMM TVL from reserve balances: `dlmm_tvl = reserve_x * dlmm_price + reserve_y * crankSOL_USD`
6. If keeper fresh: `effective_price = (dlmm_price * dlmm_tvl + keeper_price * pumpswap_tvl) / (dlmm_tvl + pumpswap_tvl)`
7. If keeper stale: `effective_price = dlmm_price` with 5% confidence

---

## 8. crankSOL/USD Exchange Rate

Read from the Sanctum stake pool account at `9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg`:

| Field              | Type   | Byte Offset | Size |
|--------------------|--------|-------------|------|
| total_lamports     | u64 LE | 258         | 8    |
| pool_token_supply  | u64 LE | 266         | 8    |

```
SOL_per_crankSOL = total_lamports / pool_token_supply
crankSOL_USD = SOL_per_crankSOL * pyth_SOL_USD
```

---

## 9. VaultState & Events

### VaultState

```rust
pub struct VaultState {
    pub admin: Pubkey,
    pub crank_lend_group: Pubkey,
    pub marginfi_account: Pubkey,
    pub crank_mint: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault_authority_bump: u8,
    pub liquidation_count: u64,
    pub total_crank_liquidated: u64,
    pub total_usdc_collected: u64,
    pub total_sol_swapped: u64,
    pub total_cranksol_minted: u64,
    pub total_dlmm_bids_placed: u64,
    pub _reserved: [u8; 64],
}
```

**PDA:** `vault_authority` = `[b"vault_authority", vault_state.key()]`

### Anchor Events

| Event               | Fields                                       |
|---------------------|----------------------------------------------|
| LiquidationExecuted | vault, asset_amount, liquidation_count       |
| DryPowderSwap       | vault, usdc_amount                           |
| DryPowderMint       | vault, lamports                              |
| DryPowderBid        | vault, amount, min_bin_id, max_bin_id        |

Use these events (via gRPC transaction subscription or `getTransaction` parsing) to build
the ecosystem health dashboard.

---

## 10. Shared Utilities from crank-money

### GeyserSubscriber

In `bot/geyser-subscriber.ts`:
- `buildSubscriptionRequest()` — add new account filters for Pumpswap reserves
- Route by pubkey in the data handler
- `parseLbPairData()` and `parseActiveId()` are reusable standalone

### Bot Deployment

Existing infra: DO s-1vcpu-2gb, PM2, Nginx.

Add new bots to `ecosystem.config.cjs`:
```javascript
module.exports = {
  apps: [
    { name: 'crank-harvester', /* existing */ },
    { name: 'crank-keeper-oracle', script: 'npx', args: 'tsx bot/keeper-oracle.ts', max_memory_restart: '256M' },
    { name: 'crank-poke', script: 'npx', args: 'tsx bot/poke-bot.ts', max_memory_restart: '128M' },
    { name: 'crank-liquidator', script: 'npx', args: 'tsx bot/liquidator.ts', max_memory_restart: '256M' },
    { name: 'crank-backup-liquidator', script: 'npx', args: 'tsx bot/backup-liquidator.ts', max_memory_restart: '128M' },
  ]
};
```

Share the gRPC connection across bots where possible to conserve memory.

### Priority Fees

Reuse `buildPriorityFeeIxs()` from `bot/harvest-executor.ts` (median of recent fees, 10k floor).

### Retry Logic

Reuse `withRetry()` from `bot/retry.ts` (exponential backoff, 3 retries).

---

## 11. Water Cycle Overview

```
                    ┌──────────────┐
                    │  CRANK Supply│
                    │  (Lending)   │
                    │   250M CRANK │
                    └──────┬───────┘
                           │ borrow
                           ▼
                    ┌──────────────┐
                    │  Short Sells │──────► Market Volume
                    │  into Market │       (CRANK/SOL, CRANK/PEGGED)
                    └──────┬───────┘
                           │ repay OR liquidate
                    ┌──────┴───────┐
              ┌─────┤  Liquidator  ├─────┐
              │     │  Vault 250M  │     │
              │     └──────────────┘     │
              │ CRANK repays debt        │ USDC collateral seized
              │                          ▼
              │                   ┌──────────────┐
              │                   │  USDC → SOL  │ (Jupiter)
              │                   └──────┬───────┘
              │                          │
              │                   ┌──────▼───────┐
              │                   │ SOL → crankSOL│ (Sanctum)
              │                   └──────┬───────┘
              │                          │
              │                   ┌──────▼───────┐
              │                   │ DLMM Bids    │ (bin-farm)
              │                   │ Buy-side wall│
              │                   └──────┬───────┘
              │                          │ accumulate CRANK at lows
              │                          │
              └──────────────────────────┘
                    replenish liquidator supply
```

The USDC from liquidations flows through the dry powder pipeline, never hitting the CRANK/SOL
chart as market sells. The CRANK is re-accumulated at lows via DLMM bid walls, creating a
cyclical market-making loop.

---

## 12. Dashboard Data Sources

For the ecosystem health dashboard, read:

| Data Point                | Source                                |
|---------------------------|---------------------------------------|
| Lending supply CRANK      | crank-lend Bank asset_shares          |
| Borrowed CRANK            | crank-lend Bank liability_shares      |
| Liquidator CRANK balance  | VaultState + token accounts           |
| Liquidator USDC balance   | VaultState + token accounts           |
| DLMM CRANK/PEGGED pool   | LbPair reserves via gRPC             |
| Pumpswap CRANK/SOL pool   | Token accounts via gRPC              |
| crankSOL in circulation   | crankSOL mint supply                 |
| Liquidation history       | LiquidationExecuted events            |
| Dry powder conversions    | DryPowderSwap/Mint/Bid events        |
| VaultState cumulative     | On-chain VaultState fields            |
