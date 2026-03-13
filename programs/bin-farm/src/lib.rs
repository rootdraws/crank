// crank.money Core Contract
// Wraps Meteora DLMM with custody + auto-close capability
//
#![deny(clippy::integer_arithmetic)]
#![deny(clippy::unwrap_used)]
//
// SECURITY FIXES applied:
// - Vault PDA is per-position (not per-pool) — prevents cross-position drainage
// - All token accounts validated for correct owner
// - All fees route to rover_authority ATAs (sweep_rover splits 50/50: holders + bot)
// - Meteora accounts explicit in contexts (not remaining_accounts)
// - claim_fees fully wired (was a stub)
// - All 4 CPI TODOs replaced with verified Meteora CPI calls

use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_spl::token_interface::{TokenAccount as ITokenAccount, TransferChecked, transfer_checked};

mod meteora_dlmm_cpi;
use meteora_dlmm_cpi::*;

declare_id!("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia");

pub const DEFAULT_FEE_BPS: u16 = 30;

/// Minimum token deposit for rover positions (anti-griefing)
pub const MIN_ROVER_DEPOSIT: u64 = 10_000;

/// Minimum deposit amount for user positions (anti-griefing, prevents dust positions)
pub const MIN_POSITION_AMOUNT: u64 = 10_000;

/// Minimum bin_step for rover positions. Prevents instant liquidation
/// on low bin_step pools (bin_step=1 gives only 0.7% range with 2x formula).
/// bin_step=20 gives ~346 bins at ~0.2% spacing, covering ~100% above current price.
pub const MIN_ROVER_BIN_STEP: u16 = 20;

pub const TOKEN_2022_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

#[program]
pub mod bin_farm {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        bot: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= 1000, CoreError::FeeTooHigh);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.pending_authority = Pubkey::default();
        config.bot = bot;
        config.fee_bps = fee_bps;
        config.pending_fee_bps = 0;
        config.fee_change_at = 0;
        config.total_positions = 0;
        config.total_volume = 0;
        config.paused = false;
        config.bot_paused = false;
        config.bump = ctx.bumps.config;
        config.last_bot_harvest_slot = 0;
        config.keeper_tip_bps = 1000; // 10% default tip for permissionless harvesters
        config.priority_slots = 100;  // ~40 seconds before permissionless harvest unlocks
        config.total_harvested = 0;
        config.pending_emergency_close = Pubkey::default();
        config.emergency_close_at = 0;
        config.last_bot_close_slot = 0;
        config.last_bot_sweep_slot = 0;
        config._reserved = [0u8; 96];

        msg!("crank.money initialized | bot={} fee={}bps", bot, fee_bps);
        Ok(())
    }

    pub fn open_position_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenPositionV2<'info>>,
        amount: u64,
        min_bin_id: i32,
        max_bin_id: i32,
        _side: Side,
        max_active_bin_slippage: i32,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CoreError::Paused);
        require!(amount > 0, CoreError::ZeroAmount);
        require!(amount >= MIN_POSITION_AMOUNT, CoreError::PositionTooSmall);
        require!(max_active_bin_slippage >= 0 && max_active_bin_slippage <= 20, CoreError::InvalidSlippage);
        require!(min_bin_id <= max_bin_id, CoreError::InvalidBinRange);
        let width = max_bin_id - min_bin_id + 1;
        require!(width <= MAX_POSITION_WIDTH, CoreError::PositionTooWide);

        // Validate DLMM program
        require!(ctx.accounts.dlmm_program.key() == METEORA_DLMM_PROGRAM_ID, CoreError::InvalidProgram);

        // Validate token account owners (moved from struct constraints for stack savings)
        {
            let data = ctx.accounts.user_token_account.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.user.key(), CoreError::InvalidTokenOwner);
        }
        {
            let data = ctx.accounts.vault_token_x.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.vault.key(), CoreError::InvalidTokenOwner);
        }
        {
            let data = ctx.accounts.vault_token_y.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.vault.key(), CoreError::InvalidTokenOwner);
        }

        // Derive side from on-chain active_id — never trust caller
        let active_id = {
            let data = ctx.accounts.lb_pair.try_borrow_data()?;
            require!(data.len() >= 80, CoreError::InvalidPool);
            i32::from_le_bytes(data[76..80].try_into().map_err(|_| CoreError::Overflow)?)
        };
        require!(active_id > -443636 && active_id < 443636, CoreError::InvalidBinRange);
        let side = if min_bin_id > active_id { Side::Sell } else { Side::Buy };

        let deposit_token_program = if side == Side::Sell {
            &ctx.accounts.token_x_program
        } else {
            &ctx.accounts.token_y_program
        };

        let deposit_vault = if side == Side::Sell {
            &ctx.accounts.vault_token_x
        } else {
            &ctx.accounts.vault_token_y
        };
        let transfer_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: *deposit_token_program.key,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.user_token_account.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(deposit_vault.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.user.key(), true),
            ],
            data: {
                let mut d = vec![3u8];
                d.extend_from_slice(&amount.to_le_bytes());
                d
            },
        };
        anchor_lang::solana_program::program::invoke(
            &transfer_ix,
            &[
                ctx.accounts.user_token_account.to_account_info(),
                deposit_vault.to_account_info(),
                ctx.accounts.user.to_account_info(),
                deposit_token_program.to_account_info(),
            ],
        )?;

        // Build PDA signer seeds for meteora_position (replaces keypair signing)
        let user_key = ctx.accounts.user.key();
        let lb_pair_key = ctx.accounts.lb_pair.key();
        let count_bytes = ctx.accounts.position_counter.count.to_le_bytes();
        let meteora_pos_bump = [ctx.bumps.meteora_position];

        let meteora_pos_key = ctx.accounts.meteora_position.key();
        let meteora_pos_seeds: &[&[u8]] = &[
            b"meteora_pos",
            user_key.as_ref(),
            lb_pair_key.as_ref(),
            &count_bytes,
            &meteora_pos_bump,
        ];
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer = &[vault_seeds, meteora_pos_seeds];

        let bin_array_lower = ctx.accounts.bin_array_lower.to_account_info();
        let bin_array_upper = ctx.accounts.bin_array_upper.to_account_info();
        let event_authority = ctx.accounts.event_authority.to_account_info();
        let dlmm_program = ctx.accounts.dlmm_program.to_account_info();
        let token_x_mint = ctx.accounts.token_x_mint.to_account_info();
        let token_y_mint = ctx.accounts.token_y_mint.to_account_info();

        initialize_position2(
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                event_authority.clone(),
                dlmm_program.clone(),
            ],
            min_bin_id,
            width,
            signer,
        )?;

        let (amount_x, amount_y) = if side == Side::Sell { (amount, 0u64) } else { (0u64, amount) };
        let liquidity_params = LiquidityParameterByStrategy {
            amount_x,
            amount_y,
            active_id,
            max_active_bin_slippage,
            strategy_parameters: StrategyParameters::spot_imbalanced(min_bin_id, max_bin_id),
        };

        add_liquidity_by_strategy2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_ext.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                token_x_mint,
                token_y_mint,
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                event_authority,
                dlmm_program,
            ],
            liquidity_params,
            RemainingAccountsInfo::empty_hooks(),
            signer,
            &[bin_array_lower, bin_array_upper],
        )?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.lb_pair = ctx.accounts.lb_pair.key();
        position.meteora_position = ctx.accounts.meteora_position.key();
        position.side = side;
        position.min_bin_id = min_bin_id;
        position.max_bin_id = max_bin_id;
        position.initial_amount = amount;
        position.harvested_amount = 0;
        position.created_at = Clock::get()?.unix_timestamp;
        position.bump = ctx.bumps.position;

        let vault = &mut ctx.accounts.vault;
        vault.position = ctx.accounts.meteora_position.key();
        vault.bump = ctx.bumps.vault;

        // Persist counter bump on first creation, then increment
        let counter = &mut ctx.accounts.position_counter;
        if counter.bump == 0 {
            counter.bump = ctx.bumps.position_counter;
        }
        counter.count = counter.count.checked_add(1).ok_or(CoreError::Overflow)?;

        let config = &mut ctx.accounts.config;
        config.total_positions = config.total_positions.saturating_add(1);
        config.total_volume = config.total_volume.saturating_add(amount);

        emit!(PositionOpenedEvent {
            position: ctx.accounts.position.key(),
            user: ctx.accounts.user.key(),
            lb_pair: ctx.accounts.lb_pair.key(),
            side,
            amount,
            min_bin_id,
            max_bin_id,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Position opened: {} | {} bins [{},{}] | {} lamports",
            ctx.accounts.position.key(), width, min_bin_id, max_bin_id, amount);
        Ok(())
    }

    /// Bot harvests fully-converted bins. Anti-backwash mechanic.
    pub fn harvest_bins<'info>(
        ctx: Context<'_, '_, 'info, 'info, BotHarvest<'info>>,
        bin_ids: Vec<i32>,
    ) -> Result<()> {
        // NOTE: harvest_bins is intentionally NOT gated by config.paused.
        // Paused gates open_position only. Harvests must always work to protect
        // existing positions from backwash. This is the core product promise.
        require!(!bin_ids.is_empty(), CoreError::NoBinsProvided);
        require!(bin_ids.len() <= 70, CoreError::TooManyBins);

        let x_decimals = read_mint_decimals(&ctx.accounts.token_x_mint)?;
        let y_decimals = read_mint_decimals(&ctx.accounts.token_y_mint)?;

        let position_key = ctx.accounts.position.key();
        let owner_key = ctx.accounts.owner.key();
        let side = ctx.accounts.position.side;
        let min_bin_id = ctx.accounts.position.min_bin_id;
        let max_bin_id = ctx.accounts.position.max_bin_id;
        let meteora_pos_key = ctx.accounts.position.meteora_position;

        for &bin_id in &bin_ids {
            require!(
                bin_id >= min_bin_id && bin_id <= max_bin_id,
                CoreError::BinOutOfPositionRange
            );
        }

        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[vault_seeds];

        let from_bin = *bin_ids.iter().min().ok_or(CoreError::NoBinsProvided)?;
        let to_bin = *bin_ids.iter().max().ok_or(CoreError::NoBinsProvided)?;

        // Enforce contiguous range — remove_liquidity_by_range removes ALL bins
        // between from_bin and to_bin. Non-contiguous bin_ids would remove unconverted bins.
        require!(
            (to_bin - from_bin + 1) == bin_ids.len() as i32,
            CoreError::NonContiguousBins
        );

        // --- Permissionless harvest fallback ---
        // Authorized bot: update heartbeat, full fee to protocol.
        // Permissionless: allowed only when bot is stale (priority_slots exceeded).
        let clock = Clock::get()?;
        let is_authorized_bot = ctx.accounts.bot.key() == ctx.accounts.config.bot;

        if is_authorized_bot {
            ctx.accounts.config.last_bot_harvest_slot = clock.slot;
        } else {
            // Permissionless path: bot must be stale
            let slots_since = clock.slot
                .checked_sub(ctx.accounts.config.last_bot_harvest_slot)
                .ok_or(CoreError::Overflow)?;
            require!(slots_since > ctx.accounts.config.priority_slots, CoreError::BotNotStale);
        }

        // Snapshot vault balances BEFORE CPI for delta-based fee calculation
        let x_before = ctx.accounts.vault_token_x.amount;
        let y_before = ctx.accounts.vault_token_y.amount;

        let remaining = &[
            ctx.accounts.bin_array_lower.to_account_info(),
            ctx.accounts.bin_array_upper.to_account_info(),
        ];
        remove_liquidity_by_range2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_ext.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                ctx.accounts.memo_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            from_bin,
            to_bin,
            10_000,
            RemainingAccountsInfo::none(),
            signer,
            remaining,
        )?;

        // Reload balances after CPI — use delta for fee calculation
        ctx.accounts.vault_token_x.reload()?;
        ctx.accounts.vault_token_y.reload()?;
        let x_received = ctx.accounts.vault_token_x.amount.saturating_sub(x_before);
        let y_received = ctx.accounts.vault_token_y.amount.saturating_sub(y_before);

        if x_received == 0 && y_received == 0 {
            msg!("WARNING: harvest produced 0 tokens — bins may not have been converted");
        }

        // Fee on converted output only (delta-based, not total balance)
        let fee_bps = ctx.accounts.config.fee_bps as u128;
        let (x_fee, y_fee) = match side {
            Side::Buy => {
                let f = (x_received as u128)
                    .checked_mul(fee_bps).ok_or(CoreError::Overflow)?
                    .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;
                (f, 0u64)
            }
            Side::Sell => {
                let f = (y_received as u128)
                    .checked_mul(fee_bps).ok_or(CoreError::Overflow)?
                    .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;
                (0u64, f)
            }
        };

        // --- Keeper tip (permissionless only, from converted-side fee) ---
        let (x_tip, y_tip) = if !is_authorized_bot && ctx.accounts.config.keeper_tip_bps > 0 {
            let tip_bps = ctx.accounts.config.keeper_tip_bps as u128;
            let xt = (x_fee as u128)
                .checked_mul(tip_bps).ok_or(CoreError::Overflow)?
                .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;
            let yt = (y_fee as u128)
                .checked_mul(tip_bps).ok_or(CoreError::Overflow)?
                .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;
            (xt, yt)
        } else {
            (0u64, 0u64)
        };
        let x_to_protocol = x_fee.checked_sub(x_tip).ok_or(CoreError::Overflow)?;
        let y_to_protocol = y_fee.checked_sub(y_tip).ok_or(CoreError::Overflow)?;

        // Use post-reload vault amounts (vault-as-pipe: transfer full balance minus fee)
        let x_to_owner = ctx.accounts.vault_token_x.amount.checked_sub(x_fee).ok_or(CoreError::Overflow)?;
        let y_to_owner = ctx.accounts.vault_token_y.amount.checked_sub(y_fee).ok_or(CoreError::Overflow)?;

        // Tip -> keeper (permissionless path only, via remaining_accounts[0])
        if x_tip > 0 || y_tip > 0 {
            require!(ctx.remaining_accounts.len() >= 1, CoreError::MissingKeeperAta);
            let keeper_ata_info = &ctx.remaining_accounts[0];
            require!(
                *keeper_ata_info.owner == anchor_spl::token::ID
                    || *keeper_ata_info.owner == TOKEN_2022_PROGRAM_ID,
                CoreError::MissingKeeperAta
            );
            // Prevent duplicate mutable account exploitation — keeper ATA
            // must not be the same as any fee destination or owner token account
            require!(
                keeper_ata_info.key() != ctx.accounts.rover_fee_token_y.key()
                    && keeper_ata_info.key() != ctx.accounts.rover_fee_token_x.key()
                    && keeper_ata_info.key() != ctx.accounts.owner_token_x.key()
                    && keeper_ata_info.key() != ctx.accounts.owner_token_y.key(),
                CoreError::MissingKeeperAta
            );
            // Validate keeper ATA mint matches the converted-side token.
            // Without this, a griefer can pass a wrong-mint ATA causing the entire harvest
            // to revert at the CPI level, wasting gas. This gives a clearer error earlier.
            {
                let keeper_data = keeper_ata_info.try_borrow_data()?;
                // SPL TokenAccount layout: mint is at offset 0 (32 bytes)
                require!(keeper_data.len() >= 32, CoreError::MissingKeeperAta);
                let keeper_mint = Pubkey::try_from(&keeper_data[0..32])
                    .map_err(|_| CoreError::MissingKeeperAta)?;
                if x_tip > 0 {
                    require!(keeper_mint == ctx.accounts.token_x_mint.key(), CoreError::MissingKeeperAta);
                } else {
                    require!(keeper_mint == ctx.accounts.token_y_mint.key(), CoreError::MissingKeeperAta);
                }
            }
            let keeper_ata = keeper_ata_info;
            if x_tip > 0 {
                memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_x_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.vault_token_x.to_account_info(),
                            mint: ctx.accounts.token_x_mint.to_account_info(),
                            to: keeper_ata.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        signer,
                    ),
                    x_tip,
                    x_decimals,
                )?;
            }
            if y_tip > 0 {
                memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_y_program.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.vault_token_y.to_account_info(),
                            mint: ctx.accounts.token_y_mint.to_account_info(),
                            to: keeper_ata.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        signer,
                    ),
                    y_tip,
                    y_decimals,
                )?;
            }
        }

        // Fee routing: all fees → rover_authority ATAs (sweep_rover splits 50/50: holders + bot)
        //   TOKEN fees (Buy side) → rover_fee_token_x for DLMM recycling
        //   SOL fees (Sell side)  → rover_fee_token_y (WSOL, unwrapped later via close_rover_token_account)
        if x_to_protocol > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_x_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_x.to_account_info(),
                        mint: ctx.accounts.token_x_mint.to_account_info(),
                        to: ctx.accounts.rover_fee_token_x.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                x_to_protocol,
                x_decimals,
            )?;
        }
        if y_to_protocol > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_y_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_y.to_account_info(),
                        mint: ctx.accounts.token_y_mint.to_account_info(),
                        to: ctx.accounts.rover_fee_token_y.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                y_to_protocol,
                y_decimals,
            )?;
        }

        // Remainder -> owner
        if x_to_owner > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_x_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_x.to_account_info(),
                        mint: ctx.accounts.token_x_mint.to_account_info(),
                        to: ctx.accounts.owner_token_x.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                x_to_owner,
                x_decimals,
            )?;
        }
        if y_to_owner > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_y_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_y.to_account_info(),
                        mint: ctx.accounts.token_y_mint.to_account_info(),
                        to: ctx.accounts.owner_token_y.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                y_to_owner,
                y_decimals,
            )?;
        }

        let harvested = match side {
            Side::Buy  => x_to_owner,
            Side::Sell => y_to_owner,
        };
        let fee_taken = match side {
            Side::Buy  => x_fee,
            Side::Sell => y_fee,
        };

        // Capture lb_pair before mutable borrow of position (borrow checker)
        let lb_pair_key = ctx.accounts.position.lb_pair;

        let position = &mut ctx.accounts.position;
        position.harvested_amount = position.harvested_amount
            .checked_add(harvested).ok_or(CoreError::Overflow)?;
        ctx.accounts.config.total_harvested = ctx.accounts.config.total_harvested
            .checked_add(harvested).ok_or(CoreError::Overflow)?;

        let keeper_tip_taken = match side {
            Side::Buy  => x_tip,
            Side::Sell => y_tip,
        };

        emit!(HarvestEvent {
            position: position_key,
            owner: owner_key,
            lb_pair: lb_pair_key,
            harvester: ctx.accounts.bot.key(),
            bin_ids: bin_ids.clone(),
            token_x_amount: x_to_owner,
            token_y_amount: y_to_owner,
            fee_amount: fee_taken,
            keeper_tip: keeper_tip_taken,
            total_harvested: position.harvested_amount,
        });

        msg!("Harvested bins [{},{}] | fee={} | tip={} | cumulative={}",
            from_bin, to_bin, fee_taken, keeper_tip_taken, position.harvested_amount);
        Ok(())
    }

    /// Bot closes position: remove all + claim fees + close Meteora position.
    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        // --- Permissionless close fallback (same pattern as harvest_bins) ---
        let clock = Clock::get()?;
        let is_authorized_bot = ctx.accounts.bot.key() == ctx.accounts.config.bot;

        if is_authorized_bot {
            // Bot-paused only applies to the authorized bot
            require!(!ctx.accounts.config.bot_paused, CoreError::BotPaused);
            ctx.accounts.config.last_bot_close_slot = clock.slot;
        } else {
            let slots_since = clock.slot
                .checked_sub(ctx.accounts.config.last_bot_close_slot)
                .ok_or(CoreError::Overflow)?;
            require!(slots_since > ctx.accounts.config.priority_slots, CoreError::BotNotStale);
        }

        let side = ctx.accounts.position.side;
        let min_bin_id = ctx.accounts.position.min_bin_id;
        let max_bin_id = ctx.accounts.position.max_bin_id;
        let meteora_pos_key = ctx.accounts.position.meteora_position;

        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[vault_seeds];

        // 1. Remove ALL remaining liquidity
        let remaining = &[
            ctx.accounts.bin_array_lower.to_account_info(),
            ctx.accounts.bin_array_upper.to_account_info(),
        ];
        remove_liquidity_by_range2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_ext.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                ctx.accounts.memo_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            min_bin_id,
            max_bin_id,
            10_000,
            RemainingAccountsInfo::none(),
            signer,
            remaining,
        )?;

        // 2. Claim accrued trading fees
        let remaining = &[
            ctx.accounts.bin_array_lower.to_account_info(),
            ctx.accounts.bin_array_upper.to_account_info(),
        ];
        claim_fee2(
            &[
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                ctx.accounts.memo_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            min_bin_id,
            max_bin_id,
            RemainingAccountsInfo::none(),
            signer,
            remaining,
        )?;

        // 3. Close Meteora position (rent -> bot)
        close_position2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.bot.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            signer,
        )?;

        let position_key = ctx.accounts.position.key();
        let owner_key = ctx.accounts.owner.key();

        let (x_fee, y_fee, x_out, y_out) = execute_close_transfers(
            side,
            ctx.accounts.config.fee_bps,
            &mut ctx.accounts.vault_token_x,
            &mut ctx.accounts.vault_token_y,
            &ctx.accounts.owner_token_x.to_account_info(),
            &ctx.accounts.owner_token_y.to_account_info(),
            &ctx.accounts.rover_fee_token_y.to_account_info(),
            &ctx.accounts.rover_fee_token_x.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.owner,
            &ctx.accounts.token_x_program.to_account_info(),
            &ctx.accounts.token_y_program.to_account_info(),
            &ctx.accounts.token_x_mint.to_account_info(),
            &ctx.accounts.token_y_mint.to_account_info(),
            &ctx.accounts.memo_program,
            signer,
        )?;

        let close_harvested = match side { Side::Buy => x_out, Side::Sell => y_out };
        ctx.accounts.config.total_harvested = ctx.accounts.config.total_harvested
            .checked_add(close_harvested).ok_or(CoreError::Overflow)?;

        emit!(CloseEvent {
            position: position_key,
            owner: owner_key,
            side,
            token_x_out: x_out,
            token_y_out: y_out,
            x_fee,
            y_fee,
            bot_initiated: true,
        });

        Ok(())
    }

    /// User manually closes their own position
    pub fn user_close(ctx: Context<UserClose>) -> Result<()> {
        let side = ctx.accounts.position.side;
        let min_bin_id = ctx.accounts.position.min_bin_id;
        let max_bin_id = ctx.accounts.position.max_bin_id;
        let meteora_pos_key = ctx.accounts.position.meteora_position;

        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[vault_seeds];

        // 1. Remove all liquidity
        let remaining = &[
            ctx.accounts.bin_array_lower.to_account_info(),
            ctx.accounts.bin_array_upper.to_account_info(),
        ];
        remove_liquidity_by_range2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_ext.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                ctx.accounts.memo_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            min_bin_id,
            max_bin_id,
            10_000,
            RemainingAccountsInfo::none(),
            signer,
            remaining,
        )?;

        // 2. Claim fees
        let remaining = &[
            ctx.accounts.bin_array_lower.to_account_info(),
            ctx.accounts.bin_array_upper.to_account_info(),
        ];
        claim_fee2(
            &[
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                ctx.accounts.memo_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            min_bin_id,
            max_bin_id,
            RemainingAccountsInfo::none(),
            signer,
            remaining,
        )?;

        // 3. Close Meteora position (rent -> user)
        close_position2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            signer,
        )?;

        let position_key = ctx.accounts.position.key();
        let user_key = ctx.accounts.user.key();

        let (x_fee, y_fee, x_out, y_out) = execute_close_transfers(
            side,
            ctx.accounts.config.fee_bps,
            &mut ctx.accounts.vault_token_x,
            &mut ctx.accounts.vault_token_y,
            &ctx.accounts.user_token_x.to_account_info(),
            &ctx.accounts.user_token_y.to_account_info(),
            &ctx.accounts.rover_fee_token_y.to_account_info(),
            &ctx.accounts.rover_fee_token_x.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.user.to_account_info(),
            &ctx.accounts.token_x_program.to_account_info(),
            &ctx.accounts.token_y_program.to_account_info(),
            &ctx.accounts.token_x_mint.to_account_info(),
            &ctx.accounts.token_y_mint.to_account_info(),
            &ctx.accounts.memo_program,
            signer,
        )?;

        let close_harvested = match side { Side::Buy => x_out, Side::Sell => y_out };
        ctx.accounts.config.total_harvested = ctx.accounts.config.total_harvested
            .checked_add(close_harvested).ok_or(CoreError::Overflow)?;

        emit!(CloseEvent {
            position: position_key,
            owner: user_key,
            side,
            token_x_out: x_out,
            token_y_out: y_out,
            x_fee,
            y_fee,
            bot_initiated: false,
        });

        Ok(())
    }

    /// Claim accrued Meteora LP fees -> user (no protocol fee on LP fees)
    // NOTE: claim_fees is intentionally NOT gated by config.paused.
    // Users must always be able to withdraw their accrued LP trading fees,
    // even when the protocol is paused for new deposits. Same rationale as
    // harvest_bins — existing positions must remain fully accessible.
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        let min_bin_id = ctx.accounts.position.min_bin_id;
        let max_bin_id = ctx.accounts.position.max_bin_id;
        let meteora_pos_key = ctx.accounts.position.meteora_position;

        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[vault_seeds];

        let remaining = &[
            ctx.accounts.bin_array_lower.to_account_info(),
            ctx.accounts.bin_array_upper.to_account_info(),
        ];
        claim_fee2(
            &[
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                ctx.accounts.memo_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            min_bin_id,
            max_bin_id,
            RemainingAccountsInfo::none(),
            signer,
            remaining,
        )?;

        // Transfer claimed fees directly to user (no protocol fee on LP fees)
        // Use token_x_program for X, token_y_program for Y (Token-2022 support)
        ctx.accounts.vault_token_x.reload()?;
        ctx.accounts.vault_token_y.reload()?;

        let x_decimals = read_mint_decimals(&ctx.accounts.token_x_mint)?;
        let y_decimals = read_mint_decimals(&ctx.accounts.token_y_mint)?;

        // Capture amounts BEFORE transfer for event (Anchor caches deserialized data)
        let x_claimed = ctx.accounts.vault_token_x.amount;
        let y_claimed = ctx.accounts.vault_token_y.amount;

        if ctx.accounts.vault_token_x.amount > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(CpiContext::new_with_signer(
                ctx.accounts.token_x_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_x.to_account_info(),
                    mint: ctx.accounts.token_x_mint.to_account_info(),
                    to: ctx.accounts.user_token_x.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                }, signer,
            ), ctx.accounts.vault_token_x.amount, x_decimals)?;
        }
        if ctx.accounts.vault_token_y.amount > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(CpiContext::new_with_signer(
                ctx.accounts.token_y_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_y.to_account_info(),
                    mint: ctx.accounts.token_y_mint.to_account_info(),
                    to: ctx.accounts.user_token_y.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                }, signer,
            ), ctx.accounts.vault_token_y.amount, y_decimals)?;
        }

        // Emit event using pre-transfer captured amounts (stale cache fix)
        emit!(ClaimFeesEvent {
            position: ctx.accounts.position.key(),
            user: ctx.accounts.user.key(),
            lb_pair: ctx.accounts.position.lb_pair,
            x_amount: x_claimed,
            y_amount: y_claimed,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("LP fees claimed");
        Ok(())
    }

    // ============ ADMIN ============

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.paused = false;
        Ok(())
    }

    pub fn bot_pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.bot_paused = true;
        emit!(AdminConfigEvent {
            field: "bot_paused".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Bot close paused");
        Ok(())
    }

    pub fn bot_unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.config.bot_paused = false;
        emit!(AdminConfigEvent {
            field: "bot_unpaused".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Bot close unpaused");
        Ok(())
    }

    pub fn update_bot(ctx: Context<AdminOnly>, new_bot: Pubkey) -> Result<()> {
        ctx.accounts.config.bot = new_bot;
        emit!(AdminConfigEvent {
            field: "bot".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    pub fn update_keeper_tip_bps(ctx: Context<AdminOnly>, new_bps: u16) -> Result<()> {
        require!(new_bps <= 5000, CoreError::FeeTooHigh); // cap at 50%
        ctx.accounts.config.keeper_tip_bps = new_bps;
        emit!(AdminConfigEvent {
            field: "keeper_tip_bps".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Keeper tip updated: {} bps", new_bps);
        Ok(())
    }

    // Cap priority_slots to prevent permanent disabling of permissionless fallback
    pub fn update_priority_slots(ctx: Context<AdminOnly>, new_slots: u64) -> Result<()> {
        require!(new_slots <= 9000, CoreError::PrioritySlotsExceedMax);
        ctx.accounts.config.priority_slots = new_slots;
        emit!(AdminConfigEvent {
            field: "priority_slots".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Priority slots updated: {}", new_slots);
        Ok(())
    }

    /// Fee changes use a 24-hour timelock.
    /// Step 1: propose_fee sets pending_fee_bps and fee_change_at.
    /// Step 2: apply_fee (permissionless) applies it after the delay.
    /// Users can see pending changes on-chain and close positions before they take effect.
    pub fn propose_fee(ctx: Context<AdminOnly>, new_fee_bps: u16) -> Result<()> {
        require!(new_fee_bps <= 1000, CoreError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        if config.fee_change_at > 0 {
            emit!(FeeChangeCancelledEvent {
                cancelled_fee_bps: config.pending_fee_bps,
                was_effective_at: config.fee_change_at,
            });
        }
        config.pending_fee_bps = new_fee_bps;
        config.fee_change_at = Clock::get()?.unix_timestamp
            .checked_add(86_400) // 24 hours
            .ok_or(CoreError::Overflow)?;
        msg!("Fee change proposed: {} bps, effective at {}", new_fee_bps, config.fee_change_at);
        emit!(FeeChangeProposedEvent {
            new_fee_bps,
            effective_at: config.fee_change_at,
        });
        Ok(())
    }

    /// Step 2: Apply a previously proposed fee change. Permissionless — anyone can call
    /// once the timelock has expired. This ensures the change happens on schedule.
    pub fn apply_fee(ctx: Context<ApplyFee>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.fee_change_at > 0, CoreError::NoPendingFeeChange);
        require!(
            Clock::get()?.unix_timestamp >= config.fee_change_at,
            CoreError::FeeTimelockNotExpired
        );
        let old_fee = config.fee_bps;
        config.fee_bps = config.pending_fee_bps;
        config.pending_fee_bps = 0;
        config.fee_change_at = 0;
        msg!("Fee applied: {} bps → {} bps", old_fee, config.fee_bps);
        emit!(FeeAppliedEvent {
            old_fee_bps: old_fee,
            new_fee_bps: config.fee_bps,
        });
        Ok(())
    }

    pub fn cancel_pending_fee(ctx: Context<AdminOnly>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.fee_change_at > 0, CoreError::NoPendingFeeChange);
        config.pending_fee_bps = 0;
        config.fee_change_at = 0;
        msg!("Pending fee change cancelled");
        Ok(())
    }

    pub fn transfer_authority(ctx: Context<AdminOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_authority = new_authority;
        msg!("Authority transfer proposed to {}", new_authority);
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = config.pending_authority;
        config.pending_authority = Pubkey::default();
        msg!("Authority accepted");
        Ok(())
    }

    /// Propose emergency close of ANY position (user or rover). 24hr timelock.
    /// For when Meteora deprecates a pool and normal close_position CPI fails.
    /// NOTE: This can target user positions too — intentional for stuck positions
    /// on deprecated pools. The 24hr timelock gives users time to see and react.
    pub fn propose_emergency_close(ctx: Context<AdminOnly>, position_key: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.pending_emergency_close = position_key;
        config.emergency_close_at = Clock::get()?.unix_timestamp
            .checked_add(86_400).ok_or(CoreError::Overflow)?;
        msg!("Emergency close proposed for position {}, effective at {}", position_key, config.emergency_close_at);
        Ok(())
    }

    /// Apply emergency close after 24hr timelock. Permissionless.
    /// Closes the Position + Vault PDAs without Meteora CPI.
    /// Any remaining vault tokens are transferred to the position owner.
    pub fn apply_emergency_close(ctx: Context<ApplyEmergencyClose>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.emergency_close_at > 0, CoreError::NoPendingEmergencyClose);
        require!(
            Clock::get()?.unix_timestamp >= config.emergency_close_at,
            CoreError::EmergencyCloseTimelockNotExpired
        );

        // Transfer any remaining vault tokens to position owner before closing PDAs.
        // This resolves the deadlock where Meteora CPI is broken on deprecated pools
        // but the vault still holds the user's tokens.
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            ctx.accounts.vault.position.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[vault_seeds];

        let x_decimals = read_mint_decimals(&ctx.accounts.token_x_mint)?;
        let y_decimals = read_mint_decimals(&ctx.accounts.token_y_mint)?;

        let x_amount = ctx.accounts.vault_token_x.amount;
        if x_amount > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(CpiContext::new_with_signer(
                ctx.accounts.token_x_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_x.to_account_info(),
                    mint: ctx.accounts.token_x_mint.to_account_info(),
                    to: ctx.accounts.owner_token_x.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                }, signer,
            ), x_amount, x_decimals)?;
        }

        let y_amount = ctx.accounts.vault_token_y.amount;
        if y_amount > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(CpiContext::new_with_signer(
                ctx.accounts.token_y_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_y.to_account_info(),
                    mint: ctx.accounts.token_y_mint.to_account_info(),
                    to: ctx.accounts.owner_token_y.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                }, signer,
            ), y_amount, y_decimals)?;
        }

        // Clear pending state
        config.pending_emergency_close = Pubkey::default();
        config.emergency_close_at = 0;

        // Position + Vault are closed by Anchor `close` constraints on the context
        emit!(EmergencyCloseEvent {
            position: ctx.accounts.position.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Emergency close executed: x_returned={} y_returned={}", x_amount, y_amount);
        Ok(())
    }

    // Timelocked propose/apply pattern for revenue_dest
    pub fn propose_revenue_dest(
        ctx: Context<UpdateRoverDistPool>,
        new_revenue_dest: Pubkey,
    ) -> Result<()> {
        require!(new_revenue_dest != Pubkey::default(), CoreError::InvalidDistPool);
        let rover = &mut ctx.accounts.rover_authority;
        rover.pending_revenue_dest = new_revenue_dest;
        rover.revenue_dest_change_at = Clock::get()?.unix_timestamp
            .checked_add(86_400).ok_or(CoreError::Overflow)?;
        msg!("Revenue dest change proposed: {}, effective at {}", new_revenue_dest, rover.revenue_dest_change_at);
        emit!(AdminConfigEvent {
            field: "revenue_dest".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Apply a previously proposed revenue_dest change. Permissionless after 24hr.
    pub fn apply_revenue_dest(ctx: Context<ApplyRevenueDest>) -> Result<()> {
        let rover = &mut ctx.accounts.rover_authority;
        require!(rover.revenue_dest_change_at > 0, CoreError::NoPendingFeeChange);
        require!(
            Clock::get()?.unix_timestamp >= rover.revenue_dest_change_at,
            CoreError::FeeTimelockNotExpired
        );
        rover.revenue_dest = rover.pending_revenue_dest;
        rover.pending_revenue_dest = Pubkey::default();
        rover.revenue_dest_change_at = 0;
        msg!("Revenue dest applied: {}", rover.revenue_dest);
        Ok(())
    }

    /// Cancel a pending revenue_dest change. Admin only.
    pub fn cancel_pending_revenue_dest(ctx: Context<UpdateRoverDistPool>) -> Result<()> {
        let rover = &mut ctx.accounts.rover_authority;
        require!(rover.revenue_dest_change_at > 0, CoreError::NoPendingFeeChange);
        rover.pending_revenue_dest = Pubkey::default();
        rover.revenue_dest_change_at = 0;
        msg!("Pending revenue dest change cancelled");
        Ok(())
    }

    // ============ ROVER (bribe positions) ============

    /// Initialize the rover authority PDA. Admin only. Called once.
    /// The rover_authority PDA owns rover positions. Harvest proceeds
    /// accumulate in its ATAs, then sweep_rover moves SOL to dist_pool.
    pub fn initialize_rover(
        ctx: Context<InitializeRover>,
        revenue_dest: Pubkey,
    ) -> Result<()> {
        require!(revenue_dest != Pubkey::default(), CoreError::InvalidDistPool);
        let rover = &mut ctx.accounts.rover_authority;
        rover.revenue_dest = revenue_dest;
        rover.bump = ctx.bumps.rover_authority;
        rover.total_rover_positions = 0;
        rover.pending_revenue_dest = Pubkey::default();
        rover.revenue_dest_change_at = 0;
        rover._reserved = [0u8; 64];

        msg!("Rover authority initialized. revenue_dest={}", revenue_dest);
        Ok(())
    }

    /// Anyone deposits tokens into a sell-side DLMM position owned by rover_authority.
    /// The harvest bot liquidates these like normal positions. SOL accumulates in
    /// rover_authority ATAs. sweep_rover sends it to dist_pool for all monke holders.
    /// This IS the bribe mechanism — rover TVL ranks pools in the frontend.
    ///
    /// Range is hardcoded to 2x current price (or MAX_POSITION_WIDTH bins, whichever
    /// is smaller). The depositor only chooses how many tokens to put in.
    /// Bins are placed from active_id+1 upward (sell side, above current price).
    pub fn open_rover_position<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenRoverPosition<'info>>,
        amount: u64,
        bin_step: u16,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CoreError::Paused);
        require!(amount > 0, CoreError::ZeroAmount);
        require!(amount >= MIN_ROVER_DEPOSIT, CoreError::RoverDepositTooSmall);
        require!(bin_step >= MIN_ROVER_BIN_STEP, CoreError::RoverBinStepTooSmall);

        // Validate token account owners
        {
            let data = ctx.accounts.depositor_token_account.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.depositor.key(), CoreError::InvalidTokenOwner);
        }
        {
            let data = ctx.accounts.vault_token_x.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.vault.key(), CoreError::InvalidTokenOwner);
        }

        // C1: Read active_id from on-chain lb_pair — never trust the caller
        let active_id = {
            let data = ctx.accounts.lb_pair.try_borrow_data()?;
            // Validate data length before byte slice (prevents panic on malformed accounts)
            require!(data.len() >= 80, CoreError::InvalidPool);
            i32::from_le_bytes(data[76..80].try_into().map_err(|_| CoreError::Overflow)?)
        };
        require!(active_id > -443636 && active_id < 443636, CoreError::InvalidBinRange);

        // Overflow accounts: event_authority, dlmm_program
        require!(ctx.remaining_accounts.len() >= 2, CoreError::NoBinsProvided);
        let event_authority = ctx.remaining_accounts[0].to_account_info();
        let dlmm_program = ctx.remaining_accounts[1].to_account_info();
        require!(dlmm_program.key() == METEORA_DLMM_PROGRAM_ID, CoreError::InvalidProgram);

        // Compute 2x range: ln(2)/ln(1+binStep/10000) ≈ 6931/binStep bins
        // Capped at MAX_POSITION_WIDTH (70 bins)
        let bins_for_2x = 6931_i32 / (bin_step as i32);
        let width = if bins_for_2x < 1 { 1 } else if bins_for_2x > MAX_POSITION_WIDTH { MAX_POSITION_WIDTH } else { bins_for_2x };
        let min_bin_id = active_id + 1; // sell side: just above current price
        let max_bin_id = min_bin_id + width - 1;
        let max_active_bin_slippage = 10; // hardcoded for rovers

        // Transfer deposit tokens from caller to vault
        {
            let transfer_ix = anchor_lang::solana_program::instruction::Instruction {
                program_id: *ctx.accounts.token_x_program.key,
                accounts: vec![
                    anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.depositor_token_account.key(), false),
                    anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.vault_token_x.key(), false),
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.depositor.key(), true),
                ],
                data: {
                    let mut d = vec![3u8];
                    d.extend_from_slice(&amount.to_le_bytes());
                    d
                },
            };
            anchor_lang::solana_program::program::invoke(
                &transfer_ix,
                &[
                    ctx.accounts.depositor_token_account.to_account_info(),
                    ctx.accounts.vault_token_x.to_account_info(),
                    ctx.accounts.depositor.to_account_info(),
                    ctx.accounts.token_x_program.to_account_info(),
                ],
            )?;
        }

        // Vault PDA signs Meteora CPIs
        let meteora_pos_key = ctx.accounts.meteora_position.key();
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer = &[vault_seeds];

        // Initialize Meteora position (vault PDA = owner)
        initialize_position2(
            &[
                ctx.accounts.depositor.to_account_info(),
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                event_authority.clone(),
                dlmm_program.clone(),
            ],
            min_bin_id,
            width,
            signer,
        )?;

        // Add sell-side liquidity with BidAsk distribution via V2 two-sided CPI
        // (amount_y = 0 makes it effectively one-sided)
        let liquidity_params = LiquidityParameterByStrategy {
            amount_x: amount,
            amount_y: 0,
            active_id,
            max_active_bin_slippage,
            strategy_parameters: StrategyParameters::bid_ask_imbalanced(min_bin_id, max_bin_id),
        };

        add_liquidity_by_strategy2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_ext.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                event_authority,
                dlmm_program,
            ],
            liquidity_params,
            RemainingAccountsInfo::empty_hooks(),
            signer,
            &[ctx.accounts.bin_array_lower.to_account_info(), ctx.accounts.bin_array_upper.to_account_info()],
        )?;

        // Capture keys before mutable borrows
        let position_key = ctx.accounts.position.key();
        let depositor_key = ctx.accounts.depositor.key();
        let lb_pair_key = ctx.accounts.lb_pair.key();
        let rover_key = ctx.accounts.rover_authority.key();
        let meteora_pos_key2 = ctx.accounts.meteora_position.key();
        let created_at = Clock::get()?.unix_timestamp;

        // Store position metadata — owner is rover_authority, side is always Sell
        let position = &mut ctx.accounts.position;
        position.owner = rover_key;
        position.lb_pair = lb_pair_key;
        position.meteora_position = meteora_pos_key2;
        position.side = Side::Sell;
        position.min_bin_id = min_bin_id;
        position.max_bin_id = max_bin_id;
        position.initial_amount = amount;
        position.harvested_amount = 0;
        position.created_at = created_at;
        position.bump = ctx.bumps.position;

        let vault = &mut ctx.accounts.vault;
        vault.position = ctx.accounts.meteora_position.key();
        vault.bump = ctx.bumps.vault;

        let config = &mut ctx.accounts.config;
        config.total_positions = config.total_positions.saturating_add(1);
        config.total_volume = config.total_volume.saturating_add(amount);

        let rover = &mut ctx.accounts.rover_authority;
        rover.total_rover_positions = rover.total_rover_positions.saturating_add(1);

        emit!(RoverOpenedEvent {
            depositor: depositor_key,
            lb_pair: lb_pair_key,
            position: position_key,
            token_mint: ctx.accounts.token_x_mint.key(),
            amount,
            active_id,
            bin_step,
            min_bin_id,
            max_bin_id,
            timestamp: created_at,
        });

        msg!("Rover position opened: {} bins [{},{}] amount={}",
            width, min_bin_id, max_bin_id, amount);
        Ok(())
    }

    /// Sweep SOL from rover_authority — 50% to bridge_vault (holders), 50% to bot (operations).
    /// Hardcoded split. Permissionless — anyone can call.
    pub fn sweep_rover(ctx: Context<SweepRover>) -> Result<()> {
        let is_authorized_bot = ctx.accounts.caller.key() == ctx.accounts.config.bot;
        if is_authorized_bot {
            ctx.accounts.config.last_bot_sweep_slot = Clock::get()?.slot;
        }

        let rover_lamports = ctx.accounts.rover_authority.to_account_info().lamports();
        let rent = Rent::get()?.minimum_balance(RoverAuthority::SIZE);
        let sweepable = rover_lamports.saturating_sub(rent);

        require!(sweepable > 0, CoreError::NothingToSweep);

        let holder_share = sweepable / 2;       // 50%
        let operator_share = sweepable - holder_share; // 50%

        **ctx.accounts.rover_authority.to_account_info().try_borrow_mut_lamports()? -= sweepable;
        **ctx.accounts.revenue_dest.try_borrow_mut_lamports()? += holder_share;
        **ctx.accounts.bot_dest.try_borrow_mut_lamports()? += operator_share;

        emit!(RoverSweptEvent {
            amount: sweepable,
            monke_share: holder_share,
            operator_share,
            dist_pool: ctx.accounts.revenue_dest.key(),
            bot: ctx.accounts.bot_dest.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Swept {} lamports — {} to dist_pool, {} to bot", sweepable, holder_share, operator_share);
        Ok(())
    }

    /// Close a token account owned by rover_authority. Permissionless.
    /// For WSOL: unwraps WSOL balance to native SOL on rover_authority (picked up by sweep_rover).
    /// For empty ATAs: reclaims rent to rover_authority.
    /// Destination is always rover_authority itself — lamports cannot be extracted.
    pub fn close_rover_token_account(ctx: Context<CloseRoverTokenAccount>) -> Result<()> {
        let signer_seeds: &[&[u8]] = &[b"rover_authority", &[ctx.accounts.rover_authority.bump]];
        let signer = &[signer_seeds];

        anchor_spl::token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::CloseAccount {
                account: ctx.accounts.token_account.to_account_info(),
                destination: ctx.accounts.rover_authority.to_account_info(),
                authority: ctx.accounts.rover_authority.to_account_info(),
            },
            signer,
        ))?;

        msg!("Closed rover token account: {}", ctx.accounts.token_account.key());
        Ok(())
    }

    /// Open a fee rover position from accumulated token fees in rover_authority ATA.
    /// Bot-gated. Uses BidAskOneSide distribution (more tokens at higher bins).
    /// Bot pays rent for Position + Vault PDAs (refunded on close).
    pub fn open_fee_rover<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenFeeRover<'info>>,
        amount: u64,
        bin_step: u16,
    ) -> Result<()> {
        require!(amount > 0, CoreError::ZeroAmount);
        require!(bin_step >= MIN_ROVER_BIN_STEP, CoreError::RoverBinStepTooSmall);

        // Validate vault_token_x owner
        {
            let data = ctx.accounts.vault_token_x.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.vault.key(), CoreError::InvalidTokenOwner);
        }

        // C1: Read active_id from on-chain lb_pair — never trust the caller
        let active_id = {
            let data = ctx.accounts.lb_pair.try_borrow_data()?;
            // Validate data length before byte slice (prevents panic on malformed accounts)
            require!(data.len() >= 80, CoreError::InvalidPool);
            i32::from_le_bytes(data[76..80].try_into().map_err(|_| CoreError::Overflow)?)
        };
        require!(active_id > -443636 && active_id < 443636, CoreError::InvalidBinRange);

        // Overflow accounts: event_authority, dlmm_program
        require!(ctx.remaining_accounts.len() >= 2, CoreError::NoBinsProvided);
        let event_authority = ctx.remaining_accounts[0].to_account_info();
        let dlmm_program = ctx.remaining_accounts[1].to_account_info();
        require!(dlmm_program.key() == METEORA_DLMM_PROGRAM_ID, CoreError::InvalidProgram);

        // Same range as external rovers: active_id+1 to +70 max
        let min_bin_id = active_id.checked_add(1).ok_or(CoreError::Overflow)?;
        let width = core::cmp::min(70_i32, core::cmp::max(1_i32, 6931_i32 / (bin_step as i32)));
        let max_bin_id = min_bin_id.checked_add(width).ok_or(CoreError::Overflow)?
            .checked_sub(1).ok_or(CoreError::Overflow)?;
        let max_active_bin_slippage = 10;

        // Transfer from rover_authority ATA to vault ATA (rover_authority PDA signs)
        let rover_signer_seeds: &[&[u8]] = &[b"rover_authority", &[ctx.accounts.rover_authority.bump]];
        let rover_signer = &[rover_signer_seeds];

        {
            let transfer_ix = anchor_lang::solana_program::instruction::Instruction {
                program_id: *ctx.accounts.token_x_program.key,
                accounts: vec![
                    anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.rover_token_account.key(), false),
                    anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.vault_token_x.key(), false),
                    anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.rover_authority.key(), true),
                ],
                data: {
                    let mut d = vec![3u8];
                    d.extend_from_slice(&amount.to_le_bytes());
                    d
                },
            };
            anchor_lang::solana_program::program::invoke_signed(
                &transfer_ix,
                &[
                    ctx.accounts.rover_token_account.to_account_info(),
                    ctx.accounts.vault_token_x.to_account_info(),
                    ctx.accounts.rover_authority.to_account_info(),
                    ctx.accounts.token_x_program.to_account_info(),
                ],
                rover_signer,
            )?;
        }

        // Vault PDA signs Meteora CPIs
        let meteora_pos_key = ctx.accounts.meteora_position.key();
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer = &[vault_seeds];

        // Initialize Meteora position (vault PDA = owner)
        initialize_position2(
            &[
                ctx.accounts.bot.to_account_info(),
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                event_authority.clone(),
                dlmm_program.clone(),
            ],
            min_bin_id,
            width,
            signer,
        )?;

        // Add sell-side liquidity with BidAsk distribution via V2 two-sided CPI
        let liquidity_params = LiquidityParameterByStrategy {
            amount_x: amount,
            amount_y: 0,
            active_id,
            max_active_bin_slippage,
            strategy_parameters: StrategyParameters::bid_ask_imbalanced(min_bin_id, max_bin_id),
        };

        add_liquidity_by_strategy2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_bitmap_ext.to_account_info(),
                ctx.accounts.vault_token_x.to_account_info(),
                ctx.accounts.vault_token_y.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.token_x_program.to_account_info(),
                ctx.accounts.token_y_program.to_account_info(),
                event_authority,
                dlmm_program,
            ],
            liquidity_params,
            RemainingAccountsInfo::empty_hooks(),
            signer,
            &[ctx.accounts.bin_array_lower.to_account_info(), ctx.accounts.bin_array_upper.to_account_info()],
        )?;

        // Store position metadata — owner is rover_authority, side is always Sell
        let position_key = ctx.accounts.position.key();
        let rover_key = ctx.accounts.rover_authority.key();
        let lb_pair_key = ctx.accounts.lb_pair.key();
        let created_at = Clock::get()?.unix_timestamp;

        let position = &mut ctx.accounts.position;
        position.owner = rover_key;
        position.lb_pair = lb_pair_key;
        position.meteora_position = ctx.accounts.meteora_position.key();
        position.side = Side::Sell;
        position.min_bin_id = min_bin_id;
        position.max_bin_id = max_bin_id;
        position.initial_amount = amount;
        position.harvested_amount = 0;
        position.created_at = created_at;
        position.bump = ctx.bumps.position;

        let vault = &mut ctx.accounts.vault;
        vault.position = ctx.accounts.meteora_position.key();
        vault.bump = ctx.bumps.vault;

        let config = &mut ctx.accounts.config;
        config.total_positions = config.total_positions.saturating_add(1);
        config.total_volume = config.total_volume.saturating_add(amount);

        let rover = &mut ctx.accounts.rover_authority;
        rover.total_rover_positions = rover.total_rover_positions.saturating_add(1);

        emit!(RoverOpenedEvent {
            depositor: ctx.accounts.bot.key(),
            lb_pair: lb_pair_key,
            position: position_key,
            token_mint: ctx.accounts.token_x_mint.key(),
            amount,
            active_id,
            bin_step,
            min_bin_id,
            max_bin_id,
            timestamp: created_at,
        });

        msg!("Fee rover opened: {} bins [{},{}] amount={}", width, min_bin_id, max_bin_id, amount);
        Ok(())
    }
}

/// Prepend a memo CPI before token transfers. Satisfies the Memo Transfer extension
/// on Token-2022 token accounts that require a memo on every incoming transfer.
/// ~5,000 CU per call. The vault PDA signs as the transfer authority.
fn memo_cpi<'info>(
    memo_program: &AccountInfo<'info>,
    signer_account: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    solana_program::program::invoke_signed(
        &solana_program::instruction::Instruction {
            program_id: *memo_program.key,
            accounts: vec![solana_program::instruction::AccountMeta::new_readonly(
                *signer_account.key, true,
            )],
            data: b"monke".to_vec(),
        },
        &[signer_account.clone(), memo_program.clone()],
        signer_seeds,
    )?;
    Ok(())
}

/// Shared fee calc + transfer logic for close_position and user_close.
/// Uses separate token_x_program/token_y_program for Token-2022 support.
fn read_mint_decimals(mint_info: &AccountInfo) -> Result<u8> {
    let data = mint_info.try_borrow_data()?;
    require!(data.len() >= 45, CoreError::InvalidMintData);
    Ok(data[44])
}

/// Zeros vault lamports entirely (garbage-collected at end of tx).
/// Returns (x_fee, y_fee, x_to_recipient, y_to_recipient) for event emission.
///
/// NOTE: The 0.3% performance fee is charged on the FULL vault balance
/// after both remove_all_liquidity and claim_fee CPIs. This means accrued LP trading
/// fees are included in the fee base on close. This is an intentional simplification —
/// LP fees are typically <1% of position value. Users who want fee-free LP fee
/// withdrawal should call `claim_fees` before closing their position.
fn execute_close_transfers<'info>(
    side: Side,
    fee_bps: u16,
    vault_token_x: &mut InterfaceAccount<'info, ITokenAccount>,
    vault_token_y: &mut InterfaceAccount<'info, ITokenAccount>,
    recipient_token_x: &AccountInfo<'info>,
    recipient_token_y: &AccountInfo<'info>,
    rover_fee_token_y: &AccountInfo<'info>,
    rover_fee_token_x: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    _recipient: &AccountInfo<'info>,
    token_x_program: &AccountInfo<'info>,
    token_y_program: &AccountInfo<'info>,
    token_x_mint: &AccountInfo<'info>,
    token_y_mint: &AccountInfo<'info>,
    memo_program: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
) -> Result<(u64, u64, u64, u64)> {
    vault_token_x.reload()?;
    vault_token_y.reload()?;
    let vault_x_balance = vault_token_x.amount;
    let vault_y_balance = vault_token_y.amount;
    let fee = fee_bps as u128;

    let x_decimals = read_mint_decimals(token_x_mint)?;
    let y_decimals = read_mint_decimals(token_y_mint)?;

    let (x_fee, y_fee) = match side {
        Side::Buy => {
            let f = (vault_x_balance as u128)
                .checked_mul(fee).ok_or(CoreError::Overflow)?
                .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;
            (f, 0u64)
        }
        Side::Sell => {
            let f = (vault_y_balance as u128)
                .checked_mul(fee).ok_or(CoreError::Overflow)?
                .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;
            (0u64, f)
        }
    };

    let x_to_recipient = vault_x_balance.checked_sub(x_fee).ok_or(CoreError::Overflow)?;
    let y_to_recipient = vault_y_balance.checked_sub(y_fee).ok_or(CoreError::Overflow)?;

    // Fee routing: all fees → rover_authority ATAs (sweep_rover splits 50/50: holders + bot)
    //   TOKEN fees (Buy side, x_fee) → rover_fee_token_x for DLMM recycling
    //   SOL fees (Sell side, y_fee)  → rover_fee_token_y (WSOL, unwrapped later)
    // B2 FIX: Prepend memo before each transfer (supports Memo Transfer extension)
    if x_fee > 0 {
        memo_cpi(memo_program, vault, signer)?;
        transfer_checked(CpiContext::new_with_signer(
            token_x_program.to_account_info(),
            TransferChecked {
                from: vault_token_x.to_account_info(),
                mint: token_x_mint.to_account_info(),
                to: rover_fee_token_x.to_account_info(),
                authority: vault.to_account_info(),
            }, signer,
        ), x_fee, x_decimals)?;
    }
    if y_fee > 0 {
        memo_cpi(memo_program, vault, signer)?;
        transfer_checked(CpiContext::new_with_signer(
            token_y_program.to_account_info(),
            TransferChecked {
                from: vault_token_y.to_account_info(),
                mint: token_y_mint.to_account_info(),
                to: rover_fee_token_y.to_account_info(),
                authority: vault.to_account_info(),
            }, signer,
        ), y_fee, y_decimals)?;
    }
    if x_to_recipient > 0 {
        memo_cpi(memo_program, vault, signer)?;
        transfer_checked(CpiContext::new_with_signer(
            token_x_program.to_account_info(),
            TransferChecked {
                from: vault_token_x.to_account_info(),
                mint: token_x_mint.to_account_info(),
                to: recipient_token_x.to_account_info(),
                authority: vault.to_account_info(),
            }, signer,
        ), x_to_recipient, x_decimals)?;
    }
    if y_to_recipient > 0 {
        memo_cpi(memo_program, vault, signer)?;
        transfer_checked(CpiContext::new_with_signer(
            token_y_program.to_account_info(),
            TransferChecked {
                from: vault_token_y.to_account_info(),
                mint: token_y_mint.to_account_info(),
                to: recipient_token_y.to_account_info(),
                authority: vault.to_account_info(),
            }, signer,
        ), y_to_recipient, y_decimals)?;
    }

    // Vault lamports handled by Anchor `close` constraint on the context
    // (close = owner in ClosePosition, close = user in UserClose).

    msg!("Position closed | x_fee={} y_fee={} x_out={} y_out={}",
        x_fee, y_fee, x_to_recipient, y_to_recipient);
    Ok((x_fee, y_fee, x_to_recipient, y_to_recipient))
}

// ============ ENUMS ============

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Buy,
    Sell,
}

// ============ EVENTS ============

#[event]
pub struct PositionOpenedEvent {
    pub position: Pubkey,
    pub user: Pubkey,
    pub lb_pair: Pubkey,
    pub side: Side,
    pub amount: u64,
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    pub timestamp: i64,
}

#[event]
pub struct HarvestEvent {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub lb_pair: Pubkey,       // Pool address for indexers
    pub harvester: Pubkey,     // Who called harvest (bot key or permissionless keeper)
    pub bin_ids: Vec<i32>,
    pub token_x_amount: u64,
    pub token_y_amount: u64,
    pub fee_amount: u64,
    pub keeper_tip: u64,       // Tip paid to permissionless harvester (0 if authorized bot)
    pub total_harvested: u64,
}

#[event]
pub struct ClaimFeesEvent {
    pub position: Pubkey,
    pub user: Pubkey,
    pub lb_pair: Pubkey,
    pub x_amount: u64,
    pub y_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct CloseEvent {
    pub position: Pubkey,
    pub owner: Pubkey,
    pub side: Side,
    pub token_x_out: u64,
    pub token_y_out: u64,
    pub x_fee: u64,
    pub y_fee: u64,
    pub bot_initiated: bool,
}

#[event]
pub struct FeeChangeProposedEvent {
    pub new_fee_bps: u16,
    pub effective_at: i64,
}

#[event]
pub struct FeeAppliedEvent {
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
}

#[event]
pub struct FeeChangeCancelledEvent {
    pub cancelled_fee_bps: u16,
    pub was_effective_at: i64,
}

#[event]
pub struct EmergencyCloseEvent {
    pub position: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct AdminConfigEvent {
    pub field: String,
    pub authority: Pubkey,
    pub timestamp: i64,
}

// ============ STATE ============

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub bot: Pubkey,
    pub fee_bps: u16,
    pub pending_fee_bps: u16,    // Timelock — proposed fee (0 = none pending)
    pub fee_change_at: i64,      // Timelock — Unix timestamp when pending fee can be applied (0 = none)
    pub total_positions: u64,
    pub total_volume: u64,
    pub paused: bool,
    pub bot_paused: bool,
    pub bump: u8,
    // --- Permissionless harvest fallback ---
    pub last_bot_harvest_slot: u64, // Slot of last authorized bot harvest (heartbeat)
    pub keeper_tip_bps: u16,        // Tip % for permissionless harvesters (e.g. 1000 = 10%)
    pub priority_slots: u64,        // Staleness threshold (~100 slots = ~40s)
    pub total_harvested: u64,       // Lifetime harvested output across all positions
    // --- Emergency escape hatch ---
    pub pending_emergency_close: Pubkey, // Position key pending emergency close (default = none)
    pub emergency_close_at: i64,         // Timestamp when emergency close can execute (0 = none)
    // --- Permissionless close + sweep heartbeat ---
    pub last_bot_close_slot: u64,        // Slot of last bot-initiated close_position
    pub last_bot_sweep_slot: u64,        // Slot of last bot-initiated sweep_rover
    // Reserved space for future fields (e.g. strategy platform)
    pub _reserved: [u8; 96],
}

impl Config {
    // 8 (disc) + 32*3 (authority, pending_authority, bot) + 2+2+8 (fee_bps, pending, change_at)
    // + 8+8 (positions, volume) + 1+1+1 (paused, bot_paused, bump)
    // + 8+2+8+8 (harvest slot, keeper_tip, priority, harvested)
    // + 32+8 (emergency close) + 8+8 (close/sweep slots) + 96 (reserved)
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 2 + 8 + 8 + 32 + 8 + 8 + 8 + 96;
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub lb_pair: Pubkey,
    pub meteora_position: Pubkey,
    pub side: Side,
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    pub initial_amount: u64,
    pub harvested_amount: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl Position {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 1 + 4 + 4 + 8 + 8 + 8 + 1;
}

#[account]
pub struct Vault {
    pub position: Pubkey,  // meteora_position this vault is bound to (1:1)
    pub bump: u8,
}

impl Vault {
    pub const SIZE: usize = 8 + 32 + 1;
}

/// Per-user-per-pool counter for deterministic meteora position PDA derivation.
/// Enables multiple positions per pool without requiring a keypair signer.
#[account]
pub struct PositionCounter {
    pub count: u64,
    pub bump: u8,
}

impl PositionCounter {
    pub const SIZE: usize = 8 + 8 + 1;
}

/// Rover authority PDA — owns rover (bribe) positions.
/// Harvest proceeds accumulate here. sweep_rover splits SOL 50/50: 50% to revenue_dest (bridge_vault), 50% to Config.bot.
#[account]
pub struct RoverAuthority {
    pub revenue_dest: Pubkey,              // Where holder share goes (bridge_vault PDA — 50% of swept SOL)
    pub total_rover_positions: u64,        // Lifetime count
    pub bump: u8,
    pub pending_revenue_dest: Pubkey,      // Timelocked: proposed new revenue_dest
    pub revenue_dest_change_at: i64,       // Timelocked: timestamp when pending can be applied (0 = none)
    // Reserved space for future fields (avoids account reallocation post-deploy)
    pub _reserved: [u8; 64],
}

impl RoverAuthority {
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 32 + 8 + 64;
}

// ============ CONTEXTS ============

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Config::SIZE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

/// Token-2022 compatible open_position. All CPI via V2 variants.
/// Single-signer: meteora_position is a PDA (signed via invoke_signed), not a keypair.
#[derive(Accounts)]
#[instruction(amount: u64, min_bin_id: i32, max_bin_id: i32, side: Side)]
pub struct OpenPositionV2<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: Validated by Meteora CPI
    #[account(mut)]
    pub lb_pair: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = PositionCounter::SIZE,
        seeds = [b"pos_counter", user.key().as_ref(), lb_pair.key().as_ref()],
        bump
    )]
    pub position_counter: Account<'info, PositionCounter>,

    /// CHECK: PDA signed via invoke_signed — replaces the old keypair Signer
    #[account(
        mut,
        seeds = [b"meteora_pos", user.key().as_ref(), lb_pair.key().as_ref(), &position_counter.count.to_le_bytes()],
        bump
    )]
    pub meteora_position: UncheckedAccount<'info>,

    /// CHECK: Bitmap extension (pass DLMM program ID if none).
    pub bin_array_bitmap_ext: AccountInfo<'info>,

    /// CHECK: Pool reserve X
    #[account(mut)]
    pub reserve_x: AccountInfo<'info>,

    /// CHECK: Pool reserve Y
    #[account(mut)]
    pub reserve_y: AccountInfo<'info>,

    #[account(
        init,
        payer = user,
        space = Position::SIZE,
        seeds = [b"position", meteora_position.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init,
        payer = user,
        space = Vault::SIZE,
        seeds = [b"vault", meteora_position.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: User's deposit token account (Token-2022 compatible). Validated in handler.
    #[account(mut)]
    pub user_token_account: AccountInfo<'info>,

    /// CHECK: Vault's token X account. Validated in handler.
    #[account(mut)]
    pub vault_token_x: AccountInfo<'info>,

    /// CHECK: Vault's token Y account. Validated in handler.
    #[account(mut)]
    pub vault_token_y: AccountInfo<'info>,

    /// CHECK: Token X program — SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,

    /// CHECK: Token Y program — SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Bin array lower — Meteora validates via CPI
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: Bin array upper — Meteora validates via CPI
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: Meteora event authority — validated by Meteora CPI
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora DLMM program — validated in handler body
    pub dlmm_program: UncheckedAccount<'info>,

    /// CHECK: Token X mint — passed through to Meteora CPI
    pub token_x_mint: UncheckedAccount<'info>,

    /// CHECK: Token Y mint — passed through to Meteora CPI
    pub token_y_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub bot: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        close = owner
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = owner,
        seeds = [b"vault", position.meteora_position.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: Position owner
    #[account(mut, constraint = owner.key() == position.owner @ CoreError::Unauthorized)]
    pub owner: AccountInfo<'info>,

    // --- Meteora ---

    /// CHECK: Meteora position
    #[account(mut, constraint = meteora_position.key() == position.meteora_position @ CoreError::InvalidPosition)]
    pub meteora_position: AccountInfo<'info>,

    /// CHECK: DLMM pool
    #[account(mut, constraint = lb_pair.key() == position.lb_pair @ CoreError::InvalidPool)]
    pub lb_pair: AccountInfo<'info>,

    /// CHECK: Bitmap ext — writable only when real account exists
    pub bin_array_bitmap_ext: AccountInfo<'info>,

    /// CHECK: Bin array lower
    #[account(mut)]
    pub bin_array_lower: AccountInfo<'info>,

    /// CHECK: Bin array upper
    #[account(mut)]
    pub bin_array_upper: AccountInfo<'info>,

    /// CHECK: Reserve X
    #[account(mut)]
    pub reserve_x: AccountInfo<'info>,

    /// CHECK: Reserve Y
    #[account(mut)]
    pub reserve_y: AccountInfo<'info>,

    /// CHECK: Token X mint — passed through to Meteora CPI
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: Token Y mint — passed through to Meteora CPI
    pub token_y_mint: UncheckedAccount<'info>,

    /// CHECK: Event authority
    pub event_authority: AccountInfo<'info>,

    /// CHECK: DLMM program
    #[account(constraint = dlmm_program.key() == METEORA_DLMM_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub dlmm_program: AccountInfo<'info>,

    // --- Token accounts (ownership validated) ---

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_x.owner == position.owner @ CoreError::InvalidTokenOwner)]
    pub owner_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_y.owner == position.owner @ CoreError::InvalidTokenOwner)]
    pub owner_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    // --- Fee routing: all fees → rover_authority ATAs (sweep_rover splits 50/50) ---
    #[account(seeds = [b"rover_authority"], bump = rover_authority.bump)]
    pub rover_authority: Box<Account<'info, RoverAuthority>>,

    #[account(mut, constraint = rover_fee_token_x.owner == rover_authority.key() @ CoreError::InvalidTokenOwner)]
    pub rover_fee_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = rover_fee_token_y.owner == rover_authority.key() @ CoreError::InvalidTokenOwner)]
    pub rover_fee_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X program — must be SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,
    /// CHECK: Token Y program — must be SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program (required for Token-2022 V2 CPI)
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BotHarvest<'info> {
    #[account(mut)]
    pub bot: Signer<'info>,

    // NOTE: config is mut for last_bot_harvest_slot heartbeat update.
    // Bot authorization moved to instruction body (permissionless fallback).
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        seeds = [b"vault", position.meteora_position.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: Position owner
    #[account(mut, constraint = owner.key() == position.owner @ CoreError::Unauthorized)]
    pub owner: AccountInfo<'info>,

    // --- Meteora ---

    /// CHECK: Meteora position
    #[account(mut, constraint = meteora_position.key() == position.meteora_position @ CoreError::InvalidPosition)]
    pub meteora_position: AccountInfo<'info>,

    /// CHECK: DLMM pool
    #[account(mut, constraint = lb_pair.key() == position.lb_pair @ CoreError::InvalidPool)]
    pub lb_pair: AccountInfo<'info>,

    /// CHECK: Bitmap ext — writable only when real account exists
    pub bin_array_bitmap_ext: AccountInfo<'info>,

    /// CHECK: Bin array lower
    #[account(mut)]
    pub bin_array_lower: AccountInfo<'info>,

    /// CHECK: Bin array upper
    #[account(mut)]
    pub bin_array_upper: AccountInfo<'info>,

    /// CHECK: Reserve X
    #[account(mut)]
    pub reserve_x: AccountInfo<'info>,

    /// CHECK: Reserve Y
    #[account(mut)]
    pub reserve_y: AccountInfo<'info>,

    /// CHECK: Token X mint — passed through to Meteora CPI
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: Token Y mint — passed through to Meteora CPI
    pub token_y_mint: UncheckedAccount<'info>,

    /// CHECK: Event authority
    pub event_authority: AccountInfo<'info>,

    /// CHECK: DLMM program
    #[account(constraint = dlmm_program.key() == METEORA_DLMM_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub dlmm_program: AccountInfo<'info>,

    // --- Token accounts (ownership validated) ---

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_x.owner == position.owner @ CoreError::InvalidTokenOwner)]
    pub owner_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_y.owner == position.owner @ CoreError::InvalidTokenOwner)]
    pub owner_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    // --- Fee routing: all fees → rover_authority ATAs (sweep_rover splits 50/50) ---
    #[account(seeds = [b"rover_authority"], bump = rover_authority.bump)]
    pub rover_authority: Box<Account<'info, RoverAuthority>>,

    #[account(mut, constraint = rover_fee_token_x.owner == rover_authority.key() @ CoreError::InvalidTokenOwner)]
    pub rover_fee_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = rover_fee_token_y.owner == rover_authority.key() @ CoreError::InvalidTokenOwner)]
    pub rover_fee_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X program — must be SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,
    /// CHECK: Token Y program — must be SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program (required for Token-2022 V2 CPI)
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct UserClose<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ CoreError::Unauthorized,
        close = user
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = user,
        seeds = [b"vault", position.meteora_position.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    // --- Meteora ---

    /// CHECK: Meteora position
    #[account(mut, constraint = meteora_position.key() == position.meteora_position @ CoreError::InvalidPosition)]
    pub meteora_position: AccountInfo<'info>,

    /// CHECK: DLMM pool
    #[account(mut, constraint = lb_pair.key() == position.lb_pair @ CoreError::InvalidPool)]
    pub lb_pair: AccountInfo<'info>,

    /// CHECK: Bitmap ext — writable only when real account exists
    pub bin_array_bitmap_ext: AccountInfo<'info>,

    /// CHECK: Bin array lower
    #[account(mut)]
    pub bin_array_lower: AccountInfo<'info>,

    /// CHECK: Bin array upper
    #[account(mut)]
    pub bin_array_upper: AccountInfo<'info>,

    /// CHECK: Reserve X
    #[account(mut)]
    pub reserve_x: AccountInfo<'info>,

    /// CHECK: Reserve Y
    #[account(mut)]
    pub reserve_y: AccountInfo<'info>,

    /// CHECK: Token X mint — passed through to Meteora CPI
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: Token Y mint — passed through to Meteora CPI
    pub token_y_mint: UncheckedAccount<'info>,

    /// CHECK: Event authority
    pub event_authority: AccountInfo<'info>,

    /// CHECK: DLMM program
    #[account(constraint = dlmm_program.key() == METEORA_DLMM_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub dlmm_program: AccountInfo<'info>,

    // --- Token accounts ---

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = user_token_x.owner == user.key() @ CoreError::InvalidTokenOwner)]
    pub user_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = user_token_y.owner == user.key() @ CoreError::InvalidTokenOwner)]
    pub user_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    // --- Fee routing: all fees → rover_authority ATAs (sweep_rover splits 50/50) ---
    #[account(seeds = [b"rover_authority"], bump = rover_authority.bump)]
    pub rover_authority: Box<Account<'info, RoverAuthority>>,

    #[account(mut, constraint = rover_fee_token_x.owner == rover_authority.key() @ CoreError::InvalidTokenOwner)]
    pub rover_fee_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = rover_fee_token_y.owner == rover_authority.key() @ CoreError::InvalidTokenOwner)]
    pub rover_fee_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X program — must be SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,
    /// CHECK: Token Y program — must be SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program (required for Token-2022 V2 CPI)
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ CoreError::Unauthorized
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        seeds = [b"vault", position.meteora_position.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    // --- Meteora ---

    /// CHECK: Meteora position
    #[account(mut, constraint = meteora_position.key() == position.meteora_position @ CoreError::InvalidPosition)]
    pub meteora_position: AccountInfo<'info>,

    /// CHECK: DLMM pool
    #[account(mut, constraint = lb_pair.key() == position.lb_pair @ CoreError::InvalidPool)]
    pub lb_pair: AccountInfo<'info>,

    /// CHECK: Bin array lower
    #[account(mut)]
    pub bin_array_lower: AccountInfo<'info>,

    /// CHECK: Bin array upper
    #[account(mut)]
    pub bin_array_upper: AccountInfo<'info>,

    /// CHECK: Reserve X
    #[account(mut)]
    pub reserve_x: AccountInfo<'info>,

    /// CHECK: Reserve Y
    #[account(mut)]
    pub reserve_y: AccountInfo<'info>,

    /// CHECK: Token X mint — passed through to Meteora CPI
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: Token Y mint — passed through to Meteora CPI
    pub token_y_mint: UncheckedAccount<'info>,

    /// CHECK: Event authority
    pub event_authority: AccountInfo<'info>,

    /// CHECK: DLMM program
    #[account(constraint = dlmm_program.key() == METEORA_DLMM_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub dlmm_program: AccountInfo<'info>,

    // --- Token accounts ---

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = user_token_x.owner == user.key() @ CoreError::InvalidTokenOwner)]
    pub user_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = user_token_y.owner == user.key() @ CoreError::InvalidTokenOwner)]
    pub user_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X program — must be SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,
    /// CHECK: Token Y program — must be SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program (required for Token-2022 V2 CPI)
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = authority.key() == config.authority @ CoreError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Permissionless fee application — anyone can apply after timelock expires
#[derive(Accounts)]
pub struct ApplyFee<'info> {
    pub caller: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

/// Emergency close — permissionless after 24hr timelock.
/// Closes Position + Vault PDAs without Meteora CPI.
/// Transfers any remaining vault tokens to position owner before closing.
#[derive(Accounts)]
pub struct ApplyEmergencyClose<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        close = caller,
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        constraint = position.key() == config.pending_emergency_close @ CoreError::InvalidPosition
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = caller,
        seeds = [b"vault", position.meteora_position.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: Position owner — receives any remaining vault tokens
    #[account(constraint = owner.key() == position.owner @ CoreError::Unauthorized)]
    pub owner: AccountInfo<'info>,

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_x.owner == position.owner @ CoreError::InvalidTokenOwner)]
    pub owner_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_y.owner == position.owner @ CoreError::InvalidTokenOwner)]
    pub owner_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X mint
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: Token Y mint
    pub token_y_mint: UncheckedAccount<'info>,

    /// CHECK: Token X program
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,

    /// CHECK: Token Y program
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        constraint = new_authority.key() == config.pending_authority @ CoreError::Unauthorized,
        constraint = config.pending_authority != Pubkey::default() @ CoreError::NoPendingAuthority
    )]
    pub new_authority: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

// ============ ROVER CONTEXTS ============

#[derive(Accounts)]
pub struct InitializeRover<'info> {
    #[account(
        mut,
        constraint = authority.key() == config.authority @ CoreError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = RoverAuthority::SIZE,
        seeds = [b"rover_authority"],
        bump
    )]
    pub rover_authority: Account<'info, RoverAuthority>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(amount: u64, bin_step: u16)]
pub struct OpenRoverPosition<'info> {
    /// Anyone can deposit tokens as a rover bribe
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"rover_authority"],
        bump = rover_authority.bump
    )]
    pub rover_authority: Box<Account<'info, RoverAuthority>>,

    // --- Meteora accounts ---

    /// CHECK: Validated by Meteora CPI
    #[account(mut)]
    pub lb_pair: AccountInfo<'info>,

    /// New position keypair (frontend generates)
    #[account(mut)]
    pub meteora_position: Signer<'info>,

    /// CHECK: Bitmap extension — writable only when real account exists
    pub bin_array_bitmap_ext: AccountInfo<'info>,

    /// CHECK: Pool reserve X
    #[account(mut)]
    pub reserve_x: AccountInfo<'info>,

    /// CHECK: Pool reserve Y
    #[account(mut)]
    pub reserve_y: AccountInfo<'info>,

    /// CHECK: Bin array lower
    #[account(mut)]
    pub bin_array_lower: AccountInfo<'info>,

    /// CHECK: Bin array upper
    #[account(mut)]
    pub bin_array_upper: AccountInfo<'info>,

    // --- crank.money accounts ---

    #[account(
        init,
        payer = depositor,
        space = Position::SIZE,
        seeds = [b"position", meteora_position.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init,
        payer = depositor,
        space = Vault::SIZE,
        seeds = [b"vault", meteora_position.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: Depositor's token account. Validated in handler.
    #[account(mut)]
    pub depositor_token_account: AccountInfo<'info>,

    /// CHECK: Vault token X account. Validated in handler.
    #[account(mut)]
    pub vault_token_x: AccountInfo<'info>,

    /// CHECK: Vault token Y account. Validated in handler.
    #[account(mut)]
    pub vault_token_y: AccountInfo<'info>,

    /// CHECK: Token X mint
    pub token_x_mint: AccountInfo<'info>,

    /// CHECK: Token Y mint
    pub token_y_mint: AccountInfo<'info>,

    /// CHECK: Token X program — SPL Token or Token-2022
    pub token_x_program: AccountInfo<'info>,

    /// CHECK: Token Y program — SPL Token or Token-2022
    pub token_y_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    // event_authority, dlmm_program, memo_program passed via remaining_accounts
    // to fit within BPF 4KB stack frame with 2 init accounts
}

#[derive(Accounts)]
// Timelocked propose/apply for rover revenue_dest
pub struct UpdateRoverDistPool<'info> {
    #[account(constraint = authority.key() == config.authority @ CoreError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"rover_authority"],
        bump = rover_authority.bump
    )]
    pub rover_authority: Account<'info, RoverAuthority>,
}

/// Permissionless apply for revenue_dest after 24hr timelock
#[derive(Accounts)]
pub struct ApplyRevenueDest<'info> {
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"rover_authority"],
        bump = rover_authority.bump
    )]
    pub rover_authority: Account<'info, RoverAuthority>,
}

#[derive(Accounts)]
pub struct SweepRover<'info> {
    /// Anyone can call sweep — permissionless
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"rover_authority"],
        bump = rover_authority.bump
    )]
    pub rover_authority: Account<'info, RoverAuthority>,

    /// CHECK: Revenue destination — bridge_vault PDA (50% to holders)
    #[account(
        mut,
        constraint = revenue_dest.key() == rover_authority.revenue_dest @ CoreError::InvalidPool,
        constraint = !revenue_dest.executable @ CoreError::InvalidDistPool
    )]
    pub revenue_dest: AccountInfo<'info>,

    /// CHECK: Operator destination — bot keypair from Config (50% to operations)
    #[account(
        mut,
        constraint = bot_dest.key() == config.bot @ CoreError::InvalidBot,
        constraint = !bot_dest.executable @ CoreError::InvalidBot
    )]
    pub bot_dest: AccountInfo<'info>,
}

/// Close a token account owned by rover_authority. Permissionless.
/// Lamports (balance + rent) always go to rover_authority itself — no extraction possible.
#[derive(Accounts)]
pub struct CloseRoverTokenAccount<'info> {
    /// Anyone can call — permissionless
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"rover_authority"],
        bump = rover_authority.bump
    )]
    pub rover_authority: Account<'info, RoverAuthority>,

    /// Token account to close — must be owned by rover_authority
    #[account(
        mut,
        constraint = token_account.owner == rover_authority.key() @ CoreError::InvalidTokenOwner
    )]
    pub token_account: InterfaceAccount<'info, ITokenAccount>,

    /// CHECK: SPL Token or Token-2022
    #[account(constraint = *token_program.key == anchor_spl::token::ID || *token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, bin_step: u16)]
pub struct OpenFeeRover<'info> {
    /// Bot-gated — pays rent for Position + Vault PDAs
    #[account(
        mut,
        constraint = bot.key() == config.bot @ CoreError::Unauthorized
    )]
    pub bot: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, seeds = [b"rover_authority"], bump = rover_authority.bump)]
    pub rover_authority: Box<Account<'info, RoverAuthority>>,

    // --- Meteora accounts ---

    /// CHECK: Validated by Meteora CPI
    #[account(mut)]
    pub lb_pair: AccountInfo<'info>,

    /// New position keypair (bot generates)
    #[account(mut)]
    pub meteora_position: Signer<'info>,

    /// CHECK: Bitmap extension — writable only when real account exists
    pub bin_array_bitmap_ext: AccountInfo<'info>,

    /// CHECK: Pool reserve X
    #[account(mut)]
    pub reserve_x: AccountInfo<'info>,

    /// CHECK: Pool reserve Y
    #[account(mut)]
    pub reserve_y: AccountInfo<'info>,

    /// CHECK: Bin array lower
    #[account(mut)]
    pub bin_array_lower: AccountInfo<'info>,

    /// CHECK: Bin array upper
    #[account(mut)]
    pub bin_array_upper: AccountInfo<'info>,

    // --- crank.money accounts ---

    #[account(init, payer = bot, space = Position::SIZE, seeds = [b"position", meteora_position.key().as_ref()], bump)]
    pub position: Box<Account<'info, Position>>,

    #[account(init, payer = bot, space = Vault::SIZE, seeds = [b"vault", meteora_position.key().as_ref()], bump)]
    pub vault: Box<Account<'info, Vault>>,

    /// Source: rover_authority's token account (accumulated fee tokens)
    #[account(mut, constraint = rover_token_account.owner == rover_authority.key() @ CoreError::InvalidTokenOwner)]
    pub rover_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Vault token X account. Validated in handler.
    #[account(mut)]
    pub vault_token_x: AccountInfo<'info>,

    /// CHECK: Vault token Y account. Validated in handler.
    #[account(mut)]
    pub vault_token_y: AccountInfo<'info>,

    /// CHECK: Token X mint
    pub token_x_mint: AccountInfo<'info>,

    /// CHECK: Token Y mint
    pub token_y_mint: AccountInfo<'info>,

    /// CHECK: Token X program — SPL Token or Token-2022
    pub token_x_program: AccountInfo<'info>,

    /// CHECK: Token Y program — SPL Token or Token-2022
    pub token_y_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    // event_authority, dlmm_program, memo_program passed via remaining_accounts
    // to fit within BPF 4KB stack frame with 2 init accounts
}

// ============ ROVER EVENTS ============

#[event]
pub struct RoverOpenedEvent {
    pub depositor: Pubkey,
    pub lb_pair: Pubkey,
    pub position: Pubkey,
    pub token_mint: Pubkey,    // What token was deposited
    pub amount: u64,
    pub active_id: i32,        // On-chain activeId that determined range
    pub bin_step: u16,         // Needed to compute price range
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    pub timestamp: i64,
}

#[event]
pub struct RoverSweptEvent {
    pub amount: u64,
    pub monke_share: u64,
    pub operator_share: u64,
    pub dist_pool: Pubkey,
    pub bot: Pubkey,
    pub timestamp: i64,
}

// ============ ERRORS ============

#[error_code]
pub enum CoreError {
    #[msg("Not authorized")]
    Unauthorized,
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Invalid bin range (min must be <= max)")]
    InvalidBinRange,
    #[msg("Position width exceeds maximum (70 bins)")]
    PositionTooWide,
    #[msg("Bin ID outside position range")]
    BinOutOfPositionRange,
    #[msg("Invalid slippage (must be 0-20)")]
    InvalidSlippage,
    #[msg("Fee too high (max 10%)")]
    FeeTooHigh,
    #[msg("No bin IDs provided")]
    NoBinsProvided,
    #[msg("Too many bins (max 70 per call)")]
    TooManyBins,
    #[msg("Bin IDs must be contiguous (no gaps)")]
    NonContiguousBins,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Token account owner mismatch")]
    InvalidTokenOwner,
    #[msg("Invalid Meteora program ID")]
    InvalidProgram,
    #[msg("Invalid Meteora position")]
    InvalidPosition,
    #[msg("Invalid pool")]
    InvalidPool,
    #[msg("No pending authority")]
    NoPendingAuthority,
    #[msg("No pending fee change")]
    NoPendingFeeChange,
    #[msg("Fee timelock not expired (24 hours required)")]
    FeeTimelockNotExpired,
    #[msg("Nothing to sweep (rover authority has no excess SOL)")]
    NothingToSweep,
    #[msg("Bot close operations are paused")]
    BotPaused,
    #[msg("Rover deposit below minimum (anti-griefing)")]
    RoverDepositTooSmall,
    #[msg("Position amount below minimum (anti-griefing)")]
    PositionTooSmall,
    #[msg("Rover bin_step too small (minimum 20 — prevents instant liquidation on tight pools)")]
    RoverBinStepTooSmall,
    #[msg("dist_pool cannot be the null address")]
    InvalidDistPool,
    #[msg("Bot is still active — permissionless harvest not yet available")]
    BotNotStale,
    #[msg("Permissionless harvester must provide keeper ATA in remaining_accounts")]
    MissingKeeperAta,
    #[msg("Priority slots exceed maximum (9000 slots / ~1 hour)")]
    PrioritySlotsExceedMax,
    #[msg("No pending emergency close")]
    NoPendingEmergencyClose,
    #[msg("Emergency close timelock not expired (24 hours required)")]
    EmergencyCloseTimelockNotExpired,
    #[msg("Invalid mint account data (too short to read decimals)")]
    InvalidMintData,
    #[msg("Invalid bot destination")]
    InvalidBot,

}
