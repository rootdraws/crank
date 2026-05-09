// hopper — routing program for crank.money protocol revenue.
//
// Holds SOL + tribe token ATAs. Routes by on-chain rule (v2 layout, 4-way):
//   - SOL: split N-way (default 25/25/25/25) across treasury / admin / ops / tax.
//   - Token: per-mint enable/threshold gate; sweep distributes 4-way using the
//     same RoutingConfig destinations (one ATA per destination per mint).
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
        dest_treasury: Pubkey,
        dest_admin: Pubkey,
        dest_ops: Pubkey,
        dest_tax: Pubkey,
        sol_split_bps: [u16; 4],
        sol_threshold_lamports: u64,
        cranker_tip_bps: u16,
    ) -> Result<()> {
        require!(
            sol_split_bps.iter().map(|x| *x as u32).sum::<u32>() == BPS_TOTAL as u32,
            HopperError::InvalidSplit
        );
        require!(cranker_tip_bps <= MAX_CRANKER_TIP_BPS, HopperError::TipTooHigh);
        for p in [dest_treasury, dest_admin, dest_ops, dest_tax] {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
        }

        let cfg = &mut ctx.accounts.routing_config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.pending_admin = Pubkey::default();
        cfg.dest_treasury = dest_treasury;
        cfg.dest_admin = dest_admin;
        cfg.dest_ops = dest_ops;
        cfg.dest_tax = dest_tax;
        cfg.sol_split_bps = sol_split_bps;
        cfg.sol_threshold_lamports = sol_threshold_lamports;
        cfg.cranker_tip_bps = cranker_tip_bps;
        cfg.paused = false;
        cfg.bump = ctx.bumps.routing_config;

        let vault = &mut ctx.accounts.hopper_vault;
        vault.bump = ctx.bumps.hopper_vault;

        emit!(InitializedEvent {
            admin: cfg.admin,
            dest_treasury,
            dest_admin,
            dest_ops,
            dest_tax,
            sol_split_bps,
            sol_threshold_lamports,
            cranker_tip_bps,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn update_routing(
        ctx: Context<AdminOnly>,
        new_dest_treasury: Option<Pubkey>,
        new_dest_admin: Option<Pubkey>,
        new_dest_ops: Option<Pubkey>,
        new_dest_tax: Option<Pubkey>,
        new_sol_split_bps: Option<[u16; 4]>,
        new_sol_threshold_lamports: Option<u64>,
        new_cranker_tip_bps: Option<u16>,
    ) -> Result<()> {
        let cfg = &mut ctx.accounts.routing_config;
        if let Some(p) = new_dest_treasury {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
            cfg.dest_treasury = p;
        }
        if let Some(p) = new_dest_admin {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
            cfg.dest_admin = p;
        }
        if let Some(p) = new_dest_ops {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
            cfg.dest_ops = p;
        }
        if let Some(p) = new_dest_tax {
            require!(p != Pubkey::default(), HopperError::InvalidDestination);
            cfg.dest_tax = p;
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
        threshold: u64,
    ) -> Result<()> {
        let route = &mut ctx.accounts.token_route;
        route.mint = ctx.accounts.mint.key();
        route.threshold = threshold;
        route.enabled = true;
        route.bump = ctx.bumps.token_route;

        emit!(TokenRouteRegisteredEvent {
            mint: route.mint,
            threshold,
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn update_token_route(
        ctx: Context<UpdateTokenRoute>,
        new_threshold: Option<u64>,
        new_enabled: Option<bool>,
    ) -> Result<()> {
        let route = &mut ctx.accounts.token_route;
        if let Some(t) = new_threshold {
            route.threshold = t;
        }
        if let Some(e) = new_enabled {
            route.enabled = e;
        }

        emit!(TokenRouteUpdatedEvent {
            mint: route.mint,
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

    /// One-shot migration of an existing v1 RoutingConfig (3-way) to the v2
    /// (4-way) layout. Idempotent: skips if already at v2 size. Authority is
    /// verified by reading the on-chain `admin` field manually since the v2
    /// `Account<RoutingConfig>` deserializer would fail against a v1-sized
    /// account before this handler runs.
    ///
    /// Post-expand the dest_* fields contain v1's (w_buy, treasury, personal)
    /// bytes plus zeros for dest_tax. Caller MUST follow up with
    /// `update_routing(new_dest_treasury, new_dest_admin, new_dest_ops,
    /// new_dest_tax, new_sol_split_bps, ...)` to overwrite the carry-over.
    pub fn expand_routing_config_v2(ctx: Context<ExpandRoutingConfigV2>) -> Result<()> {
        let info = &ctx.accounts.routing_config.to_account_info();
        // Allow re-runs at v2 size (data_len == SIZE) so a second call can
        // re-zero structural fields + rewrite bump if the prior call left
        // them garbage. Reject anything that's neither v1 nor v2.
        require!(
            info.data_len() == RoutingConfig::SIZE
                || info.data_len() == RoutingConfig::SIZE_V1,
            HopperError::Unauthorized
        );

        // admin pubkey at offset 8 (after Anchor disc).
        {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 8 + 32, HopperError::Unauthorized);
            let mut buf = [0u8; 32];
            buf.copy_from_slice(&data[8..8 + 32]);
            require!(
                ctx.accounts.admin.key() == Pubkey::new_from_array(buf),
                HopperError::Unauthorized
            );
        }

        let new_size = RoutingConfig::SIZE;
        if info.data_len() < new_size {
            let needed = Rent::get()?.minimum_balance(new_size);
            let have = info.lamports();
            if needed > have {
                let topup = needed - have;
                anchor_lang::system_program::transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        anchor_lang::system_program::Transfer {
                            from: ctx.accounts.admin.to_account_info(),
                            to: info.clone(),
                        },
                    ),
                    topup,
                )?;
            }
            info.realloc(new_size, true)?;
        }

        // After realloc the v2 `bump` byte position contains either v1
        // garbage or a zero, so AdminOnly's `bump = routing_config.bump`
        // would fail PDA validation on every subsequent ix. Rewrite the
        // structural fields (paused, bump, cranker_tip, threshold, splits,
        // dest_tax) to known-good zeros / canonical values. Caller must
        // follow with `update_routing` to populate dest_treasury/admin/ops/tax
        // and sol_split_bps[4] before any sweep can run.
        // v2 data layout (after 8-byte Anchor disc):
        //   0..32  admin           (preserved from v1)
        //   32..64 pending_admin   (preserved from v1)
        //   64..96 dest_treasury   (= v1 w_buy bytes — overwrite via update_routing)
        //   96..128 dest_admin     (= v1 treasury bytes — overwrite)
        //   128..160 dest_ops      (= v1 personal bytes — overwrite)
        //   160..192 dest_tax      (zero out here)
        //   192..200 sol_split_bps [u16;4] (zero out)
        //   200..208 sol_threshold (zero out)
        //   208..210 cranker_tip   (zero out)
        //   210..211 paused        (zero out)
        //   211..212 bump          (canonical bump from ctx.bumps)
        let canonical_bump = ctx.bumps.routing_config;
        let mut data = info.try_borrow_mut_data()?;
        // Zero structural fields + canonical bump.
        for i in 8 + 160..8 + 211 {
            data[i] = 0;
        }
        data[8 + 211] = canonical_bump;

        msg!("RoutingConfig expanded to v2 ({} bytes), bump={}", new_size, canonical_bump);
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
        require!(ctx.accounts.dest_treasury.key() == cfg.dest_treasury, HopperError::InvalidDestination);
        require!(ctx.accounts.dest_admin.key()    == cfg.dest_admin,    HopperError::InvalidDestination);
        require!(ctx.accounts.dest_ops.key()      == cfg.dest_ops,      HopperError::InvalidDestination);
        require!(ctx.accounts.dest_tax.key()      == cfg.dest_tax,      HopperError::InvalidDestination);

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

        let split = |bps: u16| -> Result<u64> {
            Ok((net as u128)
                .checked_mul(bps as u128)
                .ok_or(HopperError::Overflow)?
                .checked_div(BPS_TOTAL as u128)
                .ok_or(HopperError::Overflow)? as u64)
        };
        let to_treasury = split(cfg.sol_split_bps[0])?;
        let to_admin    = split(cfg.sol_split_bps[1])?;
        let to_ops      = split(cfg.sol_split_bps[2])?;
        // tax absorbs rounding remainder so total == net
        let to_tax = net
            .checked_sub(to_treasury).ok_or(HopperError::Overflow)?
            .checked_sub(to_admin).ok_or(HopperError::Overflow)?
            .checked_sub(to_ops).ok_or(HopperError::Overflow)?;

        // Lamport debit/credit (HopperVault is program-owned).
        **vault_info.try_borrow_mut_lamports()? = vault_balance
            .checked_sub(sweepable)
            .ok_or(HopperError::Overflow)?;
        for (acct, amount) in [
            (&ctx.accounts.dest_treasury, to_treasury),
            (&ctx.accounts.dest_admin, to_admin),
            (&ctx.accounts.dest_ops, to_ops),
            (&ctx.accounts.dest_tax, to_tax),
        ] {
            if amount > 0 {
                **acct.try_borrow_mut_lamports()? = acct
                    .lamports()
                    .checked_add(amount)
                    .ok_or(HopperError::Overflow)?;
            }
        }
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
            to_treasury,
            to_admin,
            to_ops,
            to_tax,
            tip,
            cranker: ctx.accounts.cranker.key(),
            ts: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn sweep_token<'info>(ctx: Context<'_, '_, '_, 'info, SweepToken<'info>>) -> Result<()> {
        let cfg = &ctx.accounts.routing_config;
        require!(!cfg.paused, HopperError::Paused);

        let route = &ctx.accounts.token_route;
        require!(route.enabled, HopperError::TokenRouteDisabled);

        let total = ctx.accounts.hopper_ata.amount;
        require!(total >= route.threshold && total > 0, HopperError::BelowThreshold);

        // Replay safety: destination keys must match the live RoutingConfig.
        // ATAs are constrained to those keys via Anchor's `associated_token::authority`.
        require!(ctx.accounts.dest_treasury.key() == cfg.dest_treasury, HopperError::InvalidDestination);
        require!(ctx.accounts.dest_admin.key()    == cfg.dest_admin,    HopperError::InvalidDestination);
        require!(ctx.accounts.dest_ops.key()      == cfg.dest_ops,      HopperError::InvalidDestination);
        require!(ctx.accounts.dest_tax.key()      == cfg.dest_tax,      HopperError::InvalidDestination);

        let split = |bps: u16| -> Result<u64> {
            Ok((total as u128)
                .checked_mul(bps as u128)
                .ok_or(HopperError::Overflow)?
                .checked_div(BPS_TOTAL as u128)
                .ok_or(HopperError::Overflow)? as u64)
        };
        let to_treasury = split(cfg.sol_split_bps[0])?;
        let to_admin    = split(cfg.sol_split_bps[1])?;
        let to_ops      = split(cfg.sol_split_bps[2])?;
        let to_tax = total
            .checked_sub(to_treasury).ok_or(HopperError::Overflow)?
            .checked_sub(to_admin).ok_or(HopperError::Overflow)?
            .checked_sub(to_ops).ok_or(HopperError::Overflow)?;

        let vault_seeds: &[&[u8]] = &[b"hopper_vault", &[ctx.accounts.hopper_vault.bump]];
        let signer = &[vault_seeds];
        let mint_decimals = ctx.accounts.mint.decimals;

        let transfer_to = |dest_ata: &InterfaceAccount<'info, ITokenAccount>, amount: u64| -> Result<()> {
            if amount == 0 { return Ok(()); }
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.hopper_ata.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: dest_ata.to_account_info(),
                        authority: ctx.accounts.hopper_vault.to_account_info(),
                    },
                    signer,
                ),
                amount,
                mint_decimals,
            )
        };
        transfer_to(&ctx.accounts.dest_treasury_ata, to_treasury)?;
        transfer_to(&ctx.accounts.dest_admin_ata, to_admin)?;
        transfer_to(&ctx.accounts.dest_ops_ata, to_ops)?;
        transfer_to(&ctx.accounts.dest_tax_ata, to_tax)?;

        emit!(TokenSweptEvent {
            mint: ctx.accounts.mint.key(),
            total,
            to_treasury,
            to_admin,
            to_ops,
            to_tax,
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
    pub dest_treasury: Pubkey,
    pub dest_admin: Pubkey,
    pub dest_ops: Pubkey,
    pub dest_tax: Pubkey,
    pub sol_split_bps: [u16; 4],
    pub sol_threshold_lamports: u64,
    pub cranker_tip_bps: u16,
    pub paused: bool,
    pub bump: u8,
    pub _reserved: [u8; 64],
}

impl RoutingConfig {
    // 8 (disc) + 6*32 (pubkeys) + 8 (split [u16;4]) + 8 (threshold) + 2 (tip) + 1 (paused) + 1 (bump) + 64 (reserved)
    pub const SIZE: usize = 8 + 32 * 6 + 8 + 8 + 2 + 1 + 1 + 64;
    // v1 layout (3-way: w_buy/treasury/personal + sol_split_bps[3]). Used by
    // `expand_routing_config_v2` to detect migrate-eligible accounts.
    // Size = 8 disc + 32*5 pubkeys + 6 sol_split[3] + 8 threshold + 2 tip + 1 paused + 1 bump + 64 reserved
    pub const SIZE_V1: usize = 8 + 32 * 5 + 6 + 8 + 2 + 1 + 1 + 64;
}

#[account]
pub struct TokenRoute {
    pub mint: Pubkey,
    pub threshold: u64,
    pub enabled: bool,
    pub bump: u8,
    pub _reserved: [u8; 32],
}

impl TokenRoute {
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1 + 32;
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
pub struct ExpandRoutingConfigV2<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: PDA derivation enforces canonical RoutingConfig. Authority byte-check
    /// happens in the handler since v2 layout can't deserialize a v1-sized account.
    #[account(mut, seeds = [b"routing_config"], bump)]
    pub routing_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
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

    /// CHECK: validated in handler against routing_config.dest_treasury
    #[account(mut)]
    pub dest_treasury: AccountInfo<'info>,

    /// CHECK: validated in handler against routing_config.dest_admin
    #[account(mut)]
    pub dest_admin: AccountInfo<'info>,

    /// CHECK: validated in handler against routing_config.dest_ops
    #[account(mut)]
    pub dest_ops: AccountInfo<'info>,

    /// CHECK: validated in handler against routing_config.dest_tax
    #[account(mut)]
    pub dest_tax: AccountInfo<'info>,

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
    pub routing_config: Box<Account<'info, RoutingConfig>>,

    #[account(
        seeds = [b"hopper_vault"],
        bump = hopper_vault.bump,
    )]
    pub hopper_vault: Box<Account<'info, HopperVault>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [b"token_route", mint.key().as_ref()],
        bump = token_route.bump,
        constraint = token_route.mint == mint.key() @ HopperError::InvalidDestination,
    )]
    pub token_route: Box<Account<'info, TokenRoute>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = hopper_vault,
        associated_token::token_program = token_program,
    )]
    pub hopper_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: validated in handler against routing_config.dest_treasury
    pub dest_treasury: AccountInfo<'info>,
    /// CHECK: validated in handler against routing_config.dest_admin
    pub dest_admin: AccountInfo<'info>,
    /// CHECK: validated in handler against routing_config.dest_ops
    pub dest_ops: AccountInfo<'info>,
    /// CHECK: validated in handler against routing_config.dest_tax
    pub dest_tax: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = mint,
        associated_token::authority = dest_treasury,
        associated_token::token_program = token_program,
    )]
    pub dest_treasury_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = mint,
        associated_token::authority = dest_admin,
        associated_token::token_program = token_program,
    )]
    pub dest_admin_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = mint,
        associated_token::authority = dest_ops,
        associated_token::token_program = token_program,
    )]
    pub dest_ops_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(
        init_if_needed,
        payer = cranker,
        associated_token::mint = mint,
        associated_token::authority = dest_tax,
        associated_token::token_program = token_program,
    )]
    pub dest_tax_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

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
    pub dest_treasury: Pubkey,
    pub dest_admin: Pubkey,
    pub dest_ops: Pubkey,
    pub dest_tax: Pubkey,
    pub sol_split_bps: [u16; 4],
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
    pub threshold: u64,
    pub ts: i64,
}

#[event]
pub struct TokenRouteUpdatedEvent {
    pub mint: Pubkey,
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
    pub to_treasury: u64,
    pub to_admin: u64,
    pub to_ops: u64,
    pub to_tax: u64,
    pub tip: u64,
    pub cranker: Pubkey,
    pub ts: i64,
}

#[event]
pub struct TokenSweptEvent {
    pub mint: Pubkey,
    pub total: u64,
    pub to_treasury: u64,
    pub to_admin: u64,
    pub to_ops: u64,
    pub to_tax: u64,
    pub cranker: Pubkey,
    pub ts: i64,
}
