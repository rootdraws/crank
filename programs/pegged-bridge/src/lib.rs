// pegged_bridge — SOL-to-$PEGGED staking bridge for crank.money
//
// Receives SOL from sweep_rover (via revenue_dest redirect to bridge_vault PDA),
// stakes it into the Sanctum SPL stake pool (multi-validator: MonkeDAO, LP Army,
// Helius), and forwards the minted $PEGGED to the monke_bananas dist_pool ATA.
// Permissionless crank.
//
// bridge_vault PDA intentionally stays system-owned (never init'd as program account)
// so the SPL stake pool's internal system_instruction::transfer works. PDA signing
// propagates through the CPI chain: bridge → stake_pool → system_program.
//
// Two user-facing instructions:
//   initialize        — admin sets stake pool config (once)
//   stake_and_forward — permissionless crank: SOL → stake → $PEGGED → dist_pool

#![deny(clippy::unwrap_used)]
#![deny(clippy::integer_arithmetic)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");

/// SPL Stake Pool program — Sanctum fork (mainnet)
pub const SPL_STAKE_POOL_PROGRAM: Pubkey =
    anchor_lang::solana_program::pubkey!("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");

/// Minimum SOL to trigger staking (0.01 SOL — below this, tx cost isn't worth it)
pub const MIN_STAKE_LAMPORTS: u64 = 10_000_000;

#[program]
pub mod pegged_bridge {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        stake_pool: Pubkey,
        pegged_mint: Pubkey,
        dist_pool_pegged_ata: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.stake_pool = stake_pool;
        config.pegged_mint = pegged_mint;
        config.dist_pool_pegged_ata = dist_pool_pegged_ata;
        config.vault_bump = ctx.bumps.bridge_vault;
        config.config_bump = ctx.bumps.config;
        config._reserved = [0u8; 62];

        msg!("pegged_bridge initialized");
        msg!("stake_pool: {}", stake_pool);
        msg!("pegged_mint: {}", pegged_mint);
        msg!("dist_pool_ata: {}", dist_pool_pegged_ata);
        Ok(())
    }

    /// Permissionless crank. Stakes all available SOL in bridge_vault into the
    /// SPL stake pool, mints $PEGGED to a bridge-owned ATA, then forwards all
    /// $PEGGED to the monke_bananas dist_pool ATA. Bot never touches funds.
    pub fn stake_and_forward(ctx: Context<StakeAndForward>) -> Result<()> {
        let config = &ctx.accounts.config;
        let vault_bump = config.vault_bump;

        // 1. Calculate stakeable SOL (vault balance minus rent-exempt minimum for 0-byte account)
        let vault_lamports = ctx.accounts.bridge_vault.lamports();
        let rent = Rent::get()?.minimum_balance(0);
        let stakeable = vault_lamports.saturating_sub(rent);
        require!(stakeable >= MIN_STAKE_LAMPORTS, BridgeError::NothingToStake);

        // 2. CPI into SPL stake pool DepositSol
        //    Borsh encoding: [14u8 (variant index), lamports (u64 LE)]
        let mut ix_data = Vec::with_capacity(9);
        ix_data.push(14u8);
        ix_data.extend_from_slice(&stakeable.to_le_bytes());

        // Account ordering per spl-stake-pool instruction.rs DepositSol:
        //  0 [w]    stake_pool
        //  1 []     withdraw_authority (PDA of stake pool program)
        //  2 [w]    reserve_stake
        //  3 [s][w] from (SOL source — bridge_vault PDA, signed via invoke_signed)
        //  4 [w]    dest (receive minted pool tokens — bridge ATA)
        //  5 [w]    manager_fee_account
        //  6 [w]    referral_fee_dest (= bridge ATA, self-referral)
        //  7 [w]    pool_mint ($PEGGED)
        //  8 []     system_program
        //  9 []     token_program
        let deposit_ix = Instruction {
            program_id: SPL_STAKE_POOL_PROGRAM,
            accounts: vec![
                AccountMeta::new(ctx.accounts.stake_pool.key(), false),
                AccountMeta::new_readonly(ctx.accounts.stake_pool_withdraw_authority.key(), false),
                AccountMeta::new(ctx.accounts.reserve_stake.key(), false),
                AccountMeta::new(ctx.accounts.bridge_vault.key(), true),
                AccountMeta::new(ctx.accounts.bridge_pegged_ata.key(), false),
                AccountMeta::new(ctx.accounts.manager_fee_account.key(), false),
                AccountMeta::new(ctx.accounts.bridge_pegged_ata.key(), false),
                AccountMeta::new(ctx.accounts.pegged_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
            ],
            data: ix_data,
        };

        let vault_seeds: &[&[u8]] = &[b"bridge_vault", &[vault_bump]];

        invoke_signed(
            &deposit_ix,
            &[
                ctx.accounts.stake_pool.to_account_info(),
                ctx.accounts.stake_pool_withdraw_authority.to_account_info(),
                ctx.accounts.reserve_stake.to_account_info(),
                ctx.accounts.bridge_vault.to_account_info(),
                ctx.accounts.bridge_pegged_ata.to_account_info(),
                ctx.accounts.manager_fee_account.to_account_info(),
                ctx.accounts.pegged_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.stake_pool_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        // 3. Reload bridge ATA to capture post-deposit $PEGGED balance, forward all to dist_pool
        ctx.accounts.bridge_pegged_ata.reload()?;
        let pegged_to_forward = ctx.accounts.bridge_pegged_ata.amount;
        require!(pegged_to_forward > 0, BridgeError::NoPeggedMinted);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bridge_pegged_ata.to_account_info(),
                    to: ctx.accounts.dist_pool_pegged_ata.to_account_info(),
                    authority: ctx.accounts.bridge_vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            pegged_to_forward,
        )?;

        emit!(StakeAndForwardEvent {
            stakeable,
            pegged_minted: pegged_to_forward,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!(
            "Staked {} lamports → {} $PEGGED forwarded to dist_pool",
            stakeable,
            pegged_to_forward
        );
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_stake_pool: Option<Pubkey>,
        new_pegged_mint: Option<Pubkey>,
        new_dist_pool_pegged_ata: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(pool) = new_stake_pool {
            config.stake_pool = pool;
            msg!("Updated stake_pool to {}", pool);
        }
        if let Some(mint) = new_pegged_mint {
            config.pegged_mint = mint;
            msg!("Updated pegged_mint to {}", mint);
        }
        if let Some(ata) = new_dist_pool_pegged_ata {
            config.dist_pool_pegged_ata = ata;
            msg!("Updated dist_pool_pegged_ata to {}", ata);
        }
        Ok(())
    }
}

// ============ STATE ============

#[account]
pub struct BridgeConfig {
    pub authority: Pubkey,
    pub stake_pool: Pubkey,
    pub pegged_mint: Pubkey,
    pub dist_pool_pegged_ata: Pubkey,
    pub vault_bump: u8,
    pub config_bump: u8,
    pub _reserved: [u8; 62],
}

impl BridgeConfig {
    pub const SIZE: usize = 8 + // discriminator
        32 + // authority
        32 + // stake_pool
        32 + // pegged_mint
        32 + // dist_pool_pegged_ata
        1 +  // vault_bump
        1 +  // config_bump
        62;  // _reserved
}

// ============ CONTEXTS ============

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = BridgeConfig::SIZE,
        seeds = [b"bridge_config"],
        bump
    )]
    pub config: Account<'info, BridgeConfig>,

    /// CHECK: Bridge vault PDA — must stay system-owned so SPL stake pool's
    /// internal system_instruction::transfer works via PDA signing propagation.
    #[account(seeds = [b"bridge_vault"], bump)]
    pub bridge_vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StakeAndForward<'info> {
    /// Anyone can crank (permissionless — bot just does it faster)
    pub crank: Signer<'info>,

    #[account(seeds = [b"bridge_config"], bump = config.config_bump)]
    pub config: Account<'info, BridgeConfig>,

    /// CHECK: Bridge vault PDA — system-owned, SOL source for stake pool deposit
    #[account(mut, seeds = [b"bridge_vault"], bump = config.vault_bump)]
    pub bridge_vault: AccountInfo<'info>,

    /// Bridge vault's $PEGGED ATA — receives minted tokens, then forwards to dist_pool
    #[account(
        mut,
        constraint = bridge_pegged_ata.owner == bridge_vault.key() @ BridgeError::InvalidTokenAccount,
        constraint = bridge_pegged_ata.mint == config.pegged_mint @ BridgeError::InvalidMint,
    )]
    pub bridge_pegged_ata: Account<'info, TokenAccount>,

    /// Dist pool's $PEGGED ATA on monke_bananas — final destination
    #[account(
        mut,
        constraint = dist_pool_pegged_ata.key() == config.dist_pool_pegged_ata @ BridgeError::InvalidDistPool,
    )]
    pub dist_pool_pegged_ata: Account<'info, TokenAccount>,

    /// $PEGGED mint (pool token mint from SPL stake pool)
    #[account(
        mut,
        constraint = pegged_mint.key() == config.pegged_mint @ BridgeError::InvalidMint,
    )]
    pub pegged_mint: Account<'info, Mint>,

    /// CHECK: SPL stake pool state account
    #[account(
        mut,
        constraint = stake_pool.key() == config.stake_pool @ BridgeError::InvalidStakePool,
    )]
    pub stake_pool: AccountInfo<'info>,

    /// CHECK: Stake pool withdraw authority — PDA of SPL stake pool program
    pub stake_pool_withdraw_authority: AccountInfo<'info>,

    /// CHECK: Reserve stake account (from stake pool state)
    #[account(mut)]
    pub reserve_stake: AccountInfo<'info>,

    /// CHECK: Pool manager fee token account (from stake pool state)
    #[account(mut)]
    pub manager_fee_account: AccountInfo<'info>,

    /// CHECK: SPL Stake Pool program — validated against known ID
    #[account(
        constraint = stake_pool_program.key() == SPL_STAKE_POOL_PROGRAM @ BridgeError::InvalidProgram,
    )]
    pub stake_pool_program: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(constraint = authority.key() == config.authority @ BridgeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"bridge_config"], bump = config.config_bump)]
    pub config: Account<'info, BridgeConfig>,
}

// ============ EVENTS ============

#[event]
pub struct StakeAndForwardEvent {
    pub stakeable: u64,
    pub pegged_minted: u64,
    pub timestamp: i64,
}

// ============ ERRORS ============

#[error_code]
pub enum BridgeError {
    #[msg("Not authorized")]
    Unauthorized,

    #[msg("Nothing to stake (bridge vault below minimum)")]
    NothingToStake,

    #[msg("No $PEGGED minted from stake pool deposit")]
    NoPeggedMinted,

    #[msg("Invalid token account")]
    InvalidTokenAccount,

    #[msg("Invalid mint")]
    InvalidMint,

    #[msg("Invalid dist pool ATA")]
    InvalidDistPool,

    #[msg("Invalid stake pool")]
    InvalidStakePool,

    #[msg("Invalid program")]
    InvalidProgram,
}
