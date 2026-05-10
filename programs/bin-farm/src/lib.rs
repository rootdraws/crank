// crank.money Core Contract
// Wraps Meteora DLMM with UserVault PDAs + auto-harvest/close capability.
// Users interact via a PDA seeded by their real Solana wallet; bot is the
// sole signer and fee payer, reimbursed from the vault PDA via deduct_gas.
//
#![deny(clippy::integer_arithmetic)]
#![deny(clippy::unwrap_used)]
//
// SECURITY FIXES applied:
// - Vault PDA is per-position (not per-pool) — prevents cross-position drainage
// - All token accounts validated for correct owner
// - All fees route to rover_authority ATAs (sweep_rover splits 40/40/20: holders + traders + bot)
// - Meteora accounts explicit in contexts (not remaining_accounts)
// - claim_fees fully wired (was a stub)
// - All 4 CPI TODOs replaced with verified Meteora CPI calls

use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_spl::token_interface::{TokenAccount as ITokenAccount, TransferChecked, transfer_checked, CloseAccount, close_account, Mint};

mod meteora_dlmm_cpi;
use meteora_dlmm_cpi::*;

declare_id!("8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia");

pub const DEFAULT_FEE_BPS: u16 = 30;

/// Hard cap on `Config.gas_lamports` (0.01 SOL). Bounds blast radius if the
/// admin/bot key is ever compromised — attacker can't inflate per-op gas to
/// drain vaults via routine ops.
pub const MAX_GAS_LAMPORTS: u64 = 10_000_000;

/// Hard cap on rent passthrough per `open_position_v2` call (0.2 SOL).
/// Real worst case is ~0.14 SOL (2 fresh bin arrays + position accounts);
/// 0.2 leaves headroom while bounding damage if bot key is compromised.
pub const MAX_RENT_DEDUCT_LAMPORTS: u64 = 200_000_000;

/// Minimum deposit amount for user positions (anti-griefing, prevents dust positions)
pub const MIN_POSITION_AMOUNT: u64 = 10_000;

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
        config.gas_lamports = 0;
        config.fee_dest = Pubkey::default(); // falls back to `bot` until set via set_fee_dest
        config.payout_bps = 0;
        config.match_ratio_bps = 0;
        config.payout_admin = Pubkey::default(); // uninitialized — call init_payout_config
        config.tax_bps = 0;
        config.tax_reserve = Pubkey::default(); // tax routing disabled until set_tax_config

        msg!("crank.money initialized | bot={} fee={}bps", bot, fee_bps);
        Ok(())
    }

    /// Open a DLMM position on behalf of a user vault.
    /// Bot is the tx signer + rent payer. Tokens come from the user vault's ATA.
    /// For SOL-side buys: inline wrapping via lamport manipulation + sync_native.
    pub fn open_position_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenPositionV2<'info>>,
        amount: u64,
        min_bin_id: i32,
        max_bin_id: i32,
        _side: Side,
        max_active_bin_slippage: i32,
        rent_lamports: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CoreError::Paused);
        require!(ctx.accounts.bot.key() == ctx.accounts.config.bot, CoreError::Unauthorized);
        require!(amount > 0, CoreError::ZeroAmount);
        require!(amount >= MIN_POSITION_AMOUNT, CoreError::PositionTooSmall);
        require!(max_active_bin_slippage >= 0 && max_active_bin_slippage <= 20, CoreError::InvalidSlippage);
        require!(min_bin_id <= max_bin_id, CoreError::InvalidBinRange);
        require!(rent_lamports <= MAX_RENT_DEDUCT_LAMPORTS, CoreError::RentLamportsTooHigh);
        let width = max_bin_id - min_bin_id + 1;
        require!(width <= MAX_POSITION_WIDTH, CoreError::PositionTooWide);

        // Validate DLMM program
        require!(ctx.accounts.dlmm_program.key() == METEORA_DLMM_PROGRAM_ID, CoreError::InvalidProgram);

        // Validate position vault token account owners (stack savings: manual check)
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
        // Validate user vault deposit ATA owner
        {
            let data = ctx.accounts.user_vault_deposit_ata.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.user_vault.key(), CoreError::InvalidTokenOwner);
        }

        // Derive side from on-chain active_id — never trust caller
        let active_id = {
            let data = ctx.accounts.lb_pair.try_borrow_data()?;
            require!(data.len() >= 80, CoreError::InvalidPool);
            i32::from_le_bytes(data[76..80].try_into().map_err(|_| CoreError::Overflow)?)
        };
        require!(active_id > -443636 && active_id < 443636, CoreError::InvalidBinRange);
        let side = if min_bin_id > active_id { Side::Sell } else { Side::Buy };

        // --- Transfer tokens from UserVault ATA → position Vault ATA ---
        // The UserVault PDA signs the transfer via invoke_signed.
        let uv_owner_key = ctx.accounts.user_vault.owner;
        let uv_bump = [ctx.accounts.user_vault.bump];
        let user_vault_seeds: &[&[u8]] = &[
            b"user_vault",
            uv_owner_key.as_ref(),
            &uv_bump,
        ];

        let deposit_token_program = if side == Side::Sell {
            &ctx.accounts.token_x_program
        } else {
            &ctx.accounts.token_y_program
        };
        let deposit_position_vault = if side == Side::Sell {
            &ctx.accounts.vault_token_x
        } else {
            &ctx.accounts.vault_token_y
        };

        // Transfer from user_vault_deposit_ata → position vault ATA (user vault PDA signs)
        let transfer_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: *deposit_token_program.key,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.user_vault_deposit_ata.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(deposit_position_vault.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.user_vault.key(), true),
            ],
            data: {
                let mut d = vec![3u8]; // transfer variant
                d.extend_from_slice(&amount.to_le_bytes());
                d
            },
        };
        anchor_lang::solana_program::program::invoke_signed(
            &transfer_ix,
            &[
                ctx.accounts.user_vault_deposit_ata.to_account_info(),
                deposit_position_vault.to_account_info(),
                ctx.accounts.user_vault.to_account_info(),
                deposit_token_program.to_account_info(),
            ],
            &[user_vault_seeds],
        )?;

        // Build PDA signer seeds for meteora_position
        let user_vault_key = ctx.accounts.user_vault.key();
        let lb_pair_key = ctx.accounts.lb_pair.key();
        let count_bytes = ctx.accounts.position_counter.count.to_le_bytes();
        let meteora_pos_bump = [ctx.bumps.meteora_position];

        let meteora_pos_key = ctx.accounts.meteora_position.key();
        let meteora_pos_seeds: &[&[u8]] = &[
            b"meteora_pos",
            user_vault_key.as_ref(),
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
                ctx.accounts.bot.to_account_info(),  // payer (was: user)
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
        position.user_vault = ctx.accounts.user_vault.key();
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

        // Gas reimbursement (flat per-op tx fee)
        deduct_gas(
            config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.bot.to_account_info(),
        )?;

        // Rent passthrough — bot fronted real rent for position/vault/counter/
        // bin arrays; vault reimburses the exact lamport amount the bot paid.
        // Capped (require above) and bounded by vault rent-exempt minimum.
        if rent_lamports > 0 {
            let rent_min = Rent::get()?.minimum_balance(UserVault::SIZE);
            let available = ctx.accounts.user_vault.to_account_info()
                .lamports()
                .saturating_sub(rent_min);
            let deduct = rent_lamports.min(available);
            require!(deduct == rent_lamports, CoreError::InsufficientBalance);
            **ctx.accounts.user_vault.to_account_info().try_borrow_mut_lamports()? -= deduct;
            **ctx.accounts.bot.to_account_info().try_borrow_mut_lamports()? += deduct;
        }

        emit!(PositionOpenedEvent {
            position: ctx.accounts.position.key(),
            user: ctx.accounts.user_vault.owner,
            lb_pair: ctx.accounts.lb_pair.key(),
            side,
            amount,
            min_bin_id,
            max_bin_id,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Position opened: {} | {} bins [{},{}] | {} lamports + {} rent",
            ctx.accounts.position.key(), width, min_bin_id, max_bin_id, amount, rent_lamports);
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

        // Validate fee destination matches Config.fee_dest (or Config.bot if unset).
        let effective_fee_dest = if ctx.accounts.config.fee_dest == Pubkey::default() {
            ctx.accounts.config.bot
        } else {
            ctx.accounts.config.fee_dest
        };
        require!(
            ctx.accounts.fee_dest.key() == effective_fee_dest,
            CoreError::InvalidFeeDest
        );

        let x_decimals = read_mint_decimals(&ctx.accounts.token_x_mint)?;
        let y_decimals = read_mint_decimals(&ctx.accounts.token_y_mint)?;

        let position_key = ctx.accounts.position.key();
        let owner_key = ctx.accounts.user_vault.owner; // real wallet for event
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
                keeper_ata_info.key() != ctx.accounts.fee_dest_token_y.key()
                    && keeper_ata_info.key() != ctx.accounts.fee_dest_token_x.key()
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

        // Fee routing: all fees → rover_authority ATAs (sweep_rover splits 40/40/20: holders + traders + bot)
        //   TOKEN fees (Buy side) → fee_dest_token_x for DLMM recycling
        //   SOL fees (Sell side)  → fee_dest_token_y (WSOL, unwrapped later via close_rover_token_account)
        if x_to_protocol > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_x_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_token_x.to_account_info(),
                        mint: ctx.accounts.token_x_mint.to_account_info(),
                        to: ctx.accounts.fee_dest_token_x.to_account_info(),
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
                        to: ctx.accounts.fee_dest_token_y.to_account_info(),
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

        // Gas reimbursement — only when authorized bot harvested actual yield.
        // Permissionless keepers are compensated via `keeper_tip_bps` from fees;
        // zero-yield calls must not drain user vault (prevents permissionless spam
        // drain via repeated no-op harvests).
        let had_yield = x_received > 0 || y_received > 0;
        if is_authorized_bot && had_yield {
            deduct_gas(
                &ctx.accounts.config,
                &ctx.accounts.user_vault.to_account_info(),
                &ctx.accounts.bot.to_account_info(),
            )?;
        }

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

        // Validate fee destination matches Config.fee_dest (or Config.bot if unset).
        let effective_fee_dest = if ctx.accounts.config.fee_dest == Pubkey::default() {
            ctx.accounts.config.bot
        } else {
            ctx.accounts.config.fee_dest
        };
        require!(
            ctx.accounts.fee_dest.key() == effective_fee_dest,
            CoreError::InvalidFeeDest
        );

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

        // 3. Close Meteora position (rent -> user_vault).
        // Rationale: vault paid the rent at open via open_position_v2's
        // rent_lamports passthrough. Refund must return to vault to preserve
        // user-funds invariant. (Pre-rent-passthrough this routed to bot to
        // recoup the float; that subsidy model is gone.)
        close_position2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.user_vault.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            signer,
        )?;

        let position_key = ctx.accounts.position.key();
        let owner_key = ctx.accounts.user_vault.owner;

        // Inline settle for treasury-matched positions. When PositionSettle exists,
        // pay proposer + tax cuts BEFORE execute_close_transfers drains the vault.
        if let Some(settle) = ctx.accounts.position_settle.as_mut() {
            let proposer_ata = ctx.accounts.proposer_output_ata.as_deref()
                .ok_or(CoreError::MissingProposerAta)?;
            let tax_ata = ctx.accounts.tax_reserve_output_ata.as_deref();
            run_inline_settle(
                &ctx.accounts.config,
                settle.as_mut(),
                side,
                &mut ctx.accounts.vault_token_x,
                &mut ctx.accounts.vault_token_y,
                proposer_ata,
                tax_ata,
                &ctx.accounts.token_x_mint.to_account_info(),
                &ctx.accounts.token_y_mint.to_account_info(),
                &ctx.accounts.token_x_program,
                &ctx.accounts.token_y_program,
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.memo_program,
                signer,
            )?;
        }

        let (x_fee, y_fee, x_out, y_out) = execute_close_transfers(
            side,
            ctx.accounts.config.fee_bps,
            &mut ctx.accounts.vault_token_x,
            &mut ctx.accounts.vault_token_y,
            &ctx.accounts.owner_token_x.to_account_info(),
            &ctx.accounts.owner_token_y.to_account_info(),
            &ctx.accounts.fee_dest_token_y.to_account_info(),
            &ctx.accounts.fee_dest_token_x.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.user_vault.to_account_info(),
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
        ctx.accounts.config.total_positions = ctx.accounts.config.total_positions.saturating_sub(1);

        // Gas reimbursement — user's vault pays for bot-initiated close
        deduct_gas(
            &ctx.accounts.config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.bot.to_account_info(),
        )?;

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

    /// User or bot closes position. Caller must be authorized bot or vault owner.
    pub fn user_close(ctx: Context<UserClose>) -> Result<()> {
        // Dual-caller: either authorized bot or vault owner (real wallet)
        let caller = ctx.accounts.caller.key();
        let is_authorized = caller == ctx.accounts.config.bot
            || caller == ctx.accounts.user_vault.owner;
        require!(is_authorized, CoreError::UnauthorizedCaller);

        // Validate fee destination matches Config.fee_dest (or Config.bot if unset).
        let effective_fee_dest = if ctx.accounts.config.fee_dest == Pubkey::default() {
            ctx.accounts.config.bot
        } else {
            ctx.accounts.config.fee_dest
        };
        require!(
            ctx.accounts.fee_dest.key() == effective_fee_dest,
            CoreError::InvalidFeeDest
        );

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

        // 3. Close Meteora position (rent -> user_vault)
        close_position2(
            &[
                ctx.accounts.meteora_position.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.user_vault.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.dlmm_program.to_account_info(),
            ],
            signer,
        )?;

        let position_key = ctx.accounts.position.key();
        let owner_key = ctx.accounts.user_vault.owner;

        // Inline settle for treasury-matched positions (see ClosePosition for rationale).
        if let Some(settle) = ctx.accounts.position_settle.as_mut() {
            let proposer_ata = ctx.accounts.proposer_output_ata.as_deref()
                .ok_or(CoreError::MissingProposerAta)?;
            let tax_ata = ctx.accounts.tax_reserve_output_ata.as_deref();
            run_inline_settle(
                &ctx.accounts.config,
                settle.as_mut(),
                side,
                &mut ctx.accounts.vault_token_x,
                &mut ctx.accounts.vault_token_y,
                proposer_ata,
                tax_ata,
                &ctx.accounts.token_x_mint.to_account_info(),
                &ctx.accounts.token_y_mint.to_account_info(),
                &ctx.accounts.token_x_program,
                &ctx.accounts.token_y_program,
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.memo_program,
                signer,
            )?;
        }

        let (x_fee, y_fee, x_out, y_out) = execute_close_transfers(
            side,
            ctx.accounts.config.fee_bps,
            &mut ctx.accounts.vault_token_x,
            &mut ctx.accounts.vault_token_y,
            &ctx.accounts.user_token_x.to_account_info(),
            &ctx.accounts.user_token_y.to_account_info(),
            &ctx.accounts.fee_dest_token_y.to_account_info(),
            &ctx.accounts.fee_dest_token_x.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.user_vault.to_account_info(),
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
        ctx.accounts.config.total_positions = ctx.accounts.config.total_positions.saturating_sub(1);

        // Gas reimbursement
        deduct_gas(
            &ctx.accounts.config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
        )?;

        emit!(CloseEvent {
            position: position_key,
            owner: owner_key,
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
        // Dual-caller: either authorized bot or vault owner
        let caller = ctx.accounts.caller.key();
        let is_authorized = caller == ctx.accounts.config.bot
            || caller == ctx.accounts.user_vault.owner;
        require!(is_authorized, CoreError::UnauthorizedCaller);

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
            user: ctx.accounts.user_vault.owner,
            lb_pair: ctx.accounts.position.lb_pair,
            x_amount: x_claimed,
            y_amount: y_claimed,
            timestamp: Clock::get()?.unix_timestamp,
        });

        // Gas reimbursement
        deduct_gas(
            &ctx.accounts.config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
        )?;

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

    /// Admin sets the destination wallet for harvest_bins protocol fees.
    /// Pass `Pubkey::default()` to fall back to `Config.bot` (legacy behavior).
    /// Will be retargeted to the Hopper program PDA once Hopper ships.
    pub fn set_fee_dest(ctx: Context<AdminOnly>, new_fee_dest: Pubkey) -> Result<()> {
        ctx.accounts.config.fee_dest = new_fee_dest;
        emit!(AdminConfigEvent {
            field: "fee_dest".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("fee_dest set to {}", new_fee_dest);
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

    /// Direct admin-gated fee setter. Replaces the prior propose/apply timelock.
    /// Defensively clears any in-flight pending_fee state from the prior pattern.
    pub fn set_fee_bps(ctx: Context<AdminOnly>, new_fee_bps: u16) -> Result<()> {
        require!(new_fee_bps <= 1000, CoreError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        let old_fee = config.fee_bps;
        config.fee_bps = new_fee_bps;
        config.pending_fee_bps = 0;
        config.fee_change_at = 0;
        msg!("Fee set: {} bps → {} bps", old_fee, new_fee_bps);
        emit!(FeeAppliedEvent {
            old_fee_bps: old_fee,
            new_fee_bps,
        });
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
        config.total_positions = config.total_positions.saturating_sub(1);

        // Position + Vault are closed by Anchor `close` constraints on the context
        emit!(EmergencyCloseEvent {
            position: ctx.accounts.position.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Emergency close executed: x_returned={} y_returned={}", x_amount, y_amount);
        Ok(())
    }


    // ============ USER VAULT INSTRUCTIONS ============

    /// Create a vault PDA for a user. Anyone can pay rent. The vault is
    /// cryptographically bound to `owner` via PDA seeds — no signer check needed.
    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        let vault = &mut ctx.accounts.user_vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.user_vault;

        emit!(VaultCreatedEvent {
            user_vault: ctx.accounts.user_vault.key(),
            owner: ctx.accounts.owner.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Vault created for owner={}", ctx.accounts.owner.key());
        Ok(())
    }

    /// Withdraw native SOL from user vault to the vault owner's wallet.
    /// Caller must be authorized bot or the vault owner.
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let config_bot = ctx.accounts.config.bot;
        let vault_owner = ctx.accounts.user_vault.owner;
        require!(
            caller == config_bot || caller == vault_owner,
            CoreError::UnauthorizedCaller
        );
        require!(amount > 0, CoreError::ZeroAmount);

        let rent = Rent::get()?.minimum_balance(UserVault::SIZE);
        let available = ctx.accounts.user_vault.to_account_info().lamports()
            .saturating_sub(rent);
        require!(amount <= available, CoreError::InsufficientBalance);

        **ctx.accounts.user_vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.try_borrow_mut_lamports()? += amount;

        // Gas reimbursement
        deduct_gas(
            &ctx.accounts.config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
        )?;

        msg!("Withdrew {} lamports to {}", amount, vault_owner);
        Ok(())
    }

    /// Withdraw SPL/Token-2022 tokens from user vault ATA to owner's ATA.
    /// Caller must be authorized bot or the vault owner.
    pub fn withdraw_token(ctx: Context<WithdrawToken>, amount: u64) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let config_bot = ctx.accounts.config.bot;
        let vault_owner = ctx.accounts.user_vault.owner;
        require!(
            caller == config_bot || caller == vault_owner,
            CoreError::UnauthorizedCaller
        );
        require!(amount > 0, CoreError::ZeroAmount);

        let decimals = read_mint_decimals(&ctx.accounts.token_mint)?;
        let owner_key = ctx.accounts.user_vault.owner;
        let vault_seeds: &[&[u8]] = &[
            b"user_vault",
            owner_key.as_ref(),
            &[ctx.accounts.user_vault.bump],
        ];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.user_vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount,
            decimals,
        )?;

        // Gas reimbursement
        deduct_gas(
            &ctx.accounts.config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
        )?;

        msg!("Withdrew {} tokens to {}", amount, vault_owner);
        Ok(())
    }

    /// Wrap native SOL in user vault to WSOL in the vault's WSOL ATA.
    /// Uses direct lamport manipulation (bin-farm owns the vault PDA) + sync_native CPI.
    /// Bot calls this before open_position_v2 for SOL-side buys.
    pub fn wrap_sol_in_vault(ctx: Context<WrapSolInVault>, amount: u64) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let is_authorized = caller == ctx.accounts.config.bot
            || caller == ctx.accounts.user_vault.owner;
        require!(is_authorized, CoreError::UnauthorizedCaller);
        require!(amount > 0, CoreError::ZeroAmount);

        let rent = Rent::get()?.minimum_balance(UserVault::SIZE);
        let available = ctx.accounts.user_vault.to_account_info().lamports()
            .saturating_sub(rent);
        require!(amount <= available, CoreError::InsufficientBalance);

        // Debit vault PDA (bin-farm-owned), credit WSOL ATA.
        // sync_native must be called AFTER this instruction (separate ix in same tx)
        // to update the WSOL token balance. CPI to sync_native in the same instruction
        // causes a runtime balance mismatch on the Token-program-owned ATA.
        **ctx.accounts.user_vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.vault_wsol_ata.to_account_info().try_borrow_mut_lamports()? += amount;

        // Gas reimbursement
        deduct_gas(
            &ctx.accounts.config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
        )?;

        msg!("Wrapped {} lamports SOL → WSOL in vault", amount);
        Ok(())
    }

    /// Wrap native SOL → WSOL in a caller-owned WSOL ATA.
    /// Generic: source = caller's lamports (must be system-owned), destination =
    /// any WSOL ATA where `token::authority == caller`. Used in Path B open marker
    /// proposals to atomically wrap NTP native lamports → NTP's WSOL ATA inside
    /// the same governance tx that mints `TradeAuth`. Caller signs as Signer,
    /// so for NTP use governance signs via `invoke_signed`.
    pub fn wrap_caller_sol(ctx: Context<WrapCallerSol>, amount: u64) -> Result<()> {
        require!(amount > 0, CoreError::ZeroAmount);

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.caller.to_account_info(),
                    to: ctx.accounts.caller_wsol_ata.to_account_info(),
                },
            ),
            amount,
        )?;

        anchor_spl::token::sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::SyncNative {
                account: ctx.accounts.caller_wsol_ata.to_account_info(),
            },
        ))?;

        msg!("wrap_caller_sol: {} lamports → caller WSOL ATA", amount);
        Ok(())
    }

    /// Unwrap WSOL in vault back to native SOL.
    /// Closes the vault's WSOL ATA — token balance returns to vault PDA,
    /// ATA rent returns to caller (bot paid for creation, bot gets rent back).
    /// Called after harvest/close that produces WSOL, or before withdraw_sol.
    pub fn unwrap_wsol_in_vault(ctx: Context<UnwrapWsolInVault>) -> Result<()> {
        let caller = ctx.accounts.caller.key();
        let is_authorized = caller == ctx.accounts.config.bot
            || caller == ctx.accounts.user_vault.owner;
        require!(is_authorized, CoreError::UnauthorizedCaller);

        // Read ATA rent before closing (rent = lamports - token_amount)
        let ata_lamports = ctx.accounts.vault_wsol_ata.to_account_info().lamports();
        let token_amount = ctx.accounts.vault_wsol_ata.amount;
        let rent_lamports = ata_lamports.saturating_sub(token_amount);

        let owner_key = ctx.accounts.user_vault.owner;
        let vault_seeds: &[&[u8]] = &[
            b"user_vault",
            owner_key.as_ref(),
            &[ctx.accounts.user_vault.bump],
        ];

        // Close ATA — all lamports go to vault PDA first
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_wsol_ata.to_account_info(),
                destination: ctx.accounts.user_vault.to_account_info(),
                authority: ctx.accounts.user_vault.to_account_info(),
            },
            &[vault_seeds],
        ))?;

        // Return ATA rent to caller (bot paid for creation)
        if rent_lamports > 0 {
            **ctx.accounts.user_vault.to_account_info().try_borrow_mut_lamports()? -= rent_lamports;
            **ctx.accounts.caller.to_account_info().try_borrow_mut_lamports()? += rent_lamports;
        }

        // Gas reimbursement
        deduct_gas(
            &ctx.accounts.config,
            &ctx.accounts.user_vault.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
        )?;

        msg!("Unwrapped WSOL → native SOL in vault");
        Ok(())
    }

    /// Move SPL/Token-2022 tokens from `vault.owner`'s ATA → vault's ATA.
    /// Governance-only: caller must equal `user_vault.owner` (i.e. NTP, signed by
    /// SPL Governance via `invoke_signed` during proposal execution).
    ///
    /// Used in Path B OPEN payloads to flow working capital from the protocol's
    /// visible NTP-ATA reserves into the treasury vault for one trade. Pair with
    /// `withdraw_treasury_token` in the CLOSE payload to return the residue.
    pub fn deposit_treasury_token(ctx: Context<DepositTreasuryToken>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );
        require!(amount > 0, CoreError::ZeroAmount);

        let decimals = read_mint_decimals(&ctx.accounts.token_mint)?;

        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.caller.to_account_info(),
                },
            ),
            amount,
            decimals,
        )?;

        msg!("Treasury deposit {} tokens vault.owner → vault", amount);
        Ok(())
    }

    /// Move SPL/Token-2022 tokens from vault's ATA → `vault.owner`'s ATA.
    /// Governance-only: caller must equal `user_vault.owner` (NTP via
    /// SPL Governance `invoke_signed`).
    ///
    /// Used in Path B CLOSE payloads to return residual treasury working capital
    /// to NTP's direct ATA, restoring Realms-visible reserves. Distinct from
    /// `withdraw_token`, which is dual-callable by the bot for the Path A surface.
    pub fn withdraw_treasury_token(ctx: Context<WithdrawTreasuryToken>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );
        require!(amount > 0, CoreError::ZeroAmount);

        let decimals = read_mint_decimals(&ctx.accounts.token_mint)?;
        let owner_key = ctx.accounts.user_vault.owner;
        let vault_seeds: &[&[u8]] = &[
            b"user_vault",
            owner_key.as_ref(),
            &[ctx.accounts.user_vault.bump],
        ];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.user_vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount,
            decimals,
        )?;

        msg!("Treasury withdraw {} tokens vault → vault.owner", amount);
        Ok(())
    }

    /// Drain native lamports from the treasury user_vault back to the NTP
    /// (= user_vault.owner). Governance-signed only (caller must equal
    /// user_vault.owner; for the treasury vault that's the NTP, signable only
    /// via SPL Governance executeTransaction). One-shot cleanup for operational
    /// SOL pre-existing before Path B stopped using user_vault as a gas/rent
    /// float. Leaves rent-exempt minimum behind so the PDA stays alive.
    pub fn drain_treasury_native_to_ntp(ctx: Context<DrainTreasuryNativeToNtp>) -> Result<()> {
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );

        let rent_min = Rent::get()?.minimum_balance(UserVault::SIZE);
        let available = ctx.accounts.user_vault.to_account_info()
            .lamports()
            .saturating_sub(rent_min);
        require!(available > 0, CoreError::InsufficientBalance);

        **ctx.accounts.user_vault.to_account_info().try_borrow_mut_lamports()? -= available;
        **ctx.accounts.caller.to_account_info().try_borrow_mut_lamports()? += available;

        msg!("drain_treasury_native_to_ntp: {} lamports user_vault → NTP", available);
        Ok(())
    }

    /// Admin sets gas reimbursement amount per operation.
    pub fn update_gas_lamports(ctx: Context<AdminOnly>, gas_lamports: u64) -> Result<()> {
        require!(gas_lamports <= MAX_GAS_LAMPORTS, CoreError::GasLamportsTooHigh);
        ctx.accounts.config.gas_lamports = gas_lamports;
        msg!("Gas lamports updated to {}", gas_lamports);
        Ok(())
    }

    // ============ TREASURY-MATCH PAYOUT (cranksettle, folded) ============

    /// One-shot initializer for payout config. Idempotency: requires the current
    /// `payout_admin` to be `Pubkey::default()` (i.e. uninitialized). Authority-gated
    /// (FFwq) — runs once during realm bootstrap. After this, `update_payout_config`
    /// is the only path to change `payout_bps` / `match_ratio_bps`, and
    /// `set_payout_admin` is the only path to migrate `payout_admin` (e.g. to
    /// the Native Treasury PDA at realm bootstrap step).
    pub fn init_payout_config(
        ctx: Context<AdminOnly>,
        payout_bps: u16,
        match_ratio_bps: u16,
        payout_admin: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.payout_admin == Pubkey::default(),
            CoreError::PayoutAdminAlreadyInitialized
        );
        require!(payout_bps <= 5000, CoreError::PayoutBpsTooHigh);
        require!(match_ratio_bps <= 50000, CoreError::MatchRatioTooHigh);
        require!(payout_admin != Pubkey::default(), CoreError::Unauthorized);

        config.payout_bps = payout_bps;
        config.match_ratio_bps = match_ratio_bps;
        config.payout_admin = payout_admin;

        emit!(AdminConfigEvent {
            field: "init_payout_config".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Payout config initialized: payout_bps={}, match_ratio_bps={}, payout_admin={}",
             payout_bps, match_ratio_bps, payout_admin);
        Ok(())
    }

    /// Update payout/match parameters. Must be signed by `payout_admin` (which
    /// post-bootstrap is the Native Treasury PDA, meaning this can only run via
    /// a passed governance proposal).
    ///
    /// `payout_bps` and `match_ratio_bps` are independently optional — pass
    /// `0xFFFF` (u16 sentinel) to leave a field unchanged. (Anchor's IDL doesn't
    /// support `Option<u16>` cleanly across all clients; sentinel is more robust.)
    pub fn update_payout_config(
        ctx: Context<UpdatePayoutConfig>,
        payout_bps: u16,
        match_ratio_bps: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if payout_bps != u16::MAX {
            require!(payout_bps <= 5000, CoreError::PayoutBpsTooHigh);
            config.payout_bps = payout_bps;
        }
        if match_ratio_bps != u16::MAX {
            require!(match_ratio_bps <= 50000, CoreError::MatchRatioTooHigh);
            config.match_ratio_bps = match_ratio_bps;
        }
        emit!(AdminConfigEvent {
            field: "update_payout_config".into(),
            authority: ctx.accounts.payout_admin.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Payout config updated: payout_bps={}, match_ratio_bps={}",
             config.payout_bps, config.match_ratio_bps);
        Ok(())
    }

    /// Direct admin set of `payout_admin`. Used at realm bootstrap to migrate
    /// from FFwq → Native Treasury PDA. Authority-gated (FFwq) — single-step
    /// (no two-step pending dance) since `payout_bps` is hard-capped at 50%
    /// and the blast radius of a wrong pubkey is bounded.
    pub fn set_payout_admin(ctx: Context<AdminOnly>, new: Pubkey) -> Result<()> {
        require!(new != Pubkey::default(), CoreError::Unauthorized);
        ctx.accounts.config.payout_admin = new;
        emit!(AdminConfigEvent {
            field: "payout_admin".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("payout_admin set to {}", new);
        Ok(())
    }

    /// One-shot grow of the existing on-chain Config from the v1 layout
    /// (with [u8;20] reserved tail) to the v2 layout (with tax_bps + tax_reserve
    /// fields). Idempotent: if the account is already at v2 size, returns Ok.
    /// Authority-gated.
    pub fn expand_config_v2(ctx: Context<ExpandConfigV2>) -> Result<()> {
        // Use AccountInfo directly: the v2-typed Account<Config> deserializer
        // would fail against a v1-sized (313 B) account before this handler
        // runs, defeating the migration. We auth-check the on-chain authority
        // bytes manually, then realloc + zero-extend.
        let info = &ctx.accounts.config.to_account_info();
        if info.data_len() >= Config::SIZE {
            msg!("Config already at v2 size ({} bytes) — skip", info.data_len());
            return Ok(());
        }
        require!(
            info.data_len() == Config::SIZE_V1,
            CoreError::Unauthorized
        );

        // authority is at offset 8 (after 8-byte Anchor disc).
        {
            let data = info.try_borrow_data()?;
            require!(data.len() >= 8 + 32, CoreError::Unauthorized);
            let mut buf = [0u8; 32];
            buf.copy_from_slice(&data[8..8 + 32]);
            require!(
                ctx.accounts.authority.key() == Pubkey::new_from_array(buf),
                CoreError::Unauthorized
            );
        }

        // Top up rent for the new size before realloc.
        let new_size = Config::SIZE;
        let needed = Rent::get()?.minimum_balance(new_size);
        let have = info.lamports();
        if needed > have {
            let topup = needed - have;
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: info.clone(),
                    },
                ),
                topup,
            )?;
        }
        info.realloc(new_size, true)?;

        emit!(AdminConfigEvent {
            field: "expand_config_v2".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("Config expanded to v2 ({} bytes)", new_size);
        Ok(())
    }

    /// Set the tax-reserve cut on settle_proposer payouts. Authority-gated
    /// (operator HW post-rotation). `tax_bps` is hard-capped so the
    /// proposer + tax slices combined cannot exceed 50% — the remaining
    /// half always flows back to the treasury at user_close.
    pub fn set_tax_config(
        ctx: Context<AdminOnly>,
        tax_bps: u16,
        tax_reserve: Pubkey,
    ) -> Result<()> {
        require!(tax_bps <= 5000, CoreError::PayoutBpsTooHigh);
        let config = &mut ctx.accounts.config;
        // Combined cap: proposer + tax ≤ 50% of position output.
        require!(
            (config.payout_bps as u32) + (tax_bps as u32) <= 5000,
            CoreError::PayoutBpsTooHigh
        );
        config.tax_bps = tax_bps;
        config.tax_reserve = tax_reserve;
        emit!(AdminConfigEvent {
            field: "set_tax_config".into(),
            authority: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });
        msg!("set_tax_config: tax_bps={}, tax_reserve={}", tax_bps, tax_reserve);
        Ok(())
    }

    /// Records the proposer + output_mint + payout_bps snapshot for a treasury
    /// position. Called as ix #2 of the OPEN proposal payload, immediately
    /// after `open_position_v2` creates the position.
    ///
    /// Caller is dual-allowed: bot (for non-governance test paths) OR
    /// vault.owner (governance-driven; `caller = native_treasury_pda` via
    /// `invoke_signed` in proposal execution). The ix is keyed by the
    /// meteora_position so every treasury position has at most one
    /// PositionSettle, enforced by the PDA's `init` constraint.
    pub fn record_settle_meta(
        ctx: Context<RecordSettleMeta>,
        proposer: Pubkey,
    ) -> Result<()> {
        require!(proposer != Pubkey::default(), CoreError::InvalidProposer);

        // Governance-only: caller must be user_vault.owner. For treasury
        // positions that's the Native Treasury PDA, signable only by SPL
        // Governance via invoke_signed during proposal execution. The addin
        // gates which proposals can tip → no off-governance bot path.
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );

        // Output mint is determined by position.side:
        //   Sell deposits tokenX, output is tokenY (typically SOL).
        //   Buy deposits tokenY, output is tokenX (typically CRANK).
        let output_mint = match ctx.accounts.position.side {
            Side::Sell => ctx.accounts.token_y_mint.key(),
            Side::Buy => ctx.accounts.token_x_mint.key(),
        };

        let settle = &mut ctx.accounts.position_settle;
        settle.proposer = proposer;
        settle.output_mint = output_mint;
        settle.payout_bps = ctx.accounts.config.payout_bps;
        settle.settled = false;
        settle.bump = ctx.bumps.position_settle;

        msg!("PositionSettle created: meteora_pos={}, proposer={}, output={}, payout_bps={}",
             ctx.accounts.meteora_position.key(), proposer, output_mint, settle.payout_bps);
        Ok(())
    }

    /// Pays the recorded proposer their `payout_bps` slice of the per-position
    /// vault's OUTPUT mint balance. Called as ix #1 of the CLOSE proposal
    /// payload — MUST run BEFORE `user_close`, because `user_close` transfers
    /// all remaining position-vault tokens to the user_vault (= treasury vault)
    /// and closes the position-vault PDA.
    ///
    /// Caller authorization mirrors `user_close` (dual-caller). Transfer is
    /// signed by the position vault PDA's seeds (bin-farm-internal CPI).
    pub fn settle_proposer(ctx: Context<SettleProposer>) -> Result<()> {
        // Governance-only — see record_settle_meta caller-check rationale.
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );

        require!(!ctx.accounts.position_settle.settled, CoreError::AlreadySettled);
        require!(
            ctx.accounts.position_settle.output_mint == ctx.accounts.output_mint.key(),
            CoreError::OutputMintMismatch
        );
        require!(
            ctx.accounts.proposer_output_ata.owner == ctx.accounts.position_settle.proposer,
            CoreError::InvalidProposer
        );

        let output_balance = ctx.accounts.position_vault_output_ata.amount;
        let payout_bps = ctx.accounts.position_settle.payout_bps as u128;
        let payout = (output_balance as u128)
            .checked_mul(payout_bps)
            .ok_or(CoreError::Overflow)?
            .checked_div(10_000)
            .ok_or(CoreError::Overflow)? as u64;

        // Tax slice: read live tax_bps + tax_reserve from Config (NOT snapshotted
        // per-position — tax routing is a runtime policy, retargetable any time).
        // If tax_reserve is unset, skip the tax leg entirely.
        let cfg_tax_bps = ctx.accounts.config.tax_bps as u128;
        let tax_payout: u64 = if ctx.accounts.config.tax_reserve != Pubkey::default()
            && cfg_tax_bps > 0
        {
            (output_balance as u128)
                .checked_mul(cfg_tax_bps)
                .ok_or(CoreError::Overflow)?
                .checked_div(10_000)
                .ok_or(CoreError::Overflow)? as u64
        } else {
            0
        };

        let meteora_pos_key = ctx.accounts.meteora_position.key();
        let vault_seeds: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[vault_seeds];
        let decimals = read_mint_decimals(&ctx.accounts.output_mint.to_account_info())?;

        if payout > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.position_vault_output_ata.to_account_info(),
                        mint: ctx.accounts.output_mint.to_account_info(),
                        to: ctx.accounts.proposer_output_ata.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                payout,
                decimals,
            )?;
        }

        if tax_payout > 0 {
            // tax_reserve_output_ata is required when tax routing is active.
            let tax_ata = ctx
                .accounts
                .tax_reserve_output_ata
                .as_ref()
                .ok_or(CoreError::InvalidTaxReserveAta)?;
            // ATA must be owned by Config.tax_reserve — protects against a
            // compromised bot subbing in their own ATA at proposal-author time.
            require!(
                tax_ata.owner == ctx.accounts.config.tax_reserve,
                CoreError::InvalidTaxReserveAta
            );
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.position_vault_output_ata.to_account_info(),
                        mint: ctx.accounts.output_mint.to_account_info(),
                        to: tax_ata.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer,
                ),
                tax_payout,
                decimals,
            )?;
        }

        ctx.accounts.position_settle.settled = true;

        msg!(
            "Proposer settled: payout={} (bps={}) tax={} (bps={}) of output_balance={}",
            payout, ctx.accounts.position_settle.payout_bps,
            tax_payout, ctx.accounts.config.tax_bps,
            output_balance,
        );
        Ok(())
    }

    /// Closes the PositionSettle PDA, refunding rent to the treasury user_vault.
    /// Called as the last ix of the CLOSE proposal payload (after user_close has
    /// already run and `position_settle.settled == true` from settle_proposer).
    pub fn close_settle(ctx: Context<CloseSettle>) -> Result<()> {
        // Governance-only — see record_settle_meta caller-check rationale.
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );

        require!(ctx.accounts.position_settle.settled, CoreError::NotSettled);
        // Anchor's `close = user_vault` constraint handles the rent refund.
        Ok(())
    }

    // ============ TREASURY MARKER PATTERN (Path B v3) ============
    //
    // Replaces the multi-index Path B (deposit + open_position_v2 + record_settle
    // as 3 inner ixs across 3 ProposalTransaction PDAs) with a 1-ix marker
    // proposal that creates a TradeAuth, plus a bot-signed combined ix that
    // does the real work atomically. Cuts per-fire SOL cost ~$5 → ~$1.74.
    //
    // Security: authorize_treasury_* requires caller == user_vault.owner. For
    // the treasury vault, that's NTP — only signable via SPL Governance
    // invoke_signed during executeTransaction. The proposal-whitelist-addin
    // gates which ixs can pass, so a compromised bot cannot fabricate a
    // TradeAuth.

    /// Marker ix #1 of the OPEN proposal payload. Creates a TradeAuth PDA the
    /// bot will consume via `treasury_open_combined` after proposal execute.
    pub fn authorize_treasury_open(
        ctx: Context<AuthorizeTreasuryOpen>,
        side: u8,
        amount: u64,
        min_bin_id: i32,
        max_bin_id: i32,
        slippage: i32,
        proposer: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );
        require!(amount > 0, CoreError::ZeroAmount);
        require!(amount >= MIN_POSITION_AMOUNT, CoreError::PositionTooSmall);
        require!(slippage >= 0 && slippage <= 20, CoreError::InvalidSlippage);
        require!(min_bin_id <= max_bin_id, CoreError::InvalidBinRange);
        let width = max_bin_id - min_bin_id + 1;
        require!(width <= MAX_POSITION_WIDTH, CoreError::PositionTooWide);
        require!(side == 0 || side == 1, CoreError::TradeAuthInvalidSide);
        require!(proposer != Pubkey::default(), CoreError::InvalidProposer);

        let auth = &mut ctx.accounts.trade_auth;
        auth.bot = ctx.accounts.config.bot;
        auth.proposer = proposer;
        auth.lb_pair = ctx.accounts.lb_pair.key();
        auth.user_vault = ctx.accounts.user_vault.key();
        auth.action = TRADE_AUTH_ACTION_OPEN;
        auth.side = side;
        auth.min_bin_id = min_bin_id;
        auth.max_bin_id = max_bin_id;
        auth.slippage = slippage;
        auth.amount = amount;
        auth.expires_at = Clock::get()?.unix_timestamp + TRADE_AUTH_TTL_SECS;
        auth.bump = ctx.bumps.trade_auth;

        msg!(
            "TradeAuth OPEN: vault={} pool={} side={} amt={} bins=[{},{}] proposer={}",
            auth.user_vault, auth.lb_pair, side, amount, min_bin_id, max_bin_id, proposer
        );
        Ok(())
    }

    /// Marker ix of the CLOSE proposal payload. Creates a TradeAuth (action=Close)
    /// the bot will consume via `treasury_close_combined`. The position to close
    /// is identified by lb_pair + (off-chain) the proposer-recorded
    /// PositionSettle reference; the on-chain authority binding is via
    /// auth.user_vault and auth.lb_pair.
    pub fn authorize_treasury_close(
        ctx: Context<AuthorizeTreasuryClose>,
        proposer: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.caller.key() == ctx.accounts.user_vault.owner,
            CoreError::UnauthorizedCaller
        );
        require!(proposer != Pubkey::default(), CoreError::InvalidProposer);

        let auth = &mut ctx.accounts.trade_auth;
        auth.bot = ctx.accounts.config.bot;
        auth.proposer = proposer;
        auth.lb_pair = ctx.accounts.lb_pair.key();
        auth.user_vault = ctx.accounts.user_vault.key();
        auth.action = TRADE_AUTH_ACTION_CLOSE;
        auth.side = 0;
        auth.min_bin_id = 0;
        auth.max_bin_id = 0;
        auth.slippage = 0;
        auth.amount = 0;
        auth.expires_at = Clock::get()?.unix_timestamp + TRADE_AUTH_TTL_SECS;
        auth.bump = ctx.bumps.trade_auth;

        msg!(
            "TradeAuth CLOSE: vault={} pool={} proposer={}",
            auth.user_vault, auth.lb_pair, proposer
        );
        Ok(())
    }

    /// Bot-signed recovery: close an expired TradeAuth that wasn't consumed.
    /// Refunds rent to bot. Required because `init` on the marker ix blocks any
    /// new TradeAuth while a stale one exists for the same user_vault, and there
    /// is no other path to close a TradeAuth outside of consume.
    pub fn cancel_expired_trade_auth(ctx: Context<CancelExpiredTradeAuth>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.trade_auth.expires_at < now,
            CoreError::TradeAuthNotExpired
        );
        require!(
            ctx.accounts.bot.key() == ctx.accounts.trade_auth.bot,
            CoreError::UnauthorizedCaller
        );
        msg!(
            "cancel_expired_trade_auth: vault={} expired_at={} now={}",
            ctx.accounts.trade_auth.user_vault,
            ctx.accounts.trade_auth.expires_at,
            now
        );
        Ok(())
    }

    /// Bot-signed direct tx — consumes a TradeAuth (action=Open) and inlines
    /// deposit + open_position + record_settle in one atomic CPI. The TradeAuth
    /// is closed (rent → bot) on success.
    ///
    /// Source-of-truth for the trade params is the on-chain TradeAuth, NOT bot
    /// args, so a compromised bot cannot deviate from what governance approved.
    pub fn treasury_open_combined<'info>(
        ctx: Context<'_, '_, 'info, 'info, TreasuryOpenCombined<'info>>,
        _rent_lamports: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, CoreError::Paused);
        require!(ctx.accounts.bot.key() == ctx.accounts.config.bot, CoreError::Unauthorized);

        // ---- Validate TradeAuth ----
        let auth = &ctx.accounts.trade_auth;
        let now = Clock::get()?.unix_timestamp;
        require!(now < auth.expires_at, CoreError::TradeAuthExpired);
        require!(auth.action == TRADE_AUTH_ACTION_OPEN, CoreError::TradeAuthActionMismatch);
        require!(auth.bot == ctx.accounts.bot.key(), CoreError::TradeAuthBotMismatch);
        require!(auth.user_vault == ctx.accounts.user_vault.key(), CoreError::TradeAuthVaultMismatch);
        require!(auth.lb_pair == ctx.accounts.lb_pair.key(), CoreError::TradeAuthPoolMismatch);
        require!(auth.side == 0 || auth.side == 1, CoreError::TradeAuthInvalidSide);
        require!(auth.amount > 0, CoreError::ZeroAmount);
        require!(auth.amount >= MIN_POSITION_AMOUNT, CoreError::PositionTooSmall);
        require!(auth.slippage >= 0 && auth.slippage <= 20, CoreError::InvalidSlippage);
        require!(auth.min_bin_id <= auth.max_bin_id, CoreError::InvalidBinRange);
        let width = auth.max_bin_id - auth.min_bin_id + 1;
        require!(width <= MAX_POSITION_WIDTH, CoreError::PositionTooWide);
        require!(ctx.accounts.dlmm_program.key() == METEORA_DLMM_PROGRAM_ID, CoreError::InvalidProgram);

        let amount = auth.amount;
        let min_bin_id = auth.min_bin_id;
        let max_bin_id = auth.max_bin_id;
        let max_active_bin_slippage = auth.slippage;
        let proposer = auth.proposer;

        // ---- Validate ATA ownerships ----
        // (mirrors open_position_v2:113-131)
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
        {
            let data = ctx.accounts.user_vault_deposit_ata.try_borrow_data()?;
            require!(data.len() >= 64, CoreError::InvalidTokenOwner);
            let owner = Pubkey::try_from(&data[32..64]).map_err(|_| CoreError::InvalidTokenOwner)?;
            require!(owner == ctx.accounts.user_vault.key(), CoreError::InvalidTokenOwner);
        }
        // caller_token_account = vault.owner's direct ATA (NTP for treasury vault).
        // InterfaceAccount.owner is the SPL token account owner field.
        require!(
            ctx.accounts.caller_token_account.owner == ctx.accounts.user_vault.owner,
            CoreError::TradeAuthSourceAtaMismatch
        );

        // Derive on-chain side (mirrors open_position_v2:133-140)
        let active_id = {
            let data = ctx.accounts.lb_pair.try_borrow_data()?;
            require!(data.len() >= 80, CoreError::InvalidPool);
            i32::from_le_bytes(data[76..80].try_into().map_err(|_| CoreError::Overflow)?)
        };
        require!(active_id > -443636 && active_id < 443636, CoreError::InvalidBinRange);
        let side = if min_bin_id > active_id { Side::Sell } else { Side::Buy };

        // ---- INLINED FROM deposit_treasury_token (lib.rs:1482-1507) ----
        // Bot signs as delegate over vault.owner's ATA. NTP must have approved
        // bot via Token-2022 approve_checked in a one-time governance proposal
        // (Phase 7 of marker refactor plan).
        let dep_decimals = read_mint_decimals(&ctx.accounts.deposit_token_mint)?;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.deposit_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.caller_token_account.to_account_info(),
                    mint: ctx.accounts.deposit_token_mint.to_account_info(),
                    to: ctx.accounts.user_vault_deposit_ata.to_account_info(),
                    authority: ctx.accounts.bot.to_account_info(),
                },
            ),
            amount,
            dep_decimals,
        )?;

        // ---- INLINED FROM open_position_v2 (lib.rs:142-323) ----
        let uv_owner_key = ctx.accounts.user_vault.owner;
        let uv_bump = [ctx.accounts.user_vault.bump];
        let user_vault_seeds: &[&[u8]] = &[b"user_vault", uv_owner_key.as_ref(), &uv_bump];

        let pos_deposit_token_program = if side == Side::Sell {
            &ctx.accounts.token_x_program
        } else {
            &ctx.accounts.token_y_program
        };
        let pos_deposit_position_vault = if side == Side::Sell {
            &ctx.accounts.vault_token_x
        } else {
            &ctx.accounts.vault_token_y
        };

        // user_vault deposit ATA → position vault token ATA (user_vault PDA signs)
        let transfer_ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: *pos_deposit_token_program.key,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.user_vault_deposit_ata.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(pos_deposit_position_vault.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.user_vault.key(), true),
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
                ctx.accounts.user_vault_deposit_ata.to_account_info(),
                pos_deposit_position_vault.to_account_info(),
                ctx.accounts.user_vault.to_account_info(),
                pos_deposit_token_program.to_account_info(),
            ],
            &[user_vault_seeds],
        )?;

        // Build PDA signer seeds for meteora_position + per-position vault
        let user_vault_key = ctx.accounts.user_vault.key();
        let lb_pair_key = ctx.accounts.lb_pair.key();
        let count_bytes = ctx.accounts.position_counter.count.to_le_bytes();
        let meteora_pos_bump = [ctx.bumps.meteora_position];
        let meteora_pos_key = ctx.accounts.meteora_position.key();
        let meteora_pos_seeds: &[&[u8]] = &[
            b"meteora_pos",
            user_vault_key.as_ref(),
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
                token_x_mint.clone(),
                token_y_mint.clone(),
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
        position.user_vault = ctx.accounts.user_vault.key();
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

        let counter = &mut ctx.accounts.position_counter;
        if counter.bump == 0 { counter.bump = ctx.bumps.position_counter; }
        counter.count = counter.count.checked_add(1).ok_or(CoreError::Overflow)?;

        let config = &mut ctx.accounts.config;
        config.total_positions = config.total_positions.saturating_add(1);
        config.total_volume = config.total_volume.saturating_add(amount);

        // No gas/rent passthrough on Path B. Bot eats both at open and recovers
        // bin-array + per-PDA rent on close (close_position2 rent → bot, Anchor
        // close = bot on Position/Vault). NTP holds all DAO SOL; user_vault
        // holds zero in steady state.

        emit!(PositionOpenedEvent {
            position: ctx.accounts.position.key(),
            user: ctx.accounts.user_vault.owner,
            lb_pair: ctx.accounts.lb_pair.key(),
            side,
            amount,
            min_bin_id,
            max_bin_id,
            timestamp: Clock::get()?.unix_timestamp,
        });

        // ---- INLINED FROM record_settle_meta (lib.rs:1737-1770) ----
        let output_mint_pk = match ctx.accounts.position.side {
            Side::Sell => ctx.accounts.token_y_mint.key(),
            Side::Buy => ctx.accounts.token_x_mint.key(),
        };
        let settle = &mut ctx.accounts.position_settle;
        settle.proposer = proposer;
        settle.output_mint = output_mint_pk;
        settle.payout_bps = ctx.accounts.config.payout_bps;
        settle.settled = false;
        settle.bump = ctx.bumps.position_settle;

        msg!(
            "treasury_open_combined: pos={} bins=[{},{}] amount={} side={:?} proposer={} output={}",
            ctx.accounts.position.key(), min_bin_id, max_bin_id, amount, side, proposer, output_mint_pk
        );

        // TradeAuth closed via `close = bot` constraint; rent refunded.
        Ok(())
    }

    /// Bot-signed direct tx — consumes a TradeAuth (action=Close) and inlines
    /// settle_proposer + user_close + close_settle. The TradeAuth is closed
    /// (rent → bot) on success.
    pub fn treasury_close_combined<'info>(
        ctx: Context<'_, '_, 'info, 'info, TreasuryCloseCombined<'info>>,
    ) -> Result<()> {
        require!(ctx.accounts.bot.key() == ctx.accounts.config.bot, CoreError::Unauthorized);

        // ---- Validate TradeAuth ----
        let auth = &ctx.accounts.trade_auth;
        let now = Clock::get()?.unix_timestamp;
        require!(now < auth.expires_at, CoreError::TradeAuthExpired);
        require!(auth.action == TRADE_AUTH_ACTION_CLOSE, CoreError::TradeAuthActionMismatch);
        require!(auth.bot == ctx.accounts.bot.key(), CoreError::TradeAuthBotMismatch);
        require!(auth.user_vault == ctx.accounts.user_vault.key(), CoreError::TradeAuthVaultMismatch);
        require!(auth.lb_pair == ctx.accounts.lb_pair.key(), CoreError::TradeAuthPoolMismatch);

        // Validate fee_dest
        let effective_fee_dest = if ctx.accounts.config.fee_dest == Pubkey::default() {
            ctx.accounts.config.bot
        } else {
            ctx.accounts.config.fee_dest
        };
        require!(
            ctx.accounts.fee_dest.key() == effective_fee_dest,
            CoreError::InvalidFeeDest
        );

        // ---- INLINED FROM settle_proposer (lib.rs:1780-1885) ----
        require!(!ctx.accounts.position_settle.settled, CoreError::AlreadySettled);
        require!(
            ctx.accounts.position_settle.output_mint == ctx.accounts.output_mint.key(),
            CoreError::OutputMintMismatch
        );
        require!(
            ctx.accounts.proposer_output_ata.owner == ctx.accounts.position_settle.proposer,
            CoreError::InvalidProposer
        );

        let output_balance = ctx.accounts.position_vault_output_ata.amount;
        let payout_bps = ctx.accounts.position_settle.payout_bps as u128;
        let payout = (output_balance as u128)
            .checked_mul(payout_bps).ok_or(CoreError::Overflow)?
            .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;

        let cfg_tax_bps = ctx.accounts.config.tax_bps as u128;
        let tax_payout: u64 = if ctx.accounts.config.tax_reserve != Pubkey::default() && cfg_tax_bps > 0 {
            (output_balance as u128)
                .checked_mul(cfg_tax_bps).ok_or(CoreError::Overflow)?
                .checked_div(10_000).ok_or(CoreError::Overflow)? as u64
        } else { 0 };

        let meteora_pos_key = ctx.accounts.meteora_position.key();
        let vault_seeds_settle: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer_settle = &[vault_seeds_settle];
        let out_decimals = read_mint_decimals(&ctx.accounts.output_mint.to_account_info())?;

        if payout > 0 {
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.output_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.position_vault_output_ata.to_account_info(),
                        mint: ctx.accounts.output_mint.to_account_info(),
                        to: ctx.accounts.proposer_output_ata.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer_settle,
                ),
                payout,
                out_decimals,
            )?;
        }

        if tax_payout > 0 {
            let tax_ata = ctx.accounts.tax_reserve_output_ata
                .as_ref()
                .ok_or(CoreError::InvalidTaxReserveAta)?;
            require!(
                tax_ata.owner == ctx.accounts.config.tax_reserve,
                CoreError::InvalidTaxReserveAta
            );
            transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.output_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.position_vault_output_ata.to_account_info(),
                        mint: ctx.accounts.output_mint.to_account_info(),
                        to: tax_ata.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    signer_settle,
                ),
                tax_payout,
                out_decimals,
            )?;
        }

        ctx.accounts.position_settle.settled = true;

        msg!(
            "settle_proposer (combined): payout={} (bps={}) tax={} (bps={}) of output={}",
            payout, ctx.accounts.position_settle.payout_bps,
            tax_payout, ctx.accounts.config.tax_bps,
            output_balance,
        );

        // ---- INLINED FROM user_close (lib.rs:843-991) ----
        let side = ctx.accounts.position.side;
        let min_bin_id = ctx.accounts.position.min_bin_id;
        let max_bin_id = ctx.accounts.position.max_bin_id;

        let vault_seeds_close: &[&[u8]] = &[
            b"vault",
            meteora_pos_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[vault_seeds_close];

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
        let owner_key = ctx.accounts.user_vault.owner;

        // ---- Residue routing — Realms-visible NTP destinations ----
        // Replaces `execute_close_transfers` for the treasury path. CRANK
        // residue → NTP's CRANK ATA. WSOL residue → close ATA → NTP lamports
        // (auto-unwrap). Settle pre-paid proposer + tax in OUTPUT mint above.
        //
        // Y must be WSOL — the close-to-lamports trick only works for native
        // mint accounts. The CRANK/SOL pool (the only one used by Path B) has
        // Y = WSOL by Meteora's lex-ordering.
        require!(
            ctx.accounts.token_y_mint.key() == anchor_spl::token::spl_token::native_mint::ID,
            CoreError::InvalidProgram
        );

        ctx.accounts.vault_token_x.reload()?;
        ctx.accounts.vault_token_y.reload()?;
        let vault_x_balance = ctx.accounts.vault_token_x.amount;
        let vault_y_balance = ctx.accounts.vault_token_y.amount;
        let fee = ctx.accounts.config.fee_bps as u128;

        let x_decimals = read_mint_decimals(&ctx.accounts.token_x_mint.to_account_info())?;
        let y_decimals = read_mint_decimals(&ctx.accounts.token_y_mint.to_account_info())?;

        // Fee on converted side only (mirrors execute_close_transfers logic).
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

        let x_out = vault_x_balance.checked_sub(x_fee).ok_or(CoreError::Overflow)?;
        let y_out = vault_y_balance.checked_sub(y_fee).ok_or(CoreError::Overflow)?;

        // Fee → fee_dest (preserve direction)
        if x_fee > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(CpiContext::new_with_signer(
                ctx.accounts.token_x_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_x.to_account_info(),
                    mint: ctx.accounts.token_x_mint.to_account_info(),
                    to: ctx.accounts.fee_dest_token_x.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                }, signer,
            ), x_fee, x_decimals)?;
        }
        if y_fee > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(CpiContext::new_with_signer(
                ctx.accounts.token_y_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_y.to_account_info(),
                    mint: ctx.accounts.token_y_mint.to_account_info(),
                    to: ctx.accounts.fee_dest_token_y.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                }, signer,
            ), y_fee, y_decimals)?;
        }

        // Residue X (CRANK) → NTP's CRANK ATA
        if x_out > 0 {
            memo_cpi(&ctx.accounts.memo_program, &ctx.accounts.vault.to_account_info(), signer)?;
            transfer_checked(CpiContext::new_with_signer(
                ctx.accounts.token_x_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_x.to_account_info(),
                    mint: ctx.accounts.token_x_mint.to_account_info(),
                    to: ctx.accounts.ntp_token_x_ata.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                }, signer,
            ), x_out, x_decimals)?;
        }

        // Residue Y (WSOL) → close ATA → NTP lamports (auto-unwrap).
        // The y_out balance + ATA rent flow as native lamports to NTP.
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_y_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_token_y.to_account_info(),
                destination: ctx.accounts.ntp_sol_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            }, signer,
        ))?;

        let close_harvested = match side { Side::Buy => x_out, Side::Sell => y_out };
        ctx.accounts.config.total_harvested = ctx.accounts.config.total_harvested
            .checked_add(close_harvested).ok_or(CoreError::Overflow)?;
        ctx.accounts.config.total_positions = ctx.accounts.config.total_positions.saturating_sub(1);

        // No gas deduction on Path B. Bot eats per-ix gas; bin-array + PDA rent
        // round-trips bot via close_position2 + Anchor close = bot.

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

        msg!(
            "treasury_close_combined: pos={} side={:?} out_x={} out_y={} fee_x={} fee_y={} → NTP",
            position_key, side, x_out, y_out, x_fee, y_fee
        );

        // Manually close position / vault / position_settle → bot. Anchor's
        // `close = X` is omitted on these fields to keep TreasuryCloseCombined's
        // try_accounts under the 4 KB BPF stack ceiling. TradeAuth still uses
        // Anchor's close = bot.
        manual_close_to_bot(
            &ctx.accounts.position.to_account_info(),
            &ctx.accounts.bot.to_account_info(),
        )?;
        manual_close_to_bot(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.bot.to_account_info(),
        )?;
        manual_close_to_bot(
            &ctx.accounts.position_settle.to_account_info(),
            &ctx.accounts.bot.to_account_info(),
        )?;

        Ok(())
    }
}

/// Close a PDA owned by this program by transferring lamports → dest and
/// stamping the Anchor closed-account discriminator over the data prefix.
/// Used in `treasury_close_combined` instead of `close = X` on the account
/// context to free BPF stack space in `try_accounts`.
fn manual_close_to_bot<'info>(
    account: &AccountInfo<'info>,
    dest: &AccountInfo<'info>,
) -> Result<()> {
    let lamports = account.lamports();
    **dest.try_borrow_mut_lamports()? = dest
        .lamports()
        .checked_add(lamports)
        .ok_or(CoreError::Overflow)?;
    **account.try_borrow_mut_lamports()? = 0;
    let mut data = account.try_borrow_mut_data()?;
    if data.len() >= 8 {
        data[..8].copy_from_slice(&[255u8; 8]);
    }
    Ok(())
}

/// Deduct gas reimbursement from user vault → caller (bot).
/// Never drains vault below rent-exempt minimum.
fn deduct_gas<'info>(
    config: &Config,
    user_vault_info: &AccountInfo<'info>,
    bot_info: &AccountInfo<'info>,
) -> Result<()> {
    let gas = config.gas_lamports;
    if gas > 0 {
        let rent = Rent::get()?.minimum_balance(UserVault::SIZE);
        let available = user_vault_info.lamports().saturating_sub(rent);
        let deduct = gas.min(available);
        if deduct > 0 {
            **user_vault_info.try_borrow_mut_lamports()? -= deduct;
            **bot_info.try_borrow_mut_lamports()? += deduct;
        }
    }
    Ok(())
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
/// Inline-settle helper for permissionless `close_position` and `user_close`.
///
/// When a treasury-matched position has a `PositionSettle` PDA recorded at open,
/// this fires the same 25/25/50 split as `settle_proposer` / `treasury_close_combined`
/// but without the governance-only caller check. Destinations are bound to the
/// recorded proposer + Config.tax_reserve, so anyone calling can't redirect funds.
///
/// Must run AFTER liquidity-removal + claim_fee (output is in vault) and BEFORE
/// `execute_close_transfers` (which drains the vault).
///
/// PositionSettle PDA close (rent → user_vault) is handled by Anchor's
/// `close = user_vault` constraint at handler exit.
fn run_inline_settle<'info>(
    config: &Account<'info, Config>,
    position_settle: &mut Account<'info, PositionSettle>,
    side: Side,
    vault_token_x: &mut InterfaceAccount<'info, ITokenAccount>,
    vault_token_y: &mut InterfaceAccount<'info, ITokenAccount>,
    proposer_output_ata: &InterfaceAccount<'info, ITokenAccount>,
    tax_reserve_output_ata: Option<&InterfaceAccount<'info, ITokenAccount>>,
    token_x_mint: &AccountInfo<'info>,
    token_y_mint: &AccountInfo<'info>,
    token_x_program: &AccountInfo<'info>,
    token_y_program: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    memo_program: &AccountInfo<'info>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    require!(!position_settle.settled, CoreError::AlreadySettled);

    // Resolve output side based on position.side: Buy → tokenX, Sell → tokenY.
    let (output_mint_info, output_token_program, output_vault_ata) = match side {
        Side::Buy => (token_x_mint, token_x_program, vault_token_x),
        Side::Sell => (token_y_mint, token_y_program, vault_token_y),
    };
    require!(
        position_settle.output_mint == output_mint_info.key(),
        CoreError::OutputMintMismatch
    );
    require!(
        proposer_output_ata.owner == position_settle.proposer,
        CoreError::InvalidProposer
    );

    output_vault_ata.reload()?;
    let output_balance = output_vault_ata.amount;
    let payout_bps = position_settle.payout_bps as u128;
    let payout = (output_balance as u128)
        .checked_mul(payout_bps).ok_or(CoreError::Overflow)?
        .checked_div(10_000).ok_or(CoreError::Overflow)? as u64;

    let cfg_tax_bps = config.tax_bps as u128;
    let tax_payout: u64 = if config.tax_reserve != Pubkey::default() && cfg_tax_bps > 0 {
        (output_balance as u128)
            .checked_mul(cfg_tax_bps).ok_or(CoreError::Overflow)?
            .checked_div(10_000).ok_or(CoreError::Overflow)? as u64
    } else { 0 };

    let decimals = read_mint_decimals(output_mint_info)?;

    if payout > 0 {
        memo_cpi(memo_program, vault, signer)?;
        transfer_checked(
            CpiContext::new_with_signer(
                output_token_program.to_account_info(),
                TransferChecked {
                    from: output_vault_ata.to_account_info(),
                    mint: output_mint_info.to_account_info(),
                    to: proposer_output_ata.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer,
            ),
            payout,
            decimals,
        )?;
    }

    if tax_payout > 0 {
        let tax_ata = tax_reserve_output_ata.ok_or(CoreError::InvalidTaxReserveAta)?;
        require!(
            tax_ata.owner == config.tax_reserve,
            CoreError::InvalidTaxReserveAta
        );
        memo_cpi(memo_program, vault, signer)?;
        transfer_checked(
            CpiContext::new_with_signer(
                output_token_program.to_account_info(),
                TransferChecked {
                    from: output_vault_ata.to_account_info(),
                    mint: output_mint_info.to_account_info(),
                    to: tax_ata.to_account_info(),
                    authority: vault.to_account_info(),
                },
                signer,
            ),
            tax_payout,
            decimals,
        )?;
    }

    position_settle.settled = true;

    msg!(
        "Inline settle: payout={} (bps={}) tax={} (bps={}) of output_balance={}",
        payout, position_settle.payout_bps,
        tax_payout, config.tax_bps,
        output_balance,
    );

    Ok(())
}

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
    fee_dest_token_y: &AccountInfo<'info>,
    fee_dest_token_x: &AccountInfo<'info>,
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
    //   TOKEN fees (Buy side, x_fee) → fee_dest_token_x for DLMM recycling
    //   SOL fees (Sell side, y_fee)  → fee_dest_token_y (WSOL, unwrapped later)
    // B2 FIX: Prepend memo before each transfer (supports Memo Transfer extension)
    if x_fee > 0 {
        memo_cpi(memo_program, vault, signer)?;
        transfer_checked(CpiContext::new_with_signer(
            token_x_program.to_account_info(),
            TransferChecked {
                from: vault_token_x.to_account_info(),
                mint: token_x_mint.to_account_info(),
                to: fee_dest_token_x.to_account_info(),
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
                to: fee_dest_token_y.to_account_info(),
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
pub struct FeeAppliedEvent {
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
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

#[event]
pub struct VaultCreatedEvent {
    pub user_vault: Pubkey,
    pub owner: Pubkey,
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
    // --- Gas reimbursement (carved from reserved) ---
    pub gas_lamports: u64,               // Per-operation gas deduction from user vault → bot
    // --- Fee destination (carved from reserved 2026-04-29) ---
    // Single sink for all harvest_bins protocol fees (SOL or token). When
    // Pubkey::default(), falls back to `bot` for legacy callers. Will be
    // retargeted to the Hopper program PDA once Hopper ships.
    pub fee_dest: Pubkey,
    // --- Treasury-match payout config (carved from reserved 2026-05-06) ---
    // payout_bps: % of treasury position's OUTPUT asset paid to proposer at close
    //   (default 2000 = 20%). Sells → SOL output to proposer; buys → CRANK.
    // match_ratio_bps: treasury matches `user_amount * match_ratio_bps / 10000`
    //   when capacity allows (default 10000 = 1.0x).
    // payout_admin: separate from `authority` — governance-controlled post-bootstrap.
    //   Initially = `authority` (FFwq), transferred to Native Treasury PDA later.
    //   When Pubkey::default(), payout config is uninitialized (init via init_payout_config).
    pub payout_bps: u16,
    pub match_ratio_bps: u16,
    pub payout_admin: Pubkey,
    // Tax-reserve cut on settle_proposer payout (added 2026-05-08).
    // tax_bps: % of treasury position's OUTPUT asset paid to tax_reserve at close.
    //   Default 2500 (25%); paired with payout_bps=2500 leaves 50% in position
    //   vault → flows back to treasury at user_close.
    // tax_reserve: pubkey that receives the tax slice (ATA derived per output mint).
    //   Pubkey::default() means tax routing is disabled (settle_proposer skips tax leg).
    pub tax_bps: u16,
    pub tax_reserve: Pubkey,
    // Reserved space — dropped from 20 to 0 to fit tax fields. Realloc via
    // `expand_config_v2` admin ix to grow existing on-chain Config accounts
    // before this version of the program is deployed against them.
}

impl Config {
    // 8 (disc) + 32*3 (authority, pending_authority, bot) + 2+2+8 (fee_bps, pending, change_at)
    // + 8+8 (positions, volume) + 1+1+1 (paused, bot_paused, bump)
    // + 8+2+8+8 (harvest slot, keeper_tip, priority, harvested)
    // + 32+8 (emergency close) + 8+8 (close/sweep slots) + 8 (gas_lamports) + 32 (fee_dest)
    // + 2+2+32 (payout_bps, match_ratio_bps, payout_admin)
    // + 2+32 (tax_bps, tax_reserve)
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 8 + 1 + 1 + 1 + 8 + 2 + 8 + 8 + 32 + 8 + 8 + 8 + 8 + 32 + 2 + 2 + 32 + 2 + 32;
    // Pre-tax-fields size for pre-existing Config accounts (used by `expand_config_v2`).
    pub const SIZE_V1: usize = Self::SIZE - (2 + 32) + 20; // = SIZE - 14
}

#[account]
pub struct Position {
    pub user_vault: Pubkey,    // UserVault PDA (was: owner custody keypair)
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

/// Per-user vault PDA. Holds SOL + token ATAs. Replaces custodial keypairs.
/// Seeds: [b"user_vault", owner.as_ref()]
/// owner = user's real Solana wallet (immutable withdrawal destination).
#[account]
pub struct UserVault {
    pub owner: Pubkey,   // Real wallet (= PDA seed = withdraw destination)
    pub bump: u8,
}

impl UserVault {
    pub const SIZE: usize = 8 + 32 + 1;
}

/// Per-position metadata for treasury-matched proposer payouts (cranksettle, folded).
/// Created by `record_settle_meta` as ix #2 of the OPEN proposal payload.
/// Read by `settle_proposer` as ix #1 of the CLOSE proposal payload (BEFORE
/// user_close drains the per-position vault). Closed by `close_settle` as the
/// last close-payload ix; rent refunds to the treasury user_vault.
///
/// Seeds: [b"pos_settle", meteora_position.as_ref()]
#[account]
pub struct PositionSettle {
    pub proposer: Pubkey,        // Recorded at open; receives payout_bps% of OUTPUT at close
    pub output_mint: Pubkey,     // SOL=NATIVE_MINT for sells, CRANK for buys (= deposit_mint of opposite side)
    pub payout_bps: u16,         // Snapshot of Config.payout_bps at open time (immutable per-position)
    pub settled: bool,           // Prevents double-payout
    pub bump: u8,
}

impl PositionSettle {
    pub const SIZE: usize = 8 + 32 + 32 + 2 + 1 + 1;
}

/// Marker PDA created by `authorize_treasury_*` (governance-gated). Consumed +
/// closed by `treasury_*_combined` (bot-signed direct tx). One active auth per
/// treasury vault — serializes governance trades and prevents reuse.
///
/// Seeds: [b"trade_auth", user_vault.as_ref()]
#[account]
pub struct TradeAuth {
    pub bot: Pubkey,           // 32 — must match config.bot at creation; only this signer may consume
    pub proposer: Pubkey,      // 32 — recorded for record_settle_meta payout assignment
    pub lb_pair: Pubkey,       // 32 — pool the auth applies to
    pub user_vault: Pubkey,    // 32 — treasury vault PDA (bound by seed)
    pub action: u8,            // 1  — 0=Open, 1=Close
    pub side: u8,              // 1  — Side enum (Sell=0, Buy=1) for opens; ignored for close
    pub min_bin_id: i32,       // 4
    pub max_bin_id: i32,       // 4
    pub slippage: i32,         // 4
    pub amount: u64,           // 8  — for opens: matchAmount
    pub expires_at: i64,       // 8  — Clock::unix_timestamp + AUTH_TTL_SECS
    pub bump: u8,              // 1
}

impl TradeAuth {
    pub const SIZE: usize = 8 + 32*4 + 1*2 + 4*3 + 8*2 + 1;
}

/// Authorization TTL — 10 minutes from creation. After expiry the bot can't
/// consume; the TradeAuth becomes orphan rent (~0.0017 SOL).
pub const TRADE_AUTH_TTL_SECS: i64 = 600;

pub const TRADE_AUTH_ACTION_OPEN: u8 = 0;
pub const TRADE_AUTH_ACTION_CLOSE: u8 = 1;


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

/// Token-2022 compatible open_position. Bot is sole signer + rent payer.
/// Tokens come from user vault's ATA. PDA seeds use user_vault.key().
#[derive(Accounts)]
#[instruction(amount: u64, min_bin_id: i32, max_bin_id: i32, side: Side)]
pub struct OpenPositionV2<'info> {
    #[account(mut)]
    pub bot: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: Validated by Meteora CPI
    #[account(mut)]
    pub lb_pair: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = bot,
        space = PositionCounter::SIZE,
        seeds = [b"pos_counter", user_vault.key().as_ref(), lb_pair.key().as_ref()],
        bump
    )]
    pub position_counter: Account<'info, PositionCounter>,

    /// CHECK: PDA signed via invoke_signed
    #[account(
        mut,
        seeds = [b"meteora_pos", user_vault.key().as_ref(), lb_pair.key().as_ref(), &position_counter.count.to_le_bytes()],
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
        payer = bot,
        space = Position::SIZE,
        seeds = [b"position", meteora_position.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init,
        payer = bot,
        space = Vault::SIZE,
        seeds = [b"vault", meteora_position.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: User vault's deposit token ATA (Token-2022 compatible). Validated in handler.
    #[account(mut)]
    pub user_vault_deposit_ata: AccountInfo<'info>,

    /// CHECK: Position vault's token X account. Validated in handler.
    #[account(mut)]
    pub vault_token_x: AccountInfo<'info>,

    /// CHECK: Position vault's token Y account. Validated in handler.
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

    /// UserVault PDA — receives rent on close + gas deduction source
    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
        constraint = user_vault.key() == position.user_vault @ CoreError::Unauthorized,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(
        mut,
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        close = user_vault
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = user_vault,
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

    // --- Token accounts (ownership validated) ---

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_x.owner == position.user_vault @ CoreError::InvalidTokenOwner)]
    pub owner_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_y.owner == position.user_vault @ CoreError::InvalidTokenOwner)]
    pub owner_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    // --- Fee routing: all fees → Config.fee_dest ATAs (or Config.bot fallback) ---
    /// CHECK: validated in handler against config.fee_dest (or config.bot fallback)
    pub fee_dest: AccountInfo<'info>,

    #[account(mut, constraint = fee_dest_token_x.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = fee_dest_token_y.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X program — must be SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,
    /// CHECK: Token Y program — must be SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program (required for Token-2022 V2 CPI)
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,

    // --- Optional treasury-match settle accounts ---
    // Pass these when closing a treasury-matched position to atomically settle
    // the proposer's payout. Path A (user-only) closes pass None.
    #[account(
        mut,
        seeds = [b"pos_settle", position.meteora_position.as_ref()],
        bump,
        close = user_vault,
    )]
    pub position_settle: Option<Box<Account<'info, PositionSettle>>>,
    #[account(mut)]
    pub proposer_output_ata: Option<Box<InterfaceAccount<'info, ITokenAccount>>>,
    #[account(mut)]
    pub tax_reserve_output_ata: Option<Box<InterfaceAccount<'info, ITokenAccount>>>,

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

    /// UserVault PDA — receives harvested tokens, gas deducted from here
    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
        constraint = user_vault.key() == position.user_vault @ CoreError::Unauthorized,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    /// CHECK: Position owner
    #[account(mut, constraint = owner.key() == position.user_vault @ CoreError::Unauthorized)]
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

    #[account(mut, constraint = owner_token_x.owner == position.user_vault @ CoreError::InvalidTokenOwner)]
    pub owner_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_y.owner == position.user_vault @ CoreError::InvalidTokenOwner)]
    pub owner_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    // --- Fee routing: all fees → Config.fee_dest ATAs (or Config.bot fallback) ---
    /// CHECK: validated in handler against config.fee_dest (or config.bot fallback)
    pub fee_dest: AccountInfo<'info>,

    #[account(mut, constraint = fee_dest_token_x.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = fee_dest_token_y.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

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
    /// Caller: authorized bot or vault owner (real wallet)
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// UserVault PDA — authorization checked in handler body (dual-caller)
    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(
        mut,
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        constraint = position.user_vault == user_vault.key() @ CoreError::Unauthorized,
        close = user_vault,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        mut,
        close = user_vault,
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

    #[account(mut, constraint = user_token_x.owner == user_vault.key() @ CoreError::InvalidTokenOwner)]
    pub user_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = user_token_y.owner == user_vault.key() @ CoreError::InvalidTokenOwner)]
    pub user_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    // --- Fee routing: all fees → Config.fee_dest ATAs (or Config.bot fallback) ---
    /// CHECK: validated in handler against config.fee_dest (or config.bot fallback)
    pub fee_dest: AccountInfo<'info>,

    #[account(mut, constraint = fee_dest_token_x.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = fee_dest_token_y.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X program — must be SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,
    /// CHECK: Token Y program — must be SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program (required for Token-2022 V2 CPI)
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,

    // --- Optional treasury-match settle accounts ---
    // Pass these when closing a treasury-matched position to atomically settle
    // the proposer's payout. Path A (user-only) closes pass None.
    #[account(
        mut,
        seeds = [b"pos_settle", position.meteora_position.as_ref()],
        bump,
        close = user_vault,
    )]
    pub position_settle: Option<Box<Account<'info, PositionSettle>>>,
    #[account(mut)]
    pub proposer_output_ata: Option<Box<InterfaceAccount<'info, ITokenAccount>>>,
    #[account(mut)]
    pub tax_reserve_output_ata: Option<Box<InterfaceAccount<'info, ITokenAccount>>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    /// Caller: authorized bot or vault owner
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// UserVault PDA — gas deducted from here
    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        constraint = position.user_vault == user_vault.key() @ CoreError::Unauthorized
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

    #[account(mut, constraint = user_token_x.owner == user_vault.key() @ CoreError::InvalidTokenOwner)]
    pub user_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = user_token_y.owner == user_vault.key() @ CoreError::InvalidTokenOwner)]
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

// ============ USER VAULT CONTEXTS ============

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: The real wallet owner. Not required to be signer — PDA seed enforcement
    /// means the vault is cryptographically bound to this pubkey regardless.
    pub owner: AccountInfo<'info>,

    #[account(
        init,
        payer = payer,
        space = UserVault::SIZE,
        seeds = [b"user_vault", owner.key().as_ref()],
        bump
    )]
    pub user_vault: Account<'info, UserVault>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Account<'info, UserVault>,

    /// CHECK: Must be vault owner. Receives SOL.
    #[account(mut, constraint = owner.key() == user_vault.owner @ CoreError::InvalidVaultOwner)]
    pub owner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct WithdrawToken<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Account<'info, UserVault>,

    /// CHECK: Token mint for decimals
    pub token_mint: AccountInfo<'info>,

    #[account(mut, constraint = vault_token_account.owner == user_vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_account.owner == user_vault.owner @ CoreError::InvalidTokenOwner)]
    pub owner_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token program — must be SPL Token or Token-2022
    #[account(constraint = *token_program.key == anchor_spl::token::ID || *token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,
}

// ============ TREASURY TOKEN MOVEMENT CONTEXTS ============
// Governance-only: caller is the user_vault.owner (NTP for the treasury vault),
// signed via SPL Governance invoke_signed. Distinct from `withdraw_token` so the
// addin whitelist can grant Path B proposals access without exposing the
// dual-caller (bot|owner) Path A withdraw surface.

#[derive(Accounts)]
pub struct DepositTreasuryToken<'info> {
    /// Must equal `user_vault.owner`. For the treasury vault that's the
    /// Native Treasury PDA, signable only via SPL Governance executeTransaction.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Account<'info, UserVault>,

    /// CHECK: Token mint for decimals
    pub token_mint: AccountInfo<'info>,

    /// Source: caller-owned ATA (for treasury vault, this is NTP's direct ATA —
    /// the one Realms displays).
    #[account(mut, constraint = owner_token_account.owner == caller.key() @ CoreError::InvalidTokenOwner)]
    pub owner_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// Destination: vault PDA's ATA.
    #[account(mut, constraint = vault_token_account.owner == user_vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token program — must be SPL Token or Token-2022
    #[account(constraint = *token_program.key == anchor_spl::token::ID || *token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct WithdrawTreasuryToken<'info> {
    /// Must equal `user_vault.owner`. For the treasury vault that's the
    /// Native Treasury PDA, signable only via SPL Governance executeTransaction.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Account<'info, UserVault>,

    /// CHECK: Token mint for decimals
    pub token_mint: AccountInfo<'info>,

    /// Source: vault PDA's ATA. Authority is the vault PDA (signed by seeds).
    #[account(mut, constraint = vault_token_account.owner == user_vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// Destination: caller-owned ATA (for treasury vault, this is NTP's direct
    /// ATA — restores Realms-visible reserves).
    #[account(mut, constraint = owner_token_account.owner == caller.key() @ CoreError::InvalidTokenOwner)]
    pub owner_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token program — must be SPL Token or Token-2022
    #[account(constraint = *token_program.key == anchor_spl::token::ID || *token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct DrainTreasuryNativeToNtp<'info> {
    /// Must equal `user_vault.owner` (NTP for the treasury vault). Signable
    /// only via SPL Governance executeTransaction; the proposal-whitelist-addin
    /// must list this ix on the registrar whitelist for the proposal to pass.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Account<'info, UserVault>,
}

// ============ SOL WRAPPING CONTEXT ============

#[derive(Accounts)]
pub struct WrapSolInVault<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Account<'info, UserVault>,

    #[account(
        mut,
        token::mint = anchor_spl::token::spl_token::native_mint::ID,
        token::authority = user_vault,
    )]
    pub vault_wsol_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: SPL Token program (for sync_native — called separately after this ix)
    #[account(constraint = token_program.key() == anchor_spl::token::ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CancelExpiredTradeAuth<'info> {
    #[account(mut)]
    pub bot: Signer<'info>,

    #[account(
        mut,
        seeds = [b"trade_auth", trade_auth.user_vault.as_ref()],
        bump = trade_auth.bump,
        close = bot,
    )]
    pub trade_auth: Box<Account<'info, TradeAuth>>,
}

#[derive(Accounts)]
pub struct WrapCallerSol<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        token::mint = anchor_spl::token::spl_token::native_mint::ID,
        token::authority = caller,
    )]
    pub caller_wsol_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: SPL Token program — must be legacy SPL Token (WSOL is legacy)
    #[account(constraint = token_program.key() == anchor_spl::token::ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnwrapWsolInVault<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Account<'info, UserVault>,

    #[account(
        mut,
        token::mint = anchor_spl::token::spl_token::native_mint::ID,
        token::authority = user_vault,
    )]
    pub vault_wsol_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: SPL Token program (for close_account)
    #[account(constraint = *token_program.key == anchor_spl::token::ID || *token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,
}

// ============ CPI WRAPPER CONTEXTS ============




// ============ TREASURY-MATCH PAYOUT CONTEXTS ============

#[derive(Accounts)]
pub struct UpdatePayoutConfig<'info> {
    /// payout_admin — initially Config.authority (FFwq), transferred to
    /// Native Treasury PDA at realm bootstrap. Post-transfer, only
    /// governance-driven invocations satisfy this signer constraint.
    #[account(constraint = payout_admin.key() == config.payout_admin @ CoreError::UnauthorizedPayoutAdmin)]
    pub payout_admin: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct RecordSettleMeta<'info> {
    /// Bot or vault.owner — same dual-caller pattern as user_close.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: Meteora position pubkey — must match position.meteora_position
    #[account(constraint = meteora_position.key() == position.meteora_position @ CoreError::InvalidPosition)]
    pub meteora_position: AccountInfo<'info>,

    #[account(
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        constraint = position.user_vault == user_vault.key() @ CoreError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(
        init,
        payer = caller,
        space = PositionSettle::SIZE,
        seeds = [b"pos_settle", meteora_position.key().as_ref()],
        bump,
    )]
    pub position_settle: Box<Account<'info, PositionSettle>>,

    /// CHECK: tokenX mint of the position's lb_pair. Bot supplies; keeper
    /// validator off-chain ensures the values are correct. Worst case for a
    /// dishonest bot: settle_proposer at close fails or returns 0 payout.
    /// No drain risk because the SPL Token transfer enforces ATA ownership.
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: tokenY mint of the position's lb_pair. Same trust model as token_x_mint.
    pub token_y_mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleProposer<'info> {
    /// Bot or vault.owner — dual-caller, mirrors user_close.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// Treasury user_vault — vault.owner check is implicit via PDA seeding,
    /// authorization checked in handler against caller.
    #[account(
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(
        mut,
        seeds = [b"pos_settle", meteora_position.key().as_ref()],
        bump = position_settle.bump,
    )]
    pub position_settle: Box<Account<'info, PositionSettle>>,

    /// Per-position vault PDA — signs the SPL Token transfer to proposer.
    #[account(
        seeds = [b"vault", meteora_position.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: Meteora position pubkey — used as PDA seed for both vault and position_settle
    pub meteora_position: AccountInfo<'info>,

    /// Position vault's ATA for the output mint (tokens transferred FROM here).
    #[account(mut, constraint = position_vault_output_ata.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub position_vault_output_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// Proposer's ATA for the output mint (tokens transferred TO here).
    /// Owner-equality check (== position_settle.proposer) is in the handler.
    #[account(mut)]
    pub proposer_output_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// Tax reserve's ATA for the output mint. Optional — only required when
    /// `Config.tax_reserve != default && Config.tax_bps > 0`. Owner-equality
    /// check (== Config.tax_reserve) runs in the handler.
    #[account(mut)]
    pub tax_reserve_output_ata: Option<Box<InterfaceAccount<'info, ITokenAccount>>>,

    pub output_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: SPL Token / Token-2022 program for the output mint
    #[account(constraint = *token_program.key == anchor_spl::token::ID || *token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ExpandConfigV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: PDA derivation enforces this is the canonical Config account.
    /// Authority byte-check happens in the handler since the v2 layout
    /// can't deserialize a v1-sized account.
    #[account(mut, seeds = [b"config"], bump)]
    pub config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseSettle<'info> {
    /// Bot or vault.owner — dual-caller.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(
        mut,
        close = user_vault,
        seeds = [b"pos_settle", meteora_position.key().as_ref()],
        bump = position_settle.bump,
    )]
    pub position_settle: Box<Account<'info, PositionSettle>>,

    /// CHECK: Meteora position pubkey — PDA seed only
    pub meteora_position: AccountInfo<'info>,
}

// ============ TREASURY MARKER PATTERN CONTEXTS ============

#[derive(Accounts)]
pub struct AuthorizeTreasuryOpen<'info> {
    /// Must equal `user_vault.owner`. For the treasury vault that's NTP,
    /// signable only via SPL Governance executeTransaction.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    /// CHECK: lb_pair pubkey — recorded into TradeAuth, validated at consume time
    pub lb_pair: AccountInfo<'info>,

    #[account(
        init,
        payer = caller,
        space = TradeAuth::SIZE,
        seeds = [b"trade_auth", user_vault.key().as_ref()],
        bump,
    )]
    pub trade_auth: Box<Account<'info, TradeAuth>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorizeTreasuryClose<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    /// CHECK: lb_pair pubkey — recorded into TradeAuth
    pub lb_pair: AccountInfo<'info>,

    #[account(
        init,
        payer = caller,
        space = TradeAuth::SIZE,
        seeds = [b"trade_auth", user_vault.key().as_ref()],
        bump,
    )]
    pub trade_auth: Box<Account<'info, TradeAuth>>,

    pub system_program: Program<'info, System>,
}

/// Account context for `treasury_open_combined`. Superset of OpenPositionV2:
/// + caller_token_account (vault.owner's direct ATA, source of deposit)
/// + deposit_token_mint, deposit_token_program (Token-2022 for CRANK)
/// + position_settle (init, mirrors RecordSettleMeta)
/// + trade_auth (mut, close = bot)
#[derive(Accounts)]
pub struct TreasuryOpenCombined<'info> {
    #[account(mut)]
    pub bot: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: Validated by Meteora CPI
    #[account(mut)]
    pub lb_pair: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = bot,
        space = PositionCounter::SIZE,
        seeds = [b"pos_counter", user_vault.key().as_ref(), lb_pair.key().as_ref()],
        bump
    )]
    pub position_counter: Account<'info, PositionCounter>,

    /// CHECK: PDA signed via invoke_signed
    #[account(
        mut,
        seeds = [b"meteora_pos", user_vault.key().as_ref(), lb_pair.key().as_ref(), &position_counter.count.to_le_bytes()],
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
        payer = bot,
        space = Position::SIZE,
        seeds = [b"position", meteora_position.key().as_ref()],
        bump
    )]
    pub position: Box<Account<'info, Position>>,

    #[account(
        init,
        payer = bot,
        space = Vault::SIZE,
        seeds = [b"vault", meteora_position.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: User vault's deposit token ATA. Validated in handler.
    #[account(mut)]
    pub user_vault_deposit_ata: AccountInfo<'info>,

    /// CHECK: Position vault's token X account. Validated in handler.
    #[account(mut)]
    pub vault_token_x: AccountInfo<'info>,

    /// CHECK: Position vault's token Y account. Validated in handler.
    #[account(mut)]
    pub vault_token_y: AccountInfo<'info>,

    /// CHECK: Token X program — SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,

    /// CHECK: Token Y program — SPL Token or Token-2022
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Bin array lower
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,

    /// CHECK: Bin array upper
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    /// CHECK: Meteora event authority
    pub event_authority: UncheckedAccount<'info>,

    /// CHECK: Meteora DLMM program — validated in handler body
    pub dlmm_program: UncheckedAccount<'info>,

    /// CHECK: Token X mint — passed through to Meteora CPI
    pub token_x_mint: UncheckedAccount<'info>,

    /// CHECK: Token Y mint — passed through to Meteora CPI
    pub token_y_mint: UncheckedAccount<'info>,

    // ---- Treasury-specific deposit accounts ----

    /// Source: vault.owner's direct ATA (NTP's CRANK or WSOL ATA).
    /// Bot must have been pre-approved as Token-2022 delegate over this ATA
    /// via a one-time governance proposal (see Phase 7 of marker plan).
    #[account(mut)]
    pub caller_token_account: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Mint of the deposit token. Decimals read at runtime;
    /// transfer_checked enforces mint match against caller_token_account.
    pub deposit_token_mint: AccountInfo<'info>,

    /// CHECK: Token program for deposit (must be SPL Token or Token-2022)
    #[account(constraint = *deposit_token_program.key == anchor_spl::token::ID || *deposit_token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub deposit_token_program: AccountInfo<'info>,

    // ---- PositionSettle (mirrors RecordSettleMeta) ----

    #[account(
        init,
        payer = bot,
        space = PositionSettle::SIZE,
        seeds = [b"pos_settle", meteora_position.key().as_ref()],
        bump,
    )]
    pub position_settle: Box<Account<'info, PositionSettle>>,

    // ---- TradeAuth (consumed) ----

    #[account(
        mut,
        seeds = [b"trade_auth", user_vault.key().as_ref()],
        bump = trade_auth.bump,
        close = bot,
    )]
    pub trade_auth: Box<Account<'info, TradeAuth>>,
}

/// Account context for `treasury_close_combined`. Superset of UserClose:
/// + position_settle (mut, close = user_vault), output_mint, proposer_output_ata,
///   tax_reserve_output_ata, output_token_program (mirrors SettleProposer)
/// + trade_auth (mut, close = bot)
#[derive(Accounts)]
pub struct TreasuryCloseCombined<'info> {
    #[account(mut)]
    pub bot: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [b"user_vault", user_vault.owner.as_ref()],
        bump = user_vault.bump,
    )]
    pub user_vault: Box<Account<'info, UserVault>>,

    /// Closed manually in handler (lamports → bot, discriminator zeroed) to
    /// avoid Anchor close = X stack pressure in try_accounts (4KB BPF ceiling).
    #[account(
        mut,
        seeds = [b"position", position.meteora_position.as_ref()],
        bump = position.bump,
        constraint = position.user_vault == user_vault.key() @ CoreError::Unauthorized,
    )]
    pub position: Box<Account<'info, Position>>,

    /// Closed manually in handler (see `position`).
    #[account(
        mut,
        seeds = [b"vault", position.meteora_position.as_ref()],
        bump = vault.bump
    )]
    pub vault: Box<Account<'info, Vault>>,

    /// CHECK: Meteora position
    #[account(mut, constraint = meteora_position.key() == position.meteora_position @ CoreError::InvalidPosition)]
    pub meteora_position: AccountInfo<'info>,

    /// CHECK: DLMM pool — bound by TradeAuth
    #[account(mut, constraint = lb_pair.key() == position.lb_pair @ CoreError::InvalidPool)]
    pub lb_pair: AccountInfo<'info>,

    /// CHECK: Bitmap ext
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

    /// CHECK: Token X mint
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: Token Y mint
    pub token_y_mint: UncheckedAccount<'info>,

    /// CHECK: Event authority
    pub event_authority: AccountInfo<'info>,

    /// CHECK: DLMM program
    #[account(constraint = dlmm_program.key() == METEORA_DLMM_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub dlmm_program: AccountInfo<'info>,

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// NTP's direct token-X ATA (CRANK for CRANK/SOL pool). Residue X transfers
    /// here on close — Realms-visible. Owner+mint constrained on-chain.
    #[account(mut,
        constraint = ntp_token_x_ata.owner == user_vault.owner @ CoreError::InvalidTokenOwner,
        constraint = ntp_token_x_ata.mint == token_x_mint.key() @ CoreError::InvalidTokenOwner)]
    pub ntp_token_x_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: must equal user_vault.owner (NTP). Lamport destination for
    /// WSOL ATA close — auto-unwraps WSOL balance into NTP's native SOL.
    #[account(mut, constraint = ntp_sol_account.key() == user_vault.owner @ CoreError::Unauthorized)]
    pub ntp_sol_account: AccountInfo<'info>,

    /// CHECK: validated against Config.fee_dest in handler
    pub fee_dest: AccountInfo<'info>,

    #[account(mut, constraint = fee_dest_token_x.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = fee_dest_token_y.owner == fee_dest.key() @ CoreError::InvalidTokenOwner)]
    pub fee_dest_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    /// CHECK: Token X program — SPL Token or Token-2022
    #[account(constraint = *token_x_program.key == anchor_spl::token::ID || *token_x_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_x_program: AccountInfo<'info>,
    /// CHECK: Token Y program
    #[account(constraint = *token_y_program.key == anchor_spl::token::ID || *token_y_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub token_y_program: AccountInfo<'info>,

    /// CHECK: SPL Memo program (required for Token-2022 V2 CPI)
    #[account(constraint = memo_program.key() == SPL_MEMO_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub memo_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    // ---- Settle accounts ----

    /// Closed manually in handler (see `position`).
    #[account(
        mut,
        seeds = [b"pos_settle", meteora_position.key().as_ref()],
        bump = position_settle.bump,
    )]
    pub position_settle: Box<Account<'info, PositionSettle>>,

    pub output_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut, constraint = position_vault_output_ata.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub position_vault_output_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut)]
    pub proposer_output_ata: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut)]
    pub tax_reserve_output_ata: Option<Box<InterfaceAccount<'info, ITokenAccount>>>,

    /// CHECK: Token program for the OUTPUT mint (may differ from token_x/y_program if needed)
    #[account(constraint = *output_token_program.key == anchor_spl::token::ID || *output_token_program.key == TOKEN_2022_PROGRAM_ID @ CoreError::InvalidProgram)]
    pub output_token_program: AccountInfo<'info>,

    // ---- TradeAuth (consumed) ----

    #[account(
        mut,
        seeds = [b"trade_auth", user_vault.key().as_ref()],
        bump = trade_auth.bump,
        close = bot,
    )]
    pub trade_auth: Box<Account<'info, TradeAuth>>,
}

// ============ ADMIN CONTEXTS ============

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = authority.key() == config.authority @ CoreError::Unauthorized)]
    pub authority: Signer<'info>,

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
    #[account(constraint = owner.key() == position.user_vault @ CoreError::Unauthorized)]
    pub owner: AccountInfo<'info>,

    #[account(mut, constraint = vault_token_x.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = vault_token_y.owner == vault.key() @ CoreError::InvalidTokenOwner)]
    pub vault_token_y: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_x.owner == position.user_vault @ CoreError::InvalidTokenOwner)]
    pub owner_token_x: Box<InterfaceAccount<'info, ITokenAccount>>,

    #[account(mut, constraint = owner_token_y.owner == position.user_vault @ CoreError::InvalidTokenOwner)]
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



// ============ ERRORS ============

#[error_code]
pub enum CoreError {
    #[msg("Not authorized")]
    Unauthorized,
    #[msg("gas_lamports exceeds MAX_GAS_LAMPORTS")]
    GasLamportsTooHigh,
    #[msg("rent_lamports exceeds MAX_RENT_DEDUCT_LAMPORTS")]
    RentLamportsTooHigh,
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
    #[msg("Invalid trader destination")]
    InvalidTraderDest,
    #[msg("Trader destination not set — call set_trader_dest first")]
    TraderDestNotSet,
    #[msg("Trader destination already set — use propose_trader_dest for changes")]
    TraderDestAlreadySet,
    #[msg("Insufficient vault balance for withdrawal")]
    InsufficientBalance,
    #[msg("Invalid vault owner — does not match PDA seed")]
    InvalidVaultOwner,
    #[msg("Caller must be authorized bot or vault owner")]
    UnauthorizedCaller,
    #[msg("Invalid external program ID")]
    InvalidExternalProgram,
    #[msg("Burn curve already initialized — initial_crank_supply is immutable")]
    BurnCurveAlreadyInitialized,
    #[msg("Burn curve not initialized — call initialize_burn_curve first")]
    BurnCurveNotInitialized,
    #[msg("CRANK mint account does not match expected mint")]
    InvalidCrankMint,
    #[msg("Invalid burn SOL vault PDA")]
    InvalidBurnSolVault,
    #[msg("Fee destination account does not match Config.fee_dest (or Config.bot if unset)")]
    InvalidFeeDest,
    #[msg("PositionSettle is already settled (settle_proposer was called)")]
    AlreadySettled,
    #[msg("PositionSettle has not been settled yet — call settle_proposer first")]
    NotSettled,
    #[msg("output_mint argument does not match PositionSettle.output_mint recorded at open")]
    OutputMintMismatch,
    #[msg("Proposer ATA owner does not match PositionSettle.proposer")]
    InvalidProposer,
    #[msg("Caller does not match Config.payout_admin")]
    UnauthorizedPayoutAdmin,
    #[msg("payout_bps exceeds maximum (5000 bps = 50%)")]
    PayoutBpsTooHigh,
    #[msg("match_ratio_bps exceeds maximum (50000 bps = 5x)")]
    MatchRatioTooHigh,
    #[msg("Payout config already initialized — use update_payout_config / set_payout_admin")]
    PayoutAdminAlreadyInitialized,
    #[msg("Tax reserve ATA missing or owner mismatch")]
    InvalidTaxReserveAta,
    #[msg("TradeAuth has expired")]
    TradeAuthExpired,
    #[msg("TradeAuth has not yet expired — cannot cancel")]
    TradeAuthNotExpired,
    #[msg("TradeAuth bot does not match Config.bot")]
    TradeAuthBotMismatch,
    #[msg("TradeAuth user_vault does not match passed vault")]
    TradeAuthVaultMismatch,
    #[msg("TradeAuth lb_pair does not match passed pool")]
    TradeAuthPoolMismatch,
    #[msg("TradeAuth action mismatch (open/close)")]
    TradeAuthActionMismatch,
    #[msg("TradeAuth source ATA must be vault.owner's direct ATA")]
    TradeAuthSourceAtaMismatch,
    #[msg("TradeAuth side byte invalid (must be 0=Sell or 1=Buy)")]
    TradeAuthInvalidSide,
    #[msg("position_settle was passed but proposer_output_ata is missing")]
    MissingProposerAta,
}
