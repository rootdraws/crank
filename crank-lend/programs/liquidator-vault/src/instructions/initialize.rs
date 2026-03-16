use anchor_lang::prelude::*;
use crate::state::VaultState;

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    vault.admin = ctx.accounts.admin.key();
    vault.crank_lend_group = ctx.accounts.crank_lend_group.key();
    vault.marginfi_account = ctx.accounts.marginfi_account.key();
    vault.crank_mint = ctx.accounts.crank_mint.key();
    vault.collateral_mint = ctx.accounts.collateral_mint.key();

    let (_, bump) = Pubkey::find_program_address(
        &[b"vault_authority", vault.key().as_ref()],
        ctx.program_id,
    );
    vault.vault_authority_bump = bump;
    vault.liquidation_count = 0;
    vault.total_crank_liquidated = 0;
    vault.total_usdc_collected = 0;
    vault.total_sol_swapped = 0;
    vault.total_cranksol_minted = 0;
    vault.total_dlmm_bids_placed = 0;

    msg!("Liquidator vault initialized");
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + std::mem::size_of::<VaultState>(),
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: The crank-lend group account, validated by the admin.
    pub crank_lend_group: UncheckedAccount<'info>,

    /// CHECK: The crank-lend marginfi account owned by this vault's PDA.
    /// Must be created beforehand with the vault_authority PDA as its authority.
    pub marginfi_account: UncheckedAccount<'info>,

    /// CHECK: CRANK token mint.
    pub crank_mint: UncheckedAccount<'info>,

    /// CHECK: Collateral token mint (e.g. USDC).
    pub collateral_mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
