// bank_mint — burn $CRANK to mint $BANK 1:1
//
// Supply invariant: bank_supply + crank_supply <= 2B (enforced per instruction).
// CRANK started at 2B total; every BANK in existence represents permanently
// destroyed CRANK. The program PDA is the sole mint authority on $BANK.
//
// Token setup (off-chain, before initialize):
//   1. Create $BANK mint with deployer wallet as initial authority, 6 decimals.
//   2. Mint migration credit to deployer (for CRANK already burned via old NFT system).
//   3. Transfer mint authority to program PDA [b"bank_config"].
//   4. Call initialize.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    burn, mint_to, Burn, Mint, MintTo, TokenAccount, TokenInterface,
};

declare_id!("FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk");

/// 2 billion tokens with 6 decimals.
pub const MAX_SUPPLY: u64 = 2_000_000_000_000_000;

// ─── program ───────────────────────────────────────────────────────────────

#[program]
pub mod bank_mint {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.crank_mint = ctx.accounts.crank_mint.key();
        config.bank_mint = ctx.accounts.bank_mint.key();
        config.total_burned = 0;
        config.paused = false;
        config.bump = ctx.bumps.config;

        let bank = &ctx.accounts.bank_mint;
        require!(
            bank.mint_authority.contains(&config.key()),
            BankMintError::MintAuthorityMismatch
        );

        Ok(())
    }

    pub fn burn_and_mint(ctx: Context<BurnAndMint>, amount: u64) -> Result<()> {
        require!(amount > 0, BankMintError::ZeroAmount);

        let config = &ctx.accounts.config;
        require!(!config.paused, BankMintError::Paused);

        let crank_supply_post_burn = ctx
            .accounts
            .crank_mint
            .supply
            .checked_sub(amount)
            .ok_or(BankMintError::Overflow)?;

        let bank_supply_post_mint = ctx
            .accounts
            .bank_mint
            .supply
            .checked_add(amount)
            .ok_or(BankMintError::Overflow)?;

        // Invariant: bank_supply + crank_supply <= 2B
        require!(
            bank_supply_post_mint
                .checked_add(crank_supply_post_burn)
                .ok_or(BankMintError::Overflow)?
                <= MAX_SUPPLY,
            BankMintError::SupplyCapExceeded
        );

        // Burn CRANK from user
        burn(
            CpiContext::new(
                ctx.accounts.crank_token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.crank_mint.to_account_info(),
                    from: ctx.accounts.user_crank_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // Mint BANK to user (PDA signs)
        let seeds: &[&[u8]] = &[b"bank_config", &[ctx.accounts.config.bump]];
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.bank_token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.bank_mint.to_account_info(),
                    to: ctx.accounts.user_bank_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        let config = &mut ctx.accounts.config;
        config.total_burned = config
            .total_burned
            .checked_add(amount)
            .ok_or(BankMintError::Overflow)?;

        emit!(BurnAndMintEvent {
            user: ctx.accounts.user.key(),
            amount,
            crank_supply_post_burn,
            bank_supply_post_mint,
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

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = config.pending_authority;
        config.pending_authority = Pubkey::default();
        Ok(())
    }
}

// ─── accounts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + BankConfig::INIT_SPACE,
        seeds = [b"bank_config"],
        bump,
    )]
    pub config: Account<'info, BankConfig>,

    /// CRANK token mint (read-only, for address storage).
    pub crank_mint: InterfaceAccount<'info, Mint>,

    /// BANK token mint. Mint authority MUST already be the config PDA.
    #[account(
        constraint = bank_mint.decimals == 6 @ BankMintError::InvalidDecimals,
    )]
    pub bank_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnAndMint<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"bank_config"],
        bump = config.bump,
    )]
    pub config: Account<'info, BankConfig>,

    #[account(
        mut,
        address = config.crank_mint @ BankMintError::MintMismatch,
    )]
    pub crank_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        address = config.bank_mint @ BankMintError::MintMismatch,
    )]
    pub bank_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = crank_mint,
        associated_token::authority = user,
        associated_token::token_program = crank_token_program,
    )]
    pub user_crank_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = bank_mint,
        associated_token::authority = user,
        associated_token::token_program = bank_token_program,
    )]
    pub user_bank_ata: InterfaceAccount<'info, TokenAccount>,

    /// Token program for CRANK (may differ from BANK's if one is Token-2022).
    pub crank_token_program: Interface<'info, TokenInterface>,

    /// Token program for BANK.
    pub bank_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [b"bank_config"],
        bump = config.bump,
        has_one = authority @ BankMintError::Unauthorized,
    )]
    pub config: Account<'info, BankConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        mut,
        seeds = [b"bank_config"],
        bump = config.bump,
        constraint = config.pending_authority == new_authority.key() @ BankMintError::Unauthorized,
        constraint = config.pending_authority != Pubkey::default() @ BankMintError::NoPendingAuthority,
    )]
    pub config: Account<'info, BankConfig>,

    pub new_authority: Signer<'info>,
}

// ─── state ─────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct BankConfig {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub crank_mint: Pubkey,
    pub bank_mint: Pubkey,
    pub total_burned: u64,
    pub paused: bool,
    pub bump: u8,
    #[max_len(0)]
    pub _reserved: Vec<u8>,
}

// ─── events ────────────────────────────────────────────────────────────────

#[event]
pub struct BurnAndMintEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub crank_supply_post_burn: u64,
    pub bank_supply_post_mint: u64,
}

// ─── errors ────────────────────────────────────────────────────────────────

#[error_code]
pub enum BankMintError {
    #[msg("Mint authority on BANK must be the BankConfig PDA")]
    MintAuthorityMismatch,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Program is paused")]
    Paused,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Minting would exceed the 2B supply cap")]
    SupplyCapExceeded,
    #[msg("Mint address does not match config")]
    MintMismatch,
    #[msg("BANK mint must have 6 decimals")]
    InvalidDecimals,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("No pending authority transfer")]
    NoPendingAuthority,
}
