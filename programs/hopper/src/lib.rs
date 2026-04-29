// hopper — routing program for crank.money protocol revenue.
//
// Holds SOL + tribe token ATAs. Routes by on-chain rule:
//   - SOL: 40/40/20 split to W-Buy / Treasury / Personal (configurable bps).
//   - Token: per-mint route to a single destination wallet (W-{TOKEN}).
//
// Permissionless sweep cranking — anyone can fire sweep_sol / sweep_token.
// Replay safety: every sweep validates destinations against the live
// RoutingConfig at handler time, so admin retargets render queued sweeps
// inert (revert, not misroute).
//
// SOL custody pattern mirrors bin-farm BurnSolVault: HopperVault is a
// program-owned PDA, lamport-debit/credit directly (no system_program CPI
// per sweep).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount as ITokenAccount, TokenInterface, TransferChecked,
};

declare_id!("2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF");

pub const BPS_TOTAL: u16 = 10_000;
pub const MAX_CRANKER_TIP_BPS: u16 = 1_000; // hard cap 10%

#[program]
pub mod hopper {
    use super::*;

    // ─── ADMIN ───────────────────────────────────────────────────────────────

    pub fn initialize(
        ctx: Context<Initialize>,
        w_buy: Pubkey,
        treasury: Pubkey,
        personal: Pubkey,
        sol_split_bps: [u16; 3],
        sol_threshold_lamports: u64,
        cranker_tip_bps: u16,
    ) -> Result<()> {
        require!(
            sol_split_bps.iter().map(|x| *x as u32).sum::<u32>() == BPS_TOTAL as u32,
            HopperError::InvalidSplit
        );
        require!(cranker_tip_bps <= MAX_CRANKER_TIP_BPS, HopperError::TipTooHigh);
        require!(w_buy != Pubkey::default(), HopperError::InvalidDestination);
        require!(treasury != Pubkey::default(), HopperError::InvalidDestination);
        require!(personal != Pubkey::default(), HopperError::InvalidDestination);

        let cfg = &mut ctx.accounts.routing_config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.pending_admin = Pubkey::default();
        cfg.w_buy = w_buy;
        cfg.treasury = treasury;
        cfg.personal = personal;
        cfg.sol_split_bps = sol_split_bps;
        cfg.sol_threshold_lamports = sol_threshold_lamports;
        cfg.cranker_tip_bps = cranker_tip_bps;
        cfg.paused = false;
        cfg.bump = ctx.bumps.routing_config;

        let vault = &mut ctx.accounts.hopper_vault;
        vault.bump = ctx.bumps.hopper_vault;

        emit!(InitializedEvent {
            admin: cfg.admin,
            w_buy,
            treasury,
            personal,
            sol_split_bps,
            sol_threshold_lamports,
            cranker_tip_bps,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn update_routing(
        ctx: Context<AdminOnly>,
        new_w_buy: Option<Pubkey>,
        new_treasury: Option<Pubkey>,
        new_personal: Option<Pubkey>,
        new_sol_split_bps: Option<[u16; 3]>,
        new_sol_threshold_lamports: Option<u64>,
        new_cranker_tip_bps: Option<u16>,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.routing_config;
        if let Some(p) = new_w_buy {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
            cfg.w_buy = p;
        }
        if let Some(p) = new_treasury {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
            cfg.treasury = p;
        }
        if let Some(p) = new_personal {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
            cfg.personal = p;
        }
        if let Some(s) = new_sol_split_bps {
            require!(
                s.iter().map(|x| *x as u32).sum::<u32>() == BPS_TOTAL as u32,
                HopperError::InvalidSplit
            );
            cfg.sol_split_bps = s;
        }
        if let Some(t) = new_sol_threshold_lamports {
            cfg.sol_threshold_lamports = t;
        }
        if let Some(t) = new_cranker_tip_bps {
            require!(t <= MAX_CRANKER_TIP_BPS, HopperError::TipTooHigh);
            cfg.cranker_tip_bps = t;
        }

        emit!(RoutingUpdatedEvent {
            admin: cfg.admin,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn register_token_route(
        ctx: Context<RegisterTokenRoute>,
        destination: Pubkey,
        threshold: u64,
    ) -> Result<()> {
        require!(destination != Pubkey::default(), HopperError::InvalidDestination);

        let route = &mut ctx.accounts.token_route;
        route.mint = ctx.accounts.mint.key();
        route.destination = destination;
        route.threshold = threshold;
        route.enabled = true;
        route.bump = ctx.bumps.token_route;

        emit!(TokenRouteRegisteredEvent {
            mint: route.mint,
            destination,
            threshold,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn update_token_route(
        ctx: Context<UpdateTokenRoute>,
        new_destination: Option<Pubkey>,
        new_threshold: Option<u64>,
        new_enabled: Option<bool>,
    ) -> Result<()> {
        let route = &mut ctx.accounts.token_route;
        if let Some(d) = new_destination {
            require!(d != Pubkey::default(), HopperError::InvalidDestination);
            route.destination = d;
        }
        if let Some(t) = new_threshold {
            route.threshold = t;
        }
        if let Some(e) = new_enabled {
            route.enabled = e;
        }

        emit!(TokenRouteUpdatedEvent {
            mint: route.mint,
            destination: route.destination,
            threshold: route.threshold,
            enabled: route.enabled,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), HopperError::InvalidDestination);
        let cfg = &mut ctx.accounts.routing_config;
        cfg.pending_admin = new_admin;
        emit!(AdminTransferProposedEvent {
            current: cfg.admin,
            pending: new_admin,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let cfg = &mut ctx.accounts.routing_config;
        require!(
            cfg.pending_admin != Pubkey::default(),
            HopperError::NoPendingAdmin
        );
        require!(
            ctx.accounts.new_admin.key() == cfg.pending_admin,
            HopperError::Unauthorized
        );
        let old = cfg.admin;
        cfg.admin = cfg.pending_admin;
        cfg.pending_admin = Pubkey::default();
        emit!(AdminTransferAcceptedEvent {
            old,
            new: cfg.admin,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn pause(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let cfg = &mut ctx.accounts.routing_config;
        cfg.paused = paused;
        emit!(PauseToggledEvent {
            paused,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    // ─── PERMISSIONLESS SWEEPS ───────────────────────────────────────────────

    pub fn sweep_sol(ctx: Context<SweepSol>) -> Result<()> {
        let cfg = &ctx.accounts.routing_config;
        require!(!cfg.paused, HopperError::Paused);

        // Replay safety: validate destination accounts match current config.
        require!(
            ctx.accounts.w_buy.key() == cfg.w_buy,
            HopperError::InvalidDestination
        );
        require!(
            ctx.accounts.treasury.key() == cfg.treasury,
            HopperError::InvalidDestination
        );
        require!(
            ctx.accounts.personal.key() == cfg.personal,
            HopperError::InvalidDestination
        );

        let vault_info = ctx.accounts.hopper_vault.to_account_info();
        let vault_balance = vault_info.lamports();
        let vault_data_len = vault_info.data_len();
        let rent_min = Rent::get()?.minimum_balance(vault_data_len);
        let sweepable = vault_balance.saturating_sub(rent_min);

        require!(
            sweepable >= cfg.sol_threshold_lamports && sweepable > 0,
            HopperError::BelowThreshold
        );

        let tip = (sweepable as u128)
            .checked_mul(cfg.cranker_tip_bps as u128)
            .ok_or(HopperError::Overflow)?
            .checked_div(BPS_TOTAL as u128)
            .ok_or(HopperError::Overflow)? as u64;
        let net = sweepable.checked_sub(tip).ok_or(HopperError::Overflow)?;

        let buy = (net as u128)
            .checked_mul(cfg.sol_split_bps[0] as u128)
            .ok_or(HopperError::Overflow)?
            .checked_div(BPS_TOTAL as u128)
            .ok_or(HopperError::Overflow)? as u64;
        let treasury = (net as u128)
            .checked_mul(cfg.sol_split_bps[1] as u128)
            .ok_or(HopperError::Overflow)?
            .checked_div(BPS_TOTAL as u128)
            .ok_or(HopperError::Overflow)? as u64;
        // personal absorbs rounding remainder so total == net
        let personal = net
            .checked_sub(buy)
            .ok_or(HopperError::Overflow)?
            .checked_sub(treasury)
            .ok_or(HopperError::Overflow)?;

        // Lamport debit/credit (HopperVault is program-owned).
        **vault_info.try_borrow_mut_lamports()? = vault_balance
            .checked_sub(sweepable)
            .ok_or(HopperError::Overflow)?;
        **ctx.accounts.w_buy.try_borrow_mut_lamports()? = ctx
            .accounts
            .w_buy
            .lamports()
            .checked_add(buy)
            .ok_or(HopperError::Overflow)?;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? = ctx
            .accounts
            .treasury
            .lamports()
            .checked_add(treasury)
            .ok_or(HopperError::Overflow)?;
        **ctx.accounts.personal.try_borrow_mut_lamports()? = ctx
            .accounts
            .personal
            .lamports()
            .checked_add(personal)
            .ok_or(HopperError::Overflow)?;
        if tip > 0 {
            **ctx.accounts.cranker.try_borrow_mut_lamports()? = ctx
                .accounts
                .cranker
                .lamports()
                .checked_add(tip)
                .ok_or(HopperError::Overflow)?;
        }

        emit!(SolSweptEvent {
            sweepable,
            buy,
            treasury,
            personal,
            tip,
            cranker: ctx.accounts.cranker.key(),
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn sweep_token(ctx: Context<SweepToken>) -> Result<()> {
        let cfg = &ctx.accounts.routing_config;
        require!(!cfg.paused, HopperError::Paused);

        let route = &ctx.accounts.token_route;
        require!(route.enabled, HopperError::TokenRouteDisabled);
        require!(
            ctx.accounts.destination.key() == route.destination,
            HopperError::InvalidDestination
        );

        let amount = ctx.accounts.hopper_ata.amount;
        require!(amount >= route.threshold && amount > 0, HopperError::BelowThreshold);

        let vault_seeds: &[&[u8]] = &[b"hopper_vault", &[ctx.accounts.hopper_vault.bump]];
        let signer = &[vault_seeds];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.hopper_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.dest_ata.to_account_info(),
                    authority: ctx.accounts.hopper_vault.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(TokenSweptEvent {
            mint: ctx.accounts.mint.key(),
            amount,
            destination: route.destination,
            cranker: ctx.accounts.cranker.key(),
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

// ═══ ACCOUNTS ═══════════════════════════════════════════════════════════════

#[account]
pub struct RoutingConfig {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub w_buy: Pubkey,
    pub treasury: Pubkey,
    pub personal: Pubkey,
    pub sol_split_bps: [u16; 3],
    pub sol_threshold_lamports: u64,
    pub cranker_tip_bps: u16,
    pub paused: bool,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl RoutingConfig {
    // 8 (disc) + 5*32 (pubkeys) + 6 (split) + 8 (threshold) + 2 (tip) + 1 (paused) + 1 (bump) + 64 (reserved)
    pub const SIZE: usize = 8 + 32 * 5 + 6 + 8 + 2 + 1 + 1 + 64;
}

#[account]
pub struct TokenRoute {
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub threshold: u64,
    pub enabled: bool,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl TokenRoute {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 1 + 1 + 32;
}

#[account]
pub struct HopperVault {
    pub bump: u8,
}

impl HopperVault {
    pub const SIZE: usize = 8 + 1;
}

// ═══ INSTRUCTION CONTEXTS ═══════════════════════════════════════════════════

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = RoutingConfig::SIZE,
        seeds = [b"routing_config"],
        bump,
    )]
    pub routing_config: Account<'info, RoutingConfig>,

    #[account(
        init,
        payer = admin,
        space = HopperVault::SIZE,
        seeds = [b"hopper_vault"],
        bump,
    )]
    pub hopper_vault: Account<'info, HopperVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        constraint = admin.key() == routing_config.admin @ HopperError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"routing_config"],
        bump = routing_config.bump,
    )]
    pub routing_config: Account<'info, RoutingConfig>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"routing_config"],
        bump = routing_config.bump,
    )]
    pub routing_config: Account<'info, RoutingConfig>,
}

#[derive(Accounts)]
pub struct RegisterTokenRoute<'info> {
    #[account(
        mut,
        constraint = admin.key() == routing_config.admin @ HopperError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"routing_config"],
        bump = routing_config.bump,
    )]
    pub routing_config: Account<'info, RoutingConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = TokenRoute::SIZE,
        seeds = [b"token_route", mint.key().as_ref()],
        bump,
    )]
    pub token_route: Account<'info, TokenRoute>,

    #[account(
        seeds = [b"hopper_vault"],
        bump = hopper_vault.bump,
    )]
    pub hopper_vault: Account<'info, HopperVault>,

    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = hopper_vault,
        associated_token::token_program = token_program,
    )]
    pub hopper_ata: InterfaceAccount<'info, ITokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateTokenRoute<'info> {
    #[account(
        constraint = admin.key() == routing_config.admin @ HopperError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"routing_config"],
        bump = routing_config.bump,
    )]
    pub routing_config: Account<'info, RoutingConfig>,

    #[account(
        mut,
        seeds = [b"token_route", token_route.mint.as_ref()],
        bump = token_route.bump,
    )]
    pub token_route: Account<'info, TokenRoute>,
}

#[derive(Accounts)]
pub struct SweepSol<'info> {
    /// Anyone can crank.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [b"routing_config"],
        bump = routing_config.bump,
    )]
    pub routing_config: Account<'info, RoutingConfig>,

    #[account(
        mut,
        seeds = [b"hopper_vault"],
        bump = hopper_vault.bump,
    )]
    pub hopper_vault: Account<'info, HopperVault>,

    /// CHECK: validated in handler against routing_config.w_buy
    #[account(mut)]
    pub w_buy: AccountInfo<'info>,

    /// CHECK: validated in handler against routing_config.treasury
    #[account(mut)]
    pub treasury: AccountInfo<'info>,

    /// CHECK: validated in handler against routing_config.personal
    #[account(mut)]
    pub personal: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepToken<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [b"routing_config"],
        bump = routing_config.bump,
    )]
    pub routing_config: Account<'info, RoutingConfig>,

    #[account(
        seeds = [b"hopper_vault"],
        bump = hopper_vault.bump,
    )]
    pub hopper_vault: Account<'info, HopperVault>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        seeds = [b"token_route", mint.key().as_ref()],
        bump = token_route.bump,
        constraint = token_route.mint == mint.key() @ HopperError::InvalidDestination,
    )]
    pub token_route: Account<'info, TokenRoute>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = hopper_vault,
        associated_token::token_program = token_program,
    )]
    pub hopper_ata: InterfaceAccount<'info, ITokenAccount>,

    /// CHECK: validated in handler against token_route.destination
    pub destination: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = mint,
        associated_token::authority = destination,
        associated_token::token_program = token_program,
    )]
    pub dest_ata: InterfaceAccount<'info, ITokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

// ═══ ERRORS ═════════════════════════════════════════════════════════════════

#[error_code]
pub enum HopperError {
    #[msg("Not authorized")]
    Unauthorized,
    #[msg("Invalid destination pubkey (cannot be default)")]
    InvalidDestination,
    #[msg("SOL split bps must sum to 10_000")]
    InvalidSplit,
    #[msg("Cranker tip exceeds maximum (10%)")]
    TipTooHigh,
    #[msg("Hopper is paused")]
    Paused,
    #[msg("Sweepable amount below configured threshold")]
    BelowThreshold,
    #[msg("Token route disabled")]
    TokenRouteDisabled,
    #[msg("No pending admin transfer")]
    NoPendingAdmin,
    #[msg("Arithmetic overflow")]
    Overflow,
}

// ═══ EVENTS ═════════════════════════════════════════════════════════════════

#[event]
pub struct InitializedEvent {
    pub admin: Pubkey,
    pub w_buy: Pubkey,
    pub treasury: Pubkey,
    pub personal: Pubkey,
    pub sol_split_bps: [u16; 3],
    pub sol_threshold_lamports: u64,
    pub cranker_tip_bps: u16,
    pub ts: i64,
}

#[event]
pub struct RoutingUpdatedEvent {
    pub admin: Pubkey,
    pub ts: i64,
}

#[event]
pub struct TokenRouteRegisteredEvent {
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub threshold: u64,
    pub ts: i64,
}

#[event]
pub struct TokenRouteUpdatedEvent {
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub threshold: u64,
    pub enabled: bool,
    pub ts: i64,
}

#[event]
pub struct AdminTransferProposedEvent {
    pub current: Pubkey,
    pub pending: Pubkey,
    pub ts: i64,
}

#[event]
pub struct AdminTransferAcceptedEvent {
    pub old: Pubkey,
    pub new: Pubkey,
    pub ts: i64,
}

#[event]
pub struct PauseToggledEvent {
    pub paused: bool,
    pub ts: i64,
}

#[event]
pub struct SolSweptEvent {
    pub sweepable: u64,
    pub buy: u64,
    pub treasury: u64,
    pub personal: u64,
    pub tip: u64,
    pub cranker: Pubkey,
    pub ts: i64,
}

#[event]
pub struct TokenSweptEvent {
    pub mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
    pub cranker: Pubkey,
    pub ts: i64,
}
