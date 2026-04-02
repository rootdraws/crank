// epoch_vault — SOL fee accumulator for crank.money daily distributions
//
// Receives 80% of protocol fees from sweep_rover (40% holder + 40% trader shares
// via revenue_dest and trader_dest on bin-farm RoverAuthority).
// SOL accumulates for up to 24 hours, then the epoch-computer drains it,
// wraps to WSOL, and funds the Merkle distributor vault for user claims.
//
// bridge_vault PDA stays system-owned (legacy naming, same seeds) so it can
// receive native SOL transfers from sweep_rover without any account init.
//
// Instructions:
//   initialize      — admin sets config (once, already deployed)
//   update_config   — admin updates distributor/mint references
//   drain_vault     — authority withdraws SOL to a destination (for WSOL wrapping + distributor funding)

#![deny(clippy::unwrap_used)]
#![deny(clippy::integer_arithmetic)]

use anchor_lang::prelude::*;

declare_id!("7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN");

#[program]
pub mod epoch_vault {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        distributor: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.distributor = distributor;
        config._unused_1 = Pubkey::default();
        config._unused_2 = Pubkey::default();
        config.vault_bump = ctx.bumps.bridge_vault;
        config.config_bump = ctx.bumps.config;
        config.total_drained = 0;
        config.last_drain_ts = 0;
        config._reserved = [0u8; 46];

        msg!("epoch_vault initialized");
        msg!("distributor: {}", distributor);
        Ok(())
    }

    /// Authority drains SOL from the vault to a specified destination.
    /// The keeper calls this, then wraps to WSOL and funds the Merkle distributor.
    pub fn drain_vault(ctx: Context<DrainVault>, amount: u64) -> Result<()> {
        let vault_lamports = ctx.accounts.bridge_vault.lamports();
        let rent = Rent::get()?.minimum_balance(0);
        let available = vault_lamports.saturating_sub(rent);

        let drain_amount = if amount == 0 { available } else { amount.min(available) };
        require!(drain_amount > 0, VaultError::NothingToDrain);

        // Transfer SOL from vault PDA to destination
        let vault_bump = ctx.accounts.config.vault_bump;
        **ctx.accounts.bridge_vault.try_borrow_mut_lamports()? -= drain_amount;
        **ctx.accounts.destination.try_borrow_mut_lamports()? += drain_amount;

        // Update stats
        let config = &mut ctx.accounts.config;
        config.total_drained = config.total_drained.checked_add(drain_amount)
            .ok_or(VaultError::Overflow)?;
        config.last_drain_ts = Clock::get()?.unix_timestamp;

        emit!(VaultDrainedEvent {
            amount: drain_amount,
            destination: ctx.accounts.destination.key(),
            remaining: vault_lamports.checked_sub(drain_amount).unwrap_or(0),
            timestamp: config.last_drain_ts,
        });

        msg!("Drained {} lamports to {}", drain_amount, ctx.accounts.destination.key());
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_distributor: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(dist) = new_distributor {
            config.distributor = dist;
            msg!("Updated distributor to {}", dist);
        }
        Ok(())
    }
}

// ============ STATE ============

/// Layout matches the original BridgeConfig (200 bytes) so the existing on-chain
/// account deserializes without migration. Old fields repurposed:
///   stake_pool     → distributor
///   pegged_mint    → (unused, zeroed)
///   dist_pool_ata  → (unused, zeroed)
///   _reserved(62)  → total_drained(8) + last_drain_ts(8) + _reserved(46)
#[account]
pub struct BridgeConfig {
    pub authority: Pubkey,           // 32 — same
    pub distributor: Pubkey,         // 32 — was stake_pool
    pub _unused_1: Pubkey,           // 32 — was pegged_mint
    pub _unused_2: Pubkey,           // 32 — was dist_pool_pegged_ata
    pub vault_bump: u8,              // 1  — same
    pub config_bump: u8,             // 1  — same
    pub total_drained: u64,          // 8  — new (carved from old _reserved)
    pub last_drain_ts: i64,          // 8  — new (carved from old _reserved)
    pub _reserved: [u8; 46],         // 46 — remainder of old 62-byte _reserved
}

impl BridgeConfig {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 46; // = 200
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

    /// CHECK: Vault PDA — stays system-owned to receive native SOL from sweep_rover
    #[account(seeds = [b"bridge_vault"], bump)]
    pub bridge_vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DrainVault<'info> {
    #[account(constraint = authority.key() == config.authority @ VaultError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"bridge_config"], bump = config.config_bump)]
    pub config: Account<'info, BridgeConfig>,

    /// CHECK: Vault PDA — SOL source
    #[account(mut, seeds = [b"bridge_vault"], bump = config.vault_bump)]
    pub bridge_vault: AccountInfo<'info>,

    /// CHECK: Destination for drained SOL (typically WSOL ATA or bot wallet for wrapping)
    #[account(mut)]
    pub destination: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(constraint = authority.key() == config.authority @ VaultError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"bridge_config"], bump = config.config_bump)]
    pub config: Account<'info, BridgeConfig>,
}

// ============ EVENTS ============

#[event]
pub struct VaultDrainedEvent {
    pub amount: u64,
    pub destination: Pubkey,
    pub remaining: u64,
    pub timestamp: i64,
}

// ============ ERRORS ============

#[error_code]
pub enum VaultError {
    #[msg("Not authorized")]
    Unauthorized,

    #[msg("Nothing to drain (vault at rent minimum)")]
    NothingToDrain,

    #[msg("Arithmetic overflow")]
    Overflow,
}
