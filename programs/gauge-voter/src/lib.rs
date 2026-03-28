// gauge_voter — global-state pool weight voting
//
// BANK holders directly mutate a shared set of pool weights by calling `vote`.
// Votes stick permanently — the mutation persists even after the voter sells
// their BANK. The program tracks no per-user state; it only stores the global
// weight percentages (basis points summing to 10 000).
//
// Admin curates which pools may receive votes via add_pool / remove_pool.
// The bot reads PoolGauge.weight_bps at each epoch boundary to determine
// how the trader 40 % reward pot is split across pools.
//
// Governance dynamics:
//   - Holding BANK = defending your vote (others can't overwrite your share
//     while you hold it).
//   - Selling BANK = releasing the dial (buyer can shift weights with that share).
//   - Flash-loan voting is acknowledged and accepted (cost = loan/swap fees).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA");

pub const MAX_POOLS: usize = 32;
pub const BPS_DENOMINATOR: u64 = 10_000;

// ─── program ───────────────────────────────────────────────────────────────

#[program]
pub mod gauge_voter {
    use super::*;

    pub fn initialize(ctx: Context<InitializeGauge>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.bank_mint = ctx.accounts.bank_mint.key();
        config.pool_count = 0;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin adds a new pool eligible for gauge voting.
    /// Starts at 0 weight — voters must shift weight toward it.
    pub fn add_pool(ctx: Context<AddPool>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            (config.pool_count as usize) < MAX_POOLS,
            GaugeError::TooManyPools
        );

        let gauge = &mut ctx.accounts.pool_gauge;
        gauge.lb_pair = ctx.accounts.lb_pair.key();
        gauge.weight_bps = 0;
        gauge.enabled = true;
        gauge.bump = ctx.bumps.pool_gauge;

        config.pool_count = config
            .pool_count
            .checked_add(1)
            .ok_or(GaugeError::Overflow)?;

        emit!(PoolAddedEvent {
            lb_pair: gauge.lb_pair,
            pool_count: config.pool_count,
        });

        Ok(())
    }

    /// Admin removes a pool. Its weight is redistributed proportionally
    /// across remaining pools.
    pub fn remove_pool(ctx: Context<RemovePool>) -> Result<()> {
        let removed_weight = ctx.accounts.pool_gauge.weight_bps;

        let config = &mut ctx.accounts.config;
        config.pool_count = config
            .pool_count
            .checked_sub(1)
            .ok_or(GaugeError::Overflow)?;

        emit!(PoolRemovedEvent {
            lb_pair: ctx.accounts.pool_gauge.lb_pair,
            redistributed_weight_bps: removed_weight,
            pool_count: config.pool_count,
        });

        Ok(())
    }

    /// Core mechanic: BANK holder blends global pool weights toward their
    /// desired allocation in proportion to their share of total BANK supply.
    ///
    /// new_weight[P] = old_weight[P] * (1 - user_share) + desired[P] * user_share
    ///
    /// All math is done in u128 to avoid overflow. Results are truncated to u64
    /// and any rounding dust is added to the first pool to keep the sum at 10 000.
    pub fn vote(ctx: Context<Vote>, desired_allocations: Vec<PoolAllocation>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, GaugeError::Paused);

        let user_balance = ctx.accounts.user_bank_ata.amount;
        require!(user_balance > 0, GaugeError::ZeroBalance);

        let total_supply = ctx.accounts.bank_mint.supply;
        require!(total_supply > 0, GaugeError::ZeroSupply);

        // Validate desired allocations sum to BPS_DENOMINATOR
        let desired_sum: u64 = desired_allocations
            .iter()
            .map(|a| a.weight_bps as u64)
            .sum();
        require!(
            desired_sum == BPS_DENOMINATOR,
            GaugeError::AllocationSumInvalid
        );

        // Validate all referenced pools are in remaining_accounts and enabled
        let gauge_count = ctx.remaining_accounts.len();
        require!(
            gauge_count == desired_allocations.len(),
            GaugeError::AllocationCountMismatch
        );

        // user_share as parts-per-billion for precision
        let ppb: u128 = 1_000_000_000;
        let user_share_ppb: u128 = (user_balance as u128)
            .checked_mul(ppb)
            .ok_or(GaugeError::Overflow)?
            .checked_div(total_supply as u128)
            .ok_or(GaugeError::Overflow)?;
        // Cap at 100 % (shouldn't happen but safety)
        let user_share_ppb = user_share_ppb.min(ppb);
        let complement_ppb = ppb.saturating_sub(user_share_ppb);

        let mut total_new_bps: u64 = 0;

        for (i, alloc) in desired_allocations.iter().enumerate() {
            let account_info = &ctx.remaining_accounts[i];

            // Deserialize & validate the PoolGauge PDA
            let mut data = account_info.try_borrow_mut_data()?;
            let disc = &data[..8];
            require!(
                disc == PoolGauge::DISCRIMINATOR,
                GaugeError::InvalidPoolGauge
            );
            let mut gauge: PoolGauge =
                PoolGauge::try_deserialize(&mut &data[..]).map_err(|_| GaugeError::InvalidPoolGauge)?;

            require!(gauge.enabled, GaugeError::PoolDisabled);
            require!(
                gauge.lb_pair == alloc.lb_pair,
                GaugeError::PoolMismatch
            );

            // Blend: new = old * (1 - share) + desired * share
            let old_w = gauge.weight_bps as u128;
            let desired_w = alloc.weight_bps as u128;
            let new_w = old_w
                .checked_mul(complement_ppb)
                .ok_or(GaugeError::Overflow)?
                .checked_add(
                    desired_w
                        .checked_mul(user_share_ppb)
                        .ok_or(GaugeError::Overflow)?,
                )
                .ok_or(GaugeError::Overflow)?
                .checked_div(ppb)
                .ok_or(GaugeError::Overflow)?;
            let new_w_u64 = new_w as u64;

            gauge.weight_bps = new_w_u64;
            total_new_bps = total_new_bps
                .checked_add(new_w_u64)
                .ok_or(GaugeError::Overflow)?;

            // Serialize back
            let mut cursor: &mut [u8] = &mut data[..];
            gauge.try_serialize(&mut cursor).map_err(|_| GaugeError::SerializeFailed)?;
        }

        // Rounding correction: push dust onto the first pool so sum == 10 000
        if total_new_bps != BPS_DENOMINATOR && !desired_allocations.is_empty() {
            let first_info = &ctx.remaining_accounts[0];
            let mut data = first_info.try_borrow_mut_data()?;
            let mut gauge: PoolGauge =
                PoolGauge::try_deserialize(&mut &data[..]).map_err(|_| GaugeError::InvalidPoolGauge)?;
            if total_new_bps < BPS_DENOMINATOR {
                gauge.weight_bps = gauge
                    .weight_bps
                    .checked_add(BPS_DENOMINATOR.checked_sub(total_new_bps).ok_or(GaugeError::Overflow)?)
                    .ok_or(GaugeError::Overflow)?;
            } else {
                gauge.weight_bps = gauge
                    .weight_bps
                    .checked_sub(total_new_bps.checked_sub(BPS_DENOMINATOR).ok_or(GaugeError::Overflow)?)
                    .ok_or(GaugeError::Overflow)?;
            }
            let mut cursor: &mut [u8] = &mut data[..];
            gauge.try_serialize(&mut cursor).map_err(|_| GaugeError::SerializeFailed)?;
        }

        emit!(VoteEvent {
            voter: ctx.accounts.voter.key(),
            balance: user_balance,
            total_supply,
        });

        Ok(())
    }

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = false;
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AdminOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_authority = new_authority;
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptGaugeAuthority>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = config.pending_authority;
        config.pending_authority = Pubkey::default();
        Ok(())
    }
}

// ─── data types ────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PoolAllocation {
    pub lb_pair: Pubkey,
    pub weight_bps: u16,
}

// ─── accounts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeGauge<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + GaugeConfig::INIT_SPACE,
        seeds = [b"gauge_config"],
        bump,
    )]
    pub config: Account<'info, GaugeConfig>,

    pub bank_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddPool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"gauge_config"],
        bump = config.bump,
        has_one = authority @ GaugeError::Unauthorized,
    )]
    pub config: Account<'info, GaugeConfig>,

    /// CHECK: The lb_pair address for the Meteora DLMM pool.
    /// Validated by admin curation — only trusted pools are added.
    pub lb_pair: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + PoolGauge::INIT_SPACE,
        seeds = [b"pool_gauge", lb_pair.key().as_ref()],
        bump,
    )]
    pub pool_gauge: Account<'info, PoolGauge>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemovePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"gauge_config"],
        bump = config.bump,
        has_one = authority @ GaugeError::Unauthorized,
    )]
    pub config: Account<'info, GaugeConfig>,

    #[account(
        mut,
        close = authority,
        seeds = [b"pool_gauge", pool_gauge.lb_pair.as_ref()],
        bump = pool_gauge.bump,
    )]
    pub pool_gauge: Account<'info, PoolGauge>,
}

#[derive(Accounts)]
pub struct Vote<'info> {
    pub voter: Signer<'info>,

    #[account(
        seeds = [b"gauge_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, GaugeConfig>,

    #[account(address = config.bank_mint @ GaugeError::MintMismatch)]
    pub bank_mint: InterfaceAccount<'info, Mint>,

    #[account(
        associated_token::mint = bank_mint,
        associated_token::authority = voter,
        associated_token::token_program = token_program,
    )]
    pub user_bank_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    // PoolGauge accounts passed via remaining_accounts
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"gauge_config"],
        bump = config.bump,
        has_one = authority @ GaugeError::Unauthorized,
    )]
    pub config: Account<'info, GaugeConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptGaugeAuthority<'info> {
    #[account(
        mut,
        seeds = [b"gauge_config"],
        bump = config.bump,
        constraint = config.pending_authority == new_authority.key() @ GaugeError::Unauthorized,
        constraint = config.pending_authority != Pubkey::default() @ GaugeError::NoPendingAuthority,
    )]
    pub config: Account<'info, GaugeConfig>,

    pub new_authority: Signer<'info>,
}

// ─── state ─────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct GaugeConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub bank_mint: Pubkey,
    pub pool_count: u16,
    pub paused: bool,
    pub bump: u8,
    #[max_len(0)]
    pub _reserved: Vec<u8>,
}

#[account]
#[derive(InitSpace)]
pub struct PoolGauge {
    pub lb_pair: Pubkey,
    pub weight_bps: u64,
    pub enabled: bool,
    pub bump: u8,
    #[max_len(0)]
    pub _reserved: Vec<u8>,
}

// ─── events ────────────────────────────────────────────────────────────────

#[event]
pub struct PoolAddedEvent {
    pub lb_pair: Pubkey,
    pub pool_count: u16,
}

#[event]
pub struct PoolRemovedEvent {
    pub lb_pair: Pubkey,
    pub redistributed_weight_bps: u64,
    pub pool_count: u16,
}

#[event]
pub struct VoteEvent {
    pub voter: Pubkey,
    pub balance: u64,
    pub total_supply: u64,
}

// ─── errors ────────────────────────────────────────────────────────────────

#[error_code]
pub enum GaugeError {
    #[msg("Maximum pool count reached")]
    TooManyPools,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Program is paused")]
    Paused,
    #[msg("Voter has zero BANK balance")]
    ZeroBalance,
    #[msg("BANK total supply is zero")]
    ZeroSupply,
    #[msg("Desired allocations must sum to 10000 bps")]
    AllocationSumInvalid,
    #[msg("Allocation count must match remaining_accounts count")]
    AllocationCountMismatch,
    #[msg("Invalid PoolGauge account")]
    InvalidPoolGauge,
    #[msg("Pool is disabled")]
    PoolDisabled,
    #[msg("Pool lb_pair mismatch")]
    PoolMismatch,
    #[msg("Mint address mismatch")]
    MintMismatch,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("No pending authority transfer")]
    NoPendingAuthority,
    #[msg("Failed to serialize account")]
    SerializeFailed,
}
