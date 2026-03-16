use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use crate::state::VaultState;

/// Generic context for dry-powder pipeline actions (swap, mint, place bids).
/// Each instruction passes the target program + its accounts via remaining_accounts.
/// The vault_authority PDA signs via invoke_signed.
#[derive(Accounts)]
pub struct DryPowderAction<'info> {
    #[account(mut, has_one = admin)]
    pub vault_state: Account<'info, VaultState>,

    pub admin: Signer<'info>,

    /// CHECK: PDA authority for the vault.
    #[account(
        seeds = [b"vault_authority", vault_state.key().as_ref()],
        bump = vault_state.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// CHECK: The target program (Jupiter, Sanctum, or bin-farm) to CPI into.
    pub target_program: UncheckedAccount<'info>,
}

/// Swap USDC -> SOL via Jupiter. The bot builds the full Jupiter route instruction
/// and passes all required accounts via remaining_accounts. The vault PDA signs.
pub fn swap_usdc_to_sol<'info>(
    ctx: Context<'_, '_, 'info, 'info, DryPowderAction<'info>>,
    amount: u64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    let remaining = &ctx.remaining_accounts;

    require!(!remaining.is_empty(), ErrorCode::AccountNotEnoughKeys);

    let vault_key = vault.key();
    let seeds = &[
        b"vault_authority".as_ref(),
        vault_key.as_ref(),
        &[vault.vault_authority_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    // The first remaining_account is the pre-built Jupiter instruction data account.
    // The bot constructs the full Jupiter swap instruction and passes it here.
    // We forward the CPI with the vault_authority as signer.
    let mut account_metas: Vec<AccountMeta> = Vec::with_capacity(remaining.len());
    for ai in remaining.iter() {
        let meta = if ai.key() == ctx.accounts.vault_authority.key() {
            AccountMeta::new(ai.key(), true)
        } else if ai.is_writable {
            AccountMeta::new(ai.key(), ai.is_signer)
        } else {
            AccountMeta::new_readonly(ai.key(), ai.is_signer)
        };
        account_metas.push(meta);
    }

    let account_infos: Vec<AccountInfo> = remaining
        .iter()
        .map(|ai| ai.to_account_info())
        .collect();

    // Jupiter route instruction discriminator (0xe517cb977ae3ad2a)
    let ix_discriminator: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];
    let mut ix_data = Vec::with_capacity(8 + 8);
    ix_data.extend_from_slice(&ix_discriminator);
    ix_data.extend_from_slice(&amount.to_le_bytes());

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: ctx.accounts.target_program.key(),
        accounts: account_metas,
        data: ix_data,
    };

    invoke_signed(&ix, &account_infos, signer_seeds)?;

    vault.total_sol_swapped = vault.total_sol_swapped.saturating_add(amount);

    emit!(DryPowderSwap {
        vault: vault_key,
        usdc_amount: amount,
    });

    Ok(())
}

/// Mint crankSOL by CPI-ing into Sanctum SPL Stake Pool DepositSol.
/// remaining_accounts: [stake_pool, withdraw_authority, reserve_stake,
///                      pool_fee_account, dest_token_account, manager_fee_account,
///                      vault_authority (SOL source), pool_mint, token_program]
pub fn mint_cranksol<'info>(
    ctx: Context<'_, '_, 'info, 'info, DryPowderAction<'info>>,
    lamports: u64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    let remaining = &ctx.remaining_accounts;

    let vault_key = vault.key();
    let seeds = &[
        b"vault_authority".as_ref(),
        vault_key.as_ref(),
        &[vault.vault_authority_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let mut account_metas: Vec<AccountMeta> = Vec::with_capacity(remaining.len());
    for ai in remaining.iter() {
        let meta = if ai.key() == ctx.accounts.vault_authority.key() {
            AccountMeta::new(ai.key(), true)
        } else if ai.is_writable {
            AccountMeta::new(ai.key(), ai.is_signer)
        } else {
            AccountMeta::new_readonly(ai.key(), ai.is_signer)
        };
        account_metas.push(meta);
    }

    let account_infos: Vec<AccountInfo> = remaining
        .iter()
        .map(|ai| ai.to_account_info())
        .collect();

    // SPL Stake Pool DepositSol variant index = 14
    let mut ix_data = Vec::with_capacity(1 + 8);
    ix_data.push(14u8);
    ix_data.extend_from_slice(&lamports.to_le_bytes());

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: ctx.accounts.target_program.key(),
        accounts: account_metas,
        data: ix_data,
    };

    invoke_signed(&ix, &account_infos, signer_seeds)?;

    vault.total_cranksol_minted = vault.total_cranksol_minted.saturating_add(lamports);

    emit!(DryPowderMint {
        vault: vault_key,
        lamports,
    });

    Ok(())
}

/// Place DLMM buy-side bids via CPI into bin-farm's open_position_v2.
/// remaining_accounts: all accounts required by bin-farm OpenPositionV2 context.
pub fn place_dlmm_bids<'info>(
    ctx: Context<'_, '_, 'info, 'info, DryPowderAction<'info>>,
    amount: u64,
    min_bin_id: i32,
    max_bin_id: i32,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault_state;
    let remaining = &ctx.remaining_accounts;

    let vault_key = vault.key();
    let seeds = &[
        b"vault_authority".as_ref(),
        vault_key.as_ref(),
        &[vault.vault_authority_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let mut account_metas: Vec<AccountMeta> = Vec::with_capacity(remaining.len());
    for ai in remaining.iter() {
        let meta = if ai.key() == ctx.accounts.vault_authority.key() {
            AccountMeta::new(ai.key(), true)
        } else if ai.is_writable {
            AccountMeta::new(ai.key(), ai.is_signer)
        } else {
            AccountMeta::new_readonly(ai.key(), ai.is_signer)
        };
        account_metas.push(meta);
    }

    let account_infos: Vec<AccountInfo> = remaining
        .iter()
        .map(|ai| ai.to_account_info())
        .collect();

    // bin-farm open_position_v2 discriminator
    let ix_discriminator: [u8; 8] = anchor_lang::solana_program::hash::hash(
        b"global:open_position_v2",
    )
    .to_bytes()[..8]
        .try_into()
        .unwrap();

    let side: u8 = 0; // Side::Buy = 0 (ignored by bin-farm, derived on-chain)
    let max_active_bin_slippage: i32 = 5;

    let mut ix_data = Vec::with_capacity(8 + 8 + 4 + 4 + 1 + 4);
    ix_data.extend_from_slice(&ix_discriminator);
    ix_data.extend_from_slice(&amount.to_le_bytes());
    ix_data.extend_from_slice(&min_bin_id.to_le_bytes());
    ix_data.extend_from_slice(&max_bin_id.to_le_bytes());
    ix_data.push(side);
    ix_data.extend_from_slice(&max_active_bin_slippage.to_le_bytes());

    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: ctx.accounts.target_program.key(),
        accounts: account_metas,
        data: ix_data,
    };

    invoke_signed(&ix, &account_infos, signer_seeds)?;

    vault.total_dlmm_bids_placed = vault.total_dlmm_bids_placed.saturating_add(1);

    emit!(DryPowderBid {
        vault: vault_key,
        amount,
        min_bin_id,
        max_bin_id,
    });

    Ok(())
}

#[event]
pub struct DryPowderSwap {
    pub vault: Pubkey,
    pub usdc_amount: u64,
}

#[event]
pub struct DryPowderMint {
    pub vault: Pubkey,
    pub lamports: u64,
}

#[event]
pub struct DryPowderBid {
    pub vault: Pubkey,
    pub amount: u64,
    pub min_bin_id: i32,
    pub max_bin_id: i32,
}
