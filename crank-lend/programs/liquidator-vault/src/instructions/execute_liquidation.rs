use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use crate::state::VaultState;

/// Execute a liquidation through the vault's PDA authority. The vault authority signs
/// the crank-lend `lending_account_liquidate` instruction via CPI.
///
/// The bot passes remaining_accounts in crank-lend's expected order but WITHOUT the
/// `authority` field (which the vault inserts as a PDA signer). Layout:
///
///   [0]  group
///   [1]  asset_bank                     (mut)
///   [2]  liab_bank                      (mut)
///   [3]  liquidator_marginfi_account    (mut, vault's account)
///   [4]  liquidatee_marginfi_account    (mut)
///   [5]  bank_liquidity_vault_authority
///   [6]  bank_liquidity_vault           (mut)
///   [7]  bank_insurance_vault           (mut)
///   [8]  token_program
///   [9+] oracle/observation remaining accounts
///
/// The vault inserts `vault_authority` at index 4 (the `authority` slot in
/// LendingAccountLiquidate), shifting indices 4+ down by one.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteLiquidation<'info>>,
    asset_amount: u64,
    liquidatee_remaining_count: u8,
    liquidator_remaining_count: u8,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    let remaining = &ctx.remaining_accounts;

    require!(remaining.len() >= 9, ErrorCode::AccountNotEnoughKeys);

    let vault_key = vault.key();
    let seeds = &[
        b"vault_authority".as_ref(),
        vault_key.as_ref(),
        &[vault.vault_authority_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let crank_lend_program = &ctx.accounts.crank_lend_program;

    // Build account metas: mirror remaining_accounts, then insert vault_authority at index 4.
    let mut account_metas: Vec<AccountMeta> = Vec::with_capacity(remaining.len() + 1);
    for ai in remaining.iter() {
        account_metas.push(if ai.is_writable {
            AccountMeta::new(ai.key(), false)
        } else {
            AccountMeta::new_readonly(ai.key(), false)
        });
    }
    account_metas.insert(
        4,
        AccountMeta::new_readonly(ctx.accounts.vault_authority.key(), true),
    );

    // Build account infos: mirror remaining_accounts, insert vault_authority at index 4.
    let mut account_infos: Vec<AccountInfo> = Vec::with_capacity(remaining.len() + 1);
    for (i, ai) in remaining.iter().enumerate() {
        account_infos.push(ai.to_account_info());
        if i == 3 {
            account_infos.push(ctx.accounts.vault_authority.to_account_info());
        }
    }

    // Build instruction data: discriminator + asset_amount + liquidatee_accounts + liquidator_accounts
    let ix_discriminator: [u8; 8] = anchor_lang::solana_program::hash::hash(
        b"global:lending_account_liquidate",
    )
    .to_bytes()[..8]
        .try_into()
        .unwrap();

    let mut ix_data = Vec::with_capacity(8 + 8 + 1 + 1);
    ix_data.extend_from_slice(&ix_discriminator);
    ix_data.extend_from_slice(&asset_amount.to_le_bytes());
    ix_data.push(liquidatee_remaining_count);
    ix_data.push(liquidator_remaining_count);

    let ix = Instruction {
        program_id: crank_lend_program.key(),
        accounts: account_metas,
        data: ix_data,
    };

    invoke_signed(&ix, &account_infos, signer_seeds)?;

    vault.liquidation_count = vault.liquidation_count.saturating_add(1);
    vault.total_crank_liquidated = vault
        .total_crank_liquidated
        .saturating_add(asset_amount);

    emit!(LiquidationExecuted {
        vault: vault_key,
        asset_amount,
        liquidation_count: vault.liquidation_count,
    });

    msg!("Liquidation #{} executed via vault", vault.liquidation_count);
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteLiquidation<'info> {
    #[account(mut, has_one = admin)]
    pub vault_state: Account<'info, VaultState>,

    pub admin: Signer<'info>,

    /// CHECK: PDA authority for the vault.
    #[account(
        seeds = [b"vault_authority", vault_state.key().as_ref()],
        bump = vault_state.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: The crank-lend program to CPI into.
    pub crank_lend_program: UncheckedAccount<'info>,
}

#[event]
pub struct LiquidationExecuted {
    pub vault: Pubkey,
    pub asset_amount: u64,
    pub liquidation_count: u64,
}
