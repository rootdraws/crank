use anchor_lang::prelude::*;

pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("ANSWdD2DCkAgfBATyVsGc25oiAapqBKBZUSUHcpNj2ZS");

#[program]
pub mod liquidator_vault {
    use super::*;

    /// Initialize the vault with an admin authority.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    /// Deposit tokens (CRANK or USDC) into the vault.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Withdraw tokens from the vault (admin only).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Execute a liquidation via CPI into crank-lend.
    /// The vault repays the borrower's CRANK debt and receives USDC collateral.
    /// `liquidatee_remaining_count` and `liquidator_remaining_count` are the
    /// number of remaining_accounts belonging to each user's observation set,
    /// computed by the off-chain bot.
    pub fn execute_liquidation<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteLiquidation<'info>>,
        asset_amount: u64,
        liquidatee_remaining_count: u8,
        liquidator_remaining_count: u8,
    ) -> Result<()> {
        instructions::execute_liquidation::handler(
            ctx,
            asset_amount,
            liquidatee_remaining_count,
            liquidator_remaining_count,
        )
    }

    /// Swap USDC to SOL via Jupiter aggregator CPI.
    /// All Jupiter route accounts are passed via remaining_accounts.
    pub fn swap_usdc_to_sol<'info>(
        ctx: Context<'_, '_, 'info, 'info, DryPowderAction<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::dry_powder::swap_usdc_to_sol(ctx, amount)
    }

    /// Mint crankSOL by depositing SOL into the Sanctum SPL stake pool.
    pub fn mint_cranksol<'info>(
        ctx: Context<'_, '_, 'info, 'info, DryPowderAction<'info>>,
        lamports: u64,
    ) -> Result<()> {
        instructions::dry_powder::mint_cranksol(ctx, lamports)
    }

    /// Place DLMM buy-side positions via CPI into bin-farm.
    /// All bin-farm accounts are passed via remaining_accounts.
    pub fn place_dlmm_bids<'info>(
        ctx: Context<'_, '_, 'info, 'info, DryPowderAction<'info>>,
        amount: u64,
        min_bin_id: i32,
        max_bin_id: i32,
    ) -> Result<()> {
        instructions::dry_powder::place_dlmm_bids(ctx, amount, min_bin_id, max_bin_id)
    }
}
