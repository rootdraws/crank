use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::VaultState;

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    msg!("Deposited {} tokens into vault", amount);
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        has_one = admin,
    )]
    pub vault_state: Account<'info, VaultState>,

    pub admin: Signer<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(mut)]
    pub depositor_token_account: Account<'info, TokenAccount>,

    /// The vault's token account (PDA-owned).
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
