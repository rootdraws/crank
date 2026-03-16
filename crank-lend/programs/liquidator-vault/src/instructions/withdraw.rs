use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::VaultState;

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let vault_key = ctx.accounts.vault_state.key();
    let seeds = &[
        b"vault_authority".as_ref(),
        vault_key.as_ref(),
        &[ctx.accounts.vault_state.vault_authority_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.admin_token_account.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    msg!("Withdrew {} tokens from vault", amount);
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(has_one = admin)]
    pub vault_state: Account<'info, VaultState>,

    pub admin: Signer<'info>,

    /// CHECK: PDA authority for the vault's token accounts.
    #[account(
        seeds = [b"vault_authority", vault_state.key().as_ref()],
        bump = vault_state.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
