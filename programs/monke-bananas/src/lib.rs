// monke_bananas — crank.money revenue share program
//
// Burn $BANANAS (1M per tx, unlimited stacking) against SMB Gen2 or Gen3 NFTs.
// Each burn increments the NFT's weight in the global revenue pool.
// Gen2 burns add 2 weight per feed. Gen3 burns add 1 weight per feed.
// Whoever holds the SMB NFT at claim time receives SOL.
// Weight and unclaimed SOL travel with the NFT on secondary markets.
//
// Architecture: MasterChef-style pull-based accumulator
//   Keeper calls deposit_sol once per distribution. Updates global accumulator. O(1).
//   Holders call claim whenever they want. O(1).
//   Weight changes (new burns) settle pending rewards before incrementing.
//
// SMB Gen2 collection: SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W (2x weight)
// SMB Gen3 collection: 8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH (1x weight)
//
// Security:
//   - claim always works even when paused — holders never locked out
//   - deposit_sol is permissionless — anyone can call
//   - $BANANAS burn is permanent via token::burn CPI
//   - NFT collection validated on every feed (Metaplex metadata deserialization)
//   - NFT ownership validated via token account balance check (works after transfer)
//   - Weight changes settle pending rewards before incrementing (no retroactive earnings)
//   - Two-step authority transfer
//   - u128 accumulator scaled by 1e12 — no overflow in realistic scenarios
//   - init_if_needed for MonkeBurn PDA (first burn creates, subsequent burns increment)

#![deny(clippy::unwrap_used)]
#![deny(clippy::integer_arithmetic)]

use anchor_lang::prelude::*;
// Direct lamport manipulation used instead of system_instruction + invoke_signed
// (program-owned PDAs can't use system transfers)
use anchor_spl::token_interface::{
    Burn, burn, Mint, TokenAccount, TokenInterface, Transfer, transfer,
};

declare_id!("myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH");

/// Precision scale factor for accumulator math.
/// accumulated_sol_per_share is stored as a u128 scaled by this factor.
pub const PRECISION: u128 = 1_000_000_000_000; // 1e12

/// Minimum SOL to trigger deposit (0.01 SOL)
pub const MIN_DEPOSIT_LAMPORTS: u64 = 10_000_000;

/// Burn amount per feed_monke call: exactly 1,000,000 tokens (in base units).
/// Assumes $BANANAS has some number of decimals — this constant should be
/// adjusted to reflect 1M human-readable tokens in base units.
/// For a 6-decimal token: 1_000_000 * 1_000_000 = 1_000_000_000_000
/// For a 9-decimal token: 1_000_000 * 1_000_000_000 = 1_000_000_000_000_000
/// Set at initialization via `bananas_decimals` or hardcode after token launch.
pub const BANANAS_PER_FEED: u64 = 1_000_000_000_000; // 1M tokens with 6 decimals

/// Metaplex Token Metadata program ID (mainnet)
pub const MPL_TOKEN_METADATA_ID: Pubkey = anchor_lang::solana_program::pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/// Metaplex Core program ID (mainnet)
pub const MPL_CORE_PROGRAM_ID: Pubkey = anchor_lang::solana_program::pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

/// gooseswtf pixel goose collection (pNFT, Token Metadata)
pub const GOOSE_PIXEL_COLLECTION: Pubkey = anchor_lang::solana_program::pubkey!("6ubyyuUz3EVFwZrBh3C2ezSXXfyjxP4jhemLPyGgdL6Y");

/// GooseDAO membership collection (Metaplex Core)
pub const GOOSE_DAO_COLLECTION: Pubkey = anchor_lang::solana_program::pubkey!("XkH2QVN9AKNi1AGnaEYdEHCHxFjTjs8BdbTJfcRW2rY");

/// Offset into Metaplex metadata account data where the Collection field lives.
/// Metaplex metadata v1.1+ layout (after header):
///   key(1) + update_authority(32) + mint(32) + name(36) + symbol(14) + uri(204)
///   + seller_fee_basis_points(2) + creators_option(1) + [creators...] + ...
/// The collection field location varies by creators length. We parse dynamically.
///
/// Collection struct: Option<Collection> where Collection = { verified: bool, key: Pubkey }

#[program]
pub mod monke_bananas {
    use super::*;

    /// Initialize the monke_bananas program. Called once by authority.
    pub fn initialize(
        ctx: Context<Initialize>,
        dist_pool: Pubkey,
        smb_collection: Pubkey,
        smb_gen3_collection: Pubkey,
    ) -> Result<()> {
        // Validate $BANANAS mint has 6 decimals (BANANAS_PER_FEED assumes this)
        require!(ctx.accounts.bananas_mint.decimals == 6, MonkeError::InvalidMint);

        let state = &mut ctx.accounts.state;
        state.authority = ctx.accounts.authority.key();
        state.pending_authority = Pubkey::default();
        state.bananas_mint = ctx.accounts.bananas_mint.key();
        state.smb_collection = smb_collection;
        state.smb_gen3_collection = smb_gen3_collection;
        state.dist_pool = dist_pool;
        state.program_vault_bump = ctx.bumps.program_vault;
        state.state_bump = ctx.bumps.state;
        state.dist_pool_bump = ctx.bumps.dist_pool;
        state.total_share_weight = 0;
        state.accumulated_sol_per_share = 0;
        state.total_sol_distributed = 0;
        state.total_bananas_burned = 0;
        state.paused = false;
        state.pegged_mint = Pubkey::default();
        state._reserved = [0u8; 32];

        msg!("monke_bananas initialized");
        msg!("BANANAS mint: {}", state.bananas_mint);
        msg!("SMB Gen2 collection: {}", smb_collection);
        msg!("SMB Gen3 collection: {}", smb_gen3_collection);
        msg!("Dist pool: {}", dist_pool);

        Ok(())
    }

    /// Feed your monke — burn 1M $BANANAS, stack weight on an SMB Gen2 NFT.
    ///
    /// First call for an NFT creates the MonkeBurn PDA (init_if_needed).
    /// Subsequent calls increment weight. Pending rewards are settled before
    /// weight change to prevent retroactive earnings (MasterChef pattern).
    pub fn feed_monke(ctx: Context<FeedMonke>) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, MonkeError::Paused);

        // 1. Validate NFT is from SMB Gen2 or Gen3 collection.
        //    Returns weight multiplier: 2 for Gen2, 1 for Gen3.
        let weight_multiplier = validate_collection_and_weight(
            &ctx.accounts.nft_metadata,
            &ctx.accounts.nft_mint.key(),
            &state.smb_collection,
            &state.smb_gen3_collection,
        )?;

        // 2. Validate caller holds the NFT
        require!(
            ctx.accounts.user_nft_account.amount == 1,
            MonkeError::NotNftHolder
        );
        require!(
            ctx.accounts.user_nft_account.owner == ctx.accounts.user.key(),
            MonkeError::NotNftHolder
        );

        // 3. Burn exactly BANANAS_PER_FEED $BANANAS
        let burn_cpi = Burn {
            mint: ctx.accounts.bananas_mint.to_account_info(),
            from: ctx.accounts.user_bananas_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), burn_cpi),
            BANANAS_PER_FEED,
        )?;

        // 4. MasterChef settlement + weight increment.
        //    reward_debt is stored in the same PRECISION-scaled units as
        //    (weight * accumulated_sol_per_share). All math stays in that scale
        //    until the final claim division to avoid precision loss.
        let monke_burn = &mut ctx.accounts.monke_burn;
        let accumulated = state.accumulated_sol_per_share;

        if monke_burn.share_weight == 0 {
            // First burn — initialize the PDA fields
            monke_burn.nft_mint = ctx.accounts.nft_mint.key();
            monke_burn.first_fed_at = Clock::get()?.unix_timestamp;
            monke_burn.claimed_sol = 0;
            monke_burn.reward_debt = 0;
        }

        // Calculate pending rewards at current weight (PRECISION-scaled)
        let pending_scaled = (monke_burn.share_weight as u128)
            .checked_mul(accumulated).ok_or(MonkeError::Overflow)?
            .checked_sub(monke_burn.reward_debt).unwrap_or(0);

        // 5. Increment weight (Gen2 = +2, Gen3 = +1)
        monke_burn.share_weight = monke_burn.share_weight
            .checked_add(weight_multiplier).ok_or(MonkeError::Overflow)?;

        // 6. Update reward_debt for new weight, preserving pending rewards.
        //    new_debt = new_weight * accumulated - pending_scaled
        //    This ensures the pending amount earned before this burn is still
        //    claimable, while the new weight unit starts earning from now.
        let new_entitled = (monke_burn.share_weight as u128)
            .checked_mul(accumulated).ok_or(MonkeError::Overflow)?;
        monke_burn.reward_debt = new_entitled
            .checked_sub(pending_scaled).unwrap_or(0);

        // 7. Update global state
        let state = &mut ctx.accounts.state;
        state.total_share_weight = state.total_share_weight
            .checked_add(weight_multiplier).ok_or(MonkeError::Overflow)?;
        state.total_bananas_burned = state.total_bananas_burned
            .checked_add(BANANAS_PER_FEED).ok_or(MonkeError::Overflow)?;

        emit!(FeedEvent {
            user: ctx.accounts.user.key(),
            nft_mint: ctx.accounts.nft_mint.key(),
            new_weight: monke_burn.share_weight,
            total_weight: state.total_share_weight,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Monke fed: nft={}, weight={} (+{}), total_weight={}",
            monke_burn.nft_mint, monke_burn.share_weight, weight_multiplier, state.total_share_weight);

        Ok(())
    }

    /// Feed a gooseswtf pixel goose. Burns BANANAS_PER_FEED and increments weight by 1.
    /// On first feed (share_weight == 0), GooseDAO Core membership is required.
    /// On subsequent feeds, membership is not checked (once in, always in).
    pub fn feed_goose(ctx: Context<FeedGoose>) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(!state.paused, MonkeError::Paused);

        // 1. Validate pixel goose is from gooseswtf collection
        validate_goose_pixel_collection(
            &ctx.accounts.goose_nft_metadata,
            &ctx.accounts.goose_nft_mint.key(),
        )?;

        // 2. Once-in-always-in gate: only check GooseDAO membership on first feed
        let monke_burn = &ctx.accounts.monke_burn;
        if monke_burn.share_weight == 0 {
            validate_goose_dao_membership(
                &ctx.accounts.goose_dao_asset,
                &ctx.accounts.user.key(),
            )?;
        }

        // 3. Burn exactly BANANAS_PER_FEED $BANANAS
        let burn_cpi = Burn {
            mint: ctx.accounts.bananas_mint.to_account_info(),
            from: ctx.accounts.user_bananas_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), burn_cpi),
            BANANAS_PER_FEED,
        )?;

        // 4. MasterChef settlement + weight increment (identical to feed_monke)
        let monke_burn = &mut ctx.accounts.monke_burn;
        let accumulated = state.accumulated_sol_per_share;

        if monke_burn.share_weight == 0 {
            monke_burn.nft_mint = ctx.accounts.goose_nft_mint.key();
            monke_burn.first_fed_at = Clock::get()?.unix_timestamp;
            monke_burn.claimed_sol = 0;
            monke_burn.reward_debt = 0;
        }

        let pending_scaled = (monke_burn.share_weight as u128)
            .checked_mul(accumulated).ok_or(MonkeError::Overflow)?
            .checked_sub(monke_burn.reward_debt).unwrap_or(0);

        let weight_increment: u64 = 1;
        monke_burn.share_weight = monke_burn.share_weight
            .checked_add(weight_increment).ok_or(MonkeError::Overflow)?;

        let new_entitled = (monke_burn.share_weight as u128)
            .checked_mul(accumulated).ok_or(MonkeError::Overflow)?;
        monke_burn.reward_debt = new_entitled
            .checked_sub(pending_scaled).unwrap_or(0);

        // 5. Update global state
        let state = &mut ctx.accounts.state;
        state.total_share_weight = state.total_share_weight
            .checked_add(weight_increment).ok_or(MonkeError::Overflow)?;
        state.total_bananas_burned = state.total_bananas_burned
            .checked_add(BANANAS_PER_FEED).ok_or(MonkeError::Overflow)?;

        emit!(FeedEvent {
            user: ctx.accounts.user.key(),
            nft_mint: ctx.accounts.goose_nft_mint.key(),
            new_weight: monke_burn.share_weight,
            total_weight: state.total_share_weight,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Goose fed: nft={}, weight={}, total_weight={}",
            monke_burn.nft_mint, monke_burn.share_weight, state.total_share_weight);

        Ok(())
    }

    /// Deposit SOL from dist_pool into the program vault. Permissionless.
    /// Updates the global accumulator so all monke holders can claim their share.
    /// Typically called by the keeper on Saturday, but anyone can call anytime.
    pub fn deposit_sol(ctx: Context<DepositSol>) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(state.total_share_weight > 0, MonkeError::NoMonkes);

        // Calculate distributable SOL from dist_pool (minus rent-exempt minimum)
        let pool_balance = ctx.accounts.dist_pool.lamports();
        let rent = Rent::get()?.minimum_balance(0);
        let distributable = pool_balance.saturating_sub(rent);
        require!(distributable >= MIN_DEPOSIT_LAMPORTS, MonkeError::NothingToDeposit);

        // Direct lamport manipulation instead of system_instruction::transfer.
        // dist_pool is program-owned (PDA of this program), not system-owned.
        // system_instruction::transfer requires system-owned source — would fail at runtime.
        **ctx.accounts.dist_pool.try_borrow_mut_lamports()? -= distributable;
        **ctx.accounts.program_vault.try_borrow_mut_lamports()? += distributable;

        // Update accumulator: add (deposit * PRECISION / total_weight)
        let increment = (distributable as u128)
            .checked_mul(PRECISION).ok_or(MonkeError::Overflow)?
            .checked_div(state.total_share_weight as u128).ok_or(MonkeError::Overflow)?;

        let state = &mut ctx.accounts.state;
        state.accumulated_sol_per_share = state.accumulated_sol_per_share
            .checked_add(increment).ok_or(MonkeError::Overflow)?;
        state.total_sol_distributed = state.total_sol_distributed
            .checked_add(distributable).ok_or(MonkeError::Overflow)?;

        emit!(DepositEvent {
            amount: distributable,
            total_distributed: state.total_sol_distributed,
            accumulator: state.accumulated_sol_per_share,
            total_share_weight: state.total_share_weight,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Deposited {} lamports, accumulator={}", distributable, state.accumulated_sol_per_share);

        Ok(())
    }

    /// Deposit $PEGGED from dist_pool ATA into program vault ATA. Permissionless.
    /// Replaces deposit_sol for the $PEGGED flow. Same accumulator math, different transfer mechanism.
    pub fn deposit_pegged(ctx: Context<DepositPegged>) -> Result<()> {
        let state = &ctx.accounts.state;
        require!(state.total_share_weight > 0, MonkeError::NoMonkes);
        require!(state.pegged_mint != Pubkey::default(), MonkeError::PeggedNotConfigured);

        let distributable = ctx.accounts.dist_pool_pegged_ata.amount;
        require!(distributable >= MIN_DEPOSIT_LAMPORTS, MonkeError::NothingToDeposit);

        // CPI transfer from dist_pool ATA → program_vault ATA
        // dist_pool PDA signs as the token account authority
        let bump = state.dist_pool_bump;
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.dist_pool_pegged_ata.to_account_info(),
                    to: ctx.accounts.program_vault_pegged_ata.to_account_info(),
                    authority: ctx.accounts.dist_pool.to_account_info(),
                },
                &[&[b"dist_pool", &[bump]]],
            ),
            distributable,
        )?;

        // Accumulator math unchanged — units shift from lamports to $PEGGED base units,
        // formula is identical (both are u64 amounts, PRECISION scaling handles the rest)
        let increment = (distributable as u128)
            .checked_mul(PRECISION).ok_or(MonkeError::Overflow)?
            .checked_div(state.total_share_weight as u128).ok_or(MonkeError::Overflow)?;

        let state = &mut ctx.accounts.state;
        state.accumulated_sol_per_share = state.accumulated_sol_per_share
            .checked_add(increment).ok_or(MonkeError::Overflow)?;
        state.total_sol_distributed = state.total_sol_distributed
            .checked_add(distributable).ok_or(MonkeError::Overflow)?;

        emit!(DepositEvent {
            amount: distributable,
            total_distributed: state.total_sol_distributed,
            accumulator: state.accumulated_sol_per_share,
            total_share_weight: state.total_share_weight,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Deposited {} $PEGGED, accumulator={}", distributable, state.accumulated_sol_per_share);
        Ok(())
    }

    /// Claim accumulated SOL for a monke. Caller must hold the SMB Gen2 NFT.
    /// Always works even when paused — holders can never be locked out.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        // Validate NFT ownership: caller holds the token (balance = 1)
        require!(
            ctx.accounts.user_nft_account.amount == 1,
            MonkeError::NotNftHolder
        );
        require!(
            ctx.accounts.user_nft_account.owner == ctx.accounts.user.key(),
            MonkeError::NotNftHolder
        );

        let monke_burn = &ctx.accounts.monke_burn;
        let state = &ctx.accounts.state;

        // MasterChef formula: owed = (weight * accumulator - reward_debt) / PRECISION
        // Subtraction happens in PRECISION-scaled units first, then one division.
        // This avoids precision loss from separate divisions.
        let pending_scaled = (monke_burn.share_weight as u128)
            .checked_mul(state.accumulated_sol_per_share).ok_or(MonkeError::Overflow)?
            .checked_sub(monke_burn.reward_debt).unwrap_or(0);

        let owed = pending_scaled
            .checked_div(PRECISION).unwrap_or(0) as u64;

        require!(owed > 0, MonkeError::NothingToClaim);

        // Direct lamport manipulation instead of system_instruction::transfer.
        // program_vault is program-owned (PDA), not system-owned.
        // Check rent-exempt minimum and sufficient balance
        let rent_minimum = Rent::get()?.minimum_balance(0);
        let vault_lamports = ctx.accounts.program_vault.lamports();
        require!(
            vault_lamports >= owed.checked_add(rent_minimum).ok_or(MonkeError::Overflow)?,
            MonkeError::InsufficientVaultBalance
        );

        **ctx.accounts.program_vault.try_borrow_mut_lamports()? -= owed;
        **ctx.accounts.user.try_borrow_mut_lamports()? += owed;

        // Update reward_debt and claimed_sol.
        // Set reward_debt = weight * accumulator so next claim starts from zero pending.
        // We subtract (owed * PRECISION) remainder to avoid rounding dust accumulation:
        // reward_debt = weight * accumulator - (pending_scaled - owed * PRECISION)
        // Simplified: reward_debt = weight * accumulator (standard MasterChef reset)
        let monke_burn = &mut ctx.accounts.monke_burn;
        monke_burn.reward_debt = (monke_burn.share_weight as u128)
            .checked_mul(state.accumulated_sol_per_share).ok_or(MonkeError::Overflow)?;
        monke_burn.claimed_sol = monke_burn.claimed_sol
            .checked_add(owed).ok_or(MonkeError::Overflow)?;

        emit!(ClaimEvent {
            user: ctx.accounts.user.key(),
            nft_mint: monke_burn.nft_mint,
            amount: owed,
            total_claimed: monke_burn.claimed_sol,
            share_weight: monke_burn.share_weight,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Claimed {} lamports for monke {}", owed, monke_burn.nft_mint);

        Ok(())
    }

    /// Claim accumulated $PEGGED for a monke. Replaces SOL claim after migration.
    /// Always works even when paused — holders can never be locked out.
    pub fn claim_pegged(ctx: Context<ClaimPegged>) -> Result<()> {
        require!(
            ctx.accounts.user_nft_account.amount == 1,
            MonkeError::NotNftHolder
        );
        require!(
            ctx.accounts.user_nft_account.owner == ctx.accounts.user.key(),
            MonkeError::NotNftHolder
        );

        let monke_burn = &ctx.accounts.monke_burn;
        let state = &ctx.accounts.state;
        require!(state.pegged_mint != Pubkey::default(), MonkeError::PeggedNotConfigured);

        let pending_scaled = (monke_burn.share_weight as u128)
            .checked_mul(state.accumulated_sol_per_share).ok_or(MonkeError::Overflow)?
            .checked_sub(monke_burn.reward_debt).unwrap_or(0);

        let owed = pending_scaled
            .checked_div(PRECISION).unwrap_or(0) as u64;

        require!(owed > 0, MonkeError::NothingToClaim);

        // CPI transfer from program_vault ATA → user's $PEGGED ATA
        let bump = state.program_vault_bump;
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.program_vault_pegged_ata.to_account_info(),
                    to: ctx.accounts.user_pegged_ata.to_account_info(),
                    authority: ctx.accounts.program_vault.to_account_info(),
                },
                &[&[b"program_vault", &[bump]]],
            ),
            owed,
        )?;

        let monke_burn = &mut ctx.accounts.monke_burn;
        monke_burn.reward_debt = (monke_burn.share_weight as u128)
            .checked_mul(state.accumulated_sol_per_share).ok_or(MonkeError::Overflow)?;
        monke_burn.claimed_sol = monke_burn.claimed_sol
            .checked_add(owed).ok_or(MonkeError::Overflow)?;

        emit!(ClaimEvent {
            user: ctx.accounts.user.key(),
            nft_mint: monke_burn.nft_mint,
            amount: owed,
            total_claimed: monke_burn.claimed_sol,
            share_weight: monke_burn.share_weight,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Claimed {} $PEGGED for monke {}", owed, monke_burn.nft_mint);
        Ok(())
    }

    // ─── ADMIN ───

    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.state.paused = true;
        msg!("monke_bananas paused");
        Ok(())
    }

    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.state.paused = false;
        msg!("monke_bananas unpaused");
        Ok(())
    }

    pub fn transfer_authority(
        ctx: Context<AdminOnly>,
        new_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.state.pending_authority = new_authority;
        msg!("Authority transfer proposed to {}", new_authority);
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.authority = state.pending_authority;
        state.pending_authority = Pubkey::default();
        msg!("Authority accepted");
        Ok(())
    }

    /// Set the $PEGGED mint address. Admin-only. Called once during migration
    /// from raw SOL distribution to $PEGGED LST distribution.
    pub fn set_pegged_mint(ctx: Context<AdminOnly>, pegged_mint: Pubkey) -> Result<()> {
        ctx.accounts.state.pegged_mint = pegged_mint;
        msg!("Pegged mint set to {}", pegged_mint);
        Ok(())
    }

    /// Set the burn mint address ($CRANK). Admin-only.
    /// Allows migrating to a new burn token without reinitializing state.
    pub fn set_bananas_mint(ctx: Context<AdminOnly>, new_mint: Pubkey) -> Result<()> {
        ctx.accounts.state.bananas_mint = new_mint;
        msg!("Burn mint set to {}", new_mint);
        Ok(())
    }

    /// Compost a dead monke — clean up MonkeBurn PDA for a burned SMB Gen2 NFT.
    /// Permissionless. Anyone can call for any NFT whose mint supply == 0.
    /// Unclaimed SOL returns to program_vault (redistributed to living monkes).
    /// Caller receives rent refund as incentive.
    pub fn compost_monke(ctx: Context<CompostMonke>) -> Result<()> {
        // Verify the NFT has been burned (supply == 0)
        require!(ctx.accounts.nft_mint.supply == 0, MonkeError::NftNotBurned);

        let state = &mut ctx.accounts.state;
        let burn = &ctx.accounts.monke_burn;

        // Compute unclaimed SOL for this dead monke
        // unwrap_or(0) consistent with claim/feed_monke — prevents
        // un-compostable monkes if reward_debt slightly exceeds weight * accumulator due to rounding
        let pending_scaled = (burn.share_weight as u128)
            .checked_mul(state.accumulated_sol_per_share).ok_or(MonkeError::Overflow)?
            .checked_sub(burn.reward_debt).unwrap_or(0);
        // checked_div to comply with #![deny(clippy::integer_arithmetic)]
        let unclaimed = (pending_scaled.checked_div(PRECISION).unwrap_or(0)) as u64;

        // Unclaimed SOL for this dead monke stays in program_vault as surplus.
        // It is NOT redistributed via the accumulator. It implicitly subsidizes
        // future claims because the vault balance exceeds what the accumulator tracks.
        // We remove the dead weight so future deposit_sol increments are larger per share.

        // Subtract dead weight from global total
        state.total_share_weight = state.total_share_weight
            .checked_sub(burn.share_weight).ok_or(MonkeError::Overflow)?;

        emit!(CompostEvent {
            nft_mint: burn.nft_mint,
            weight_removed: burn.share_weight,
            unclaimed_sol_absorbed: unclaimed, // SOL stays in program_vault as surplus, boosting future claims
            new_total_weight: state.total_share_weight,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Composted dead monke: weight={} unclaimed={}", burn.share_weight, unclaimed);
        // MonkeBurn PDA closed by Anchor `close = caller` constraint — rent to caller
        Ok(())
    }
}

// ============ HELPERS ============

/// Validate that an NFT belongs to the SMB Gen2 or Gen3 collection by deserializing
/// its Metaplex metadata account and checking the collection field.
/// Returns weight multiplier: 2 for Gen2, 1 for Gen3.
///
/// Metaplex metadata layout (simplified — we parse from raw bytes):
///   key(1) + update_authority(32) + mint(32) + name(4+32) + symbol(4+10) + uri(4+200)
///   + seller_fee_basis_points(2) + creators_option(1) + [if Some: count(4) + creators(34*n)]
///   + primary_sale_happened(1) + is_mutable(1)
///   + collection_option(1) + [if Some: verified(1) + key(32)]
fn validate_collection_and_weight(
    metadata_info: &AccountInfo,
    nft_mint: &Pubkey,
    gen2_collection: &Pubkey,
    gen3_collection: &Pubkey,
) -> Result<u64> {
    // Verify metadata account is owned by Metaplex Token Metadata program
    require!(
        metadata_info.owner == &MPL_TOKEN_METADATA_ID,
        MonkeError::InvalidMetadata
    );

    let data = metadata_info.try_borrow_data()?;
    require!(data.len() > 0, MonkeError::InvalidMetadata);

    // Verify this metadata belongs to the correct mint
    // Metadata PDA: ["metadata", metaplex_program_id, mint]
    let (expected_metadata, _) = Pubkey::find_program_address(
        &[
            b"metadata",
            MPL_TOKEN_METADATA_ID.as_ref(),
            nft_mint.as_ref(),
        ],
        &MPL_TOKEN_METADATA_ID,
    );
    require!(
        metadata_info.key() == expected_metadata,
        MonkeError::InvalidMetadata
    );

    // Parse metadata to find collection field
    // Skip: key(1) + update_authority(32) + mint(32) = 65 bytes
    let mut offset: usize = 65;

    // name: 4-byte length prefix + data (padded to 32 bytes in practice, but use length)
    require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
    let name_len = u32::from_le_bytes(
        data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
    ) as usize;
    offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?
        .checked_add(name_len).ok_or(MonkeError::Overflow)?;

    // symbol: 4-byte length prefix + data
    require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
    let symbol_len = u32::from_le_bytes(
        data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
    ) as usize;
    offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?
        .checked_add(symbol_len).ok_or(MonkeError::Overflow)?;

    // uri: 4-byte length prefix + data
    require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
    let uri_len = u32::from_le_bytes(
        data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
    ) as usize;
    offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?
        .checked_add(uri_len).ok_or(MonkeError::Overflow)?;

    // seller_fee_basis_points: 2 bytes
    offset = offset.checked_add(2).ok_or(MonkeError::Overflow)?;

    // creators: Option<Vec<Creator>>
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    let has_creators = data[offset] == 1;
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    if has_creators {
        require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
        let num_creators = u32::from_le_bytes(
            data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
        ) as usize;
        offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?;
        // Each creator: address(32) + verified(1) + share(1) = 34 bytes
        offset = offset.checked_add(
            num_creators.checked_mul(34).ok_or(MonkeError::Overflow)?
        ).ok_or(MonkeError::Overflow)?;
    }

    // primary_sale_happened: 1 byte
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;
    // is_mutable: 1 byte
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    // edition_nonce: Option<u8>
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    if data[offset] == 1 {
        offset = offset.checked_add(2).ok_or(MonkeError::Overflow)?;
    } else {
        offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;
    }

    // token_standard: Option<TokenStandard> (u8 enum)
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    if data[offset] == 1 {
        offset = offset.checked_add(2).ok_or(MonkeError::Overflow)?;
    } else {
        offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;
    }

    // collection: Option<Collection>
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    let has_collection = data[offset] == 1;
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    require!(has_collection, MonkeError::InvalidCollection);

    // Collection: verified(1) + key(32)
    require!(data.len() >= offset + 33, MonkeError::InvalidMetadata);
    let _verified = data[offset] == 1;
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    let collection_key = Pubkey::try_from(&data[offset..offset + 32])
        .map_err(|_| MonkeError::InvalidMetadata)?;

    if collection_key == *gen2_collection {
        Ok(1)
    } else if collection_key == *gen3_collection {
        Ok(1)
    } else {
        Err(MonkeError::InvalidCollection.into())
    }
}

/// Validate that an NFT belongs to the gooseswtf pixel goose collection.
/// Same Token Metadata parsing as validate_collection_and_weight (pNFTs use identical layout).
fn validate_goose_pixel_collection(
    metadata_info: &AccountInfo,
    nft_mint: &Pubkey,
) -> Result<()> {
    require!(
        metadata_info.owner == &MPL_TOKEN_METADATA_ID,
        MonkeError::InvalidMetadata
    );

    let data = metadata_info.try_borrow_data()?;
    require!(data.len() > 0, MonkeError::InvalidMetadata);

    let (expected_metadata, _) = Pubkey::find_program_address(
        &[
            b"metadata",
            MPL_TOKEN_METADATA_ID.as_ref(),
            nft_mint.as_ref(),
        ],
        &MPL_TOKEN_METADATA_ID,
    );
    require!(
        metadata_info.key() == expected_metadata,
        MonkeError::InvalidMetadata
    );

    let mut offset: usize = 65; // key(1) + update_authority(32) + mint(32)

    // name: 4-byte length prefix + data
    require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
    let name_len = u32::from_le_bytes(
        data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
    ) as usize;
    offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?
        .checked_add(name_len).ok_or(MonkeError::Overflow)?;

    // symbol: 4-byte length prefix + data
    require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
    let symbol_len = u32::from_le_bytes(
        data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
    ) as usize;
    offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?
        .checked_add(symbol_len).ok_or(MonkeError::Overflow)?;

    // uri: 4-byte length prefix + data
    require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
    let uri_len = u32::from_le_bytes(
        data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
    ) as usize;
    offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?
        .checked_add(uri_len).ok_or(MonkeError::Overflow)?;

    // seller_fee_basis_points: 2 bytes
    offset = offset.checked_add(2).ok_or(MonkeError::Overflow)?;

    // creators: Option<Vec<Creator>>
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    let has_creators = data[offset] == 1;
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    if has_creators {
        require!(data.len() > offset + 4, MonkeError::InvalidMetadata);
        let num_creators = u32::from_le_bytes(
            data[offset..offset + 4].try_into().map_err(|_| MonkeError::InvalidMetadata)?
        ) as usize;
        offset = offset.checked_add(4).ok_or(MonkeError::Overflow)?;
        offset = offset.checked_add(
            num_creators.checked_mul(34).ok_or(MonkeError::Overflow)?
        ).ok_or(MonkeError::Overflow)?;
    }

    // primary_sale_happened: 1 byte
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;
    // is_mutable: 1 byte
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    // edition_nonce: Option<u8>
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    if data[offset] == 1 {
        offset = offset.checked_add(2).ok_or(MonkeError::Overflow)?;
    } else {
        offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;
    }

    // token_standard: Option<TokenStandard>
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    if data[offset] == 1 {
        offset = offset.checked_add(2).ok_or(MonkeError::Overflow)?;
    } else {
        offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;
    }

    // collection: Option<Collection>
    require!(data.len() > offset, MonkeError::InvalidMetadata);
    let has_collection = data[offset] == 1;
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    require!(has_collection, MonkeError::InvalidGooseCollection);

    require!(data.len() >= offset + 33, MonkeError::InvalidMetadata);
    let _verified = data[offset] == 1;
    offset = offset.checked_add(1).ok_or(MonkeError::Overflow)?;

    let collection_key = Pubkey::try_from(&data[offset..offset + 32])
        .map_err(|_| MonkeError::InvalidMetadata)?;

    require!(collection_key == GOOSE_PIXEL_COLLECTION, MonkeError::InvalidGooseCollection);
    Ok(())
}

/// Validate GooseDAO membership by reading a Metaplex Core asset account.
/// Core asset layout: key(1) + owner(32) + update_authority_discriminator(1) + update_authority_value(32)
fn validate_goose_dao_membership(
    core_asset: &AccountInfo,
    user: &Pubkey,
) -> Result<()> {
    require!(
        core_asset.owner == &MPL_CORE_PROGRAM_ID,
        MonkeError::InvalidCoreAsset
    );

    let data = core_asset.try_borrow_data()?;
    require!(data.len() >= 66, MonkeError::InvalidCoreAsset);

    // Byte 0: account type discriminator, 0x01 = Asset
    require!(data[0] == 0x01, MonkeError::InvalidCoreAsset);

    // Bytes 1-32: owner
    let owner = Pubkey::try_from(&data[1..33])
        .map_err(|_| MonkeError::InvalidCoreAsset)?;
    require!(owner == *user, MonkeError::GooseDaoMembershipRequired);

    // Byte 33: update_authority discriminator, 0x02 = Collection
    require!(data[33] == 0x02, MonkeError::InvalidCoreAsset);

    // Bytes 34-65: collection pubkey
    let collection = Pubkey::try_from(&data[34..66])
        .map_err(|_| MonkeError::InvalidCoreAsset)?;
    require!(collection == GOOSE_DAO_COLLECTION, MonkeError::GooseDaoMembershipRequired);

    Ok(())
}

// ============ ACCOUNTS ============

#[account]
pub struct MonkeState {
    pub authority: Pubkey,                   // Admin
    pub pending_authority: Pubkey,            // Two-step transfer (default = zeroed)
    pub bananas_mint: Pubkey,                // $BANANAS token mint
    pub smb_collection: Pubkey,              // SMB Gen2 collection address (2x weight)
    pub smb_gen3_collection: Pubkey,         // SMB Gen3 collection address (1x weight)
    pub dist_pool: Pubkey,                   // dist_pool PDA address (for reference)
    pub total_share_weight: u64,             // Sum of all monke burn weights
    pub accumulated_sol_per_share: u128,     // Scaled by PRECISION (1e12)
    pub total_sol_distributed: u64,          // Lifetime SOL deposited (tracking)
    pub total_bananas_burned: u64,           // Lifetime $BANANAS burned (tracking)
    pub paused: bool,                        // Gates feed_monke only
    pub state_bump: u8,                      // PDA bump for MonkeState
    pub program_vault_bump: u8,              // PDA bump for program_vault
    pub dist_pool_bump: u8,                  // PDA bump for dist_pool
    pub pegged_mint: Pubkey,                 // $PEGGED mint (set via set_pegged_mint after migration)
    pub _reserved: [u8; 32],                 // Reserved for future fields (avoids realloc)
}

impl MonkeState {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // authority
        32 + // pending_authority
        32 + // bananas_mint
        32 + // smb_collection (Gen2)
        32 + // smb_gen3_collection (Gen3)
        32 + // dist_pool
        8 +  // total_share_weight
        16 + // accumulated_sol_per_share (u128)
        8 +  // total_sol_distributed
        8 +  // total_bananas_burned
        1 +  // paused
        1 +  // state_bump
        1 +  // program_vault_bump
        1 +  // dist_pool_bump
        32 + // pegged_mint
        32;  // _reserved
}

#[account]
pub struct MonkeBurn {
    pub nft_mint: Pubkey,                    // The SMB Gen2 NFT this is bound to
    pub share_weight: u64,                   // Number of 1M burns stacked (increments by 1 per feed)
    pub reward_debt: u128,                   // MasterChef: weight * accumulated_sol_per_share at last interaction
    pub claimed_sol: u64,                    // Lifetime SOL claimed (tracking)
    pub first_fed_at: i64,                   // Timestamp of first burn
}

impl MonkeBurn {
    pub const SIZE: usize = 8 +  // discriminator
        32 + // nft_mint
        8 +  // share_weight
        16 + // reward_debt (u128)
        8 +  // claimed_sol
        8;   // first_fed_at
}

// ============ CONTEXTS ============

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = MonkeState::SIZE,
        seeds = [b"monke_state"],
        bump
    )]
    pub state: Account<'info, MonkeState>,

    /// CHECK: PDA vault for holding distributable SOL
    #[account(
        seeds = [b"program_vault"],
        bump
    )]
    pub program_vault: AccountInfo<'info>,

    /// CHECK: dist_pool PDA — SOL arrives here from rover sweep (50% of swept revenue)
    #[account(
        seeds = [b"dist_pool"],
        bump
    )]
    pub dist_pool: AccountInfo<'info>,

    /// $BANANAS token mint (must exist already)
    pub bananas_mint: InterfaceAccount<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FeedMonke<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"monke_state"],
        bump = state.state_bump
    )]
    pub state: Account<'info, MonkeState>,

    /// The SMB Gen2 NFT mint
    pub nft_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for the NFT. Validated in instruction logic.
    /// PDA: ["metadata", metaplex_program_id, nft_mint]
    pub nft_metadata: AccountInfo<'info>,

    /// User's NFT token account — proves ownership (balance must be 1)
    #[account(
        constraint = user_nft_account.mint == nft_mint.key() @ MonkeError::InvalidNftMint,
        constraint = user_nft_account.owner == user.key() @ MonkeError::NotNftHolder,
        constraint = user_nft_account.amount == 1 @ MonkeError::NotNftHolder,
    )]
    pub user_nft_account: InterfaceAccount<'info, TokenAccount>,

    /// User's $CRANK token account (will be burned from)
    #[account(
        mut,
        constraint = user_bananas_account.mint == state.bananas_mint @ MonkeError::InvalidMint,
        constraint = user_bananas_account.owner == user.key() @ MonkeError::NotTokenOwner,
    )]
    pub user_bananas_account: InterfaceAccount<'info, TokenAccount>,

    /// $CRANK mint (for burn CPI)
    #[account(
        mut,
        constraint = bananas_mint.key() == state.bananas_mint @ MonkeError::InvalidMint
    )]
    pub bananas_mint: InterfaceAccount<'info, Mint>,

    /// MonkeBurn PDA — created on first burn, incremented on subsequent burns
    #[account(
        init_if_needed,
        payer = user,
        space = MonkeBurn::SIZE,
        seeds = [b"monke_burn", nft_mint.key().as_ref()],
        bump
    )]
    pub monke_burn: Account<'info, MonkeBurn>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FeedGoose<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"monke_state"],
        bump = state.state_bump
    )]
    pub state: Account<'info, MonkeState>,

    /// The gooseswtf pixel goose NFT mint
    pub goose_nft_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Metaplex metadata account for the pixel goose. Validated in instruction logic.
    pub goose_nft_metadata: AccountInfo<'info>,

    /// User's pixel goose token account — proves ownership (balance must be 1)
    #[account(
        constraint = user_goose_nft_account.mint == goose_nft_mint.key() @ MonkeError::InvalidNftMint,
        constraint = user_goose_nft_account.owner == user.key() @ MonkeError::NotNftHolder,
        constraint = user_goose_nft_account.amount == 1 @ MonkeError::NotNftHolder,
    )]
    pub user_goose_nft_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: GooseDAO Core asset account. Validated in instruction on first feed only.
    /// On subsequent feeds (share_weight > 0), this can be any account (e.g. SystemProgram).
    pub goose_dao_asset: AccountInfo<'info>,

    /// User's $CRANK token account (will be burned from)
    #[account(
        mut,
        constraint = user_bananas_account.mint == state.bananas_mint @ MonkeError::InvalidMint,
        constraint = user_bananas_account.owner == user.key() @ MonkeError::NotTokenOwner,
    )]
    pub user_bananas_account: InterfaceAccount<'info, TokenAccount>,

    /// $CRANK mint (for burn CPI)
    #[account(
        mut,
        constraint = bananas_mint.key() == state.bananas_mint @ MonkeError::InvalidMint
    )]
    pub bananas_mint: InterfaceAccount<'info, Mint>,

    /// MonkeBurn PDA — created on first feed, incremented on subsequent feeds
    #[account(
        init_if_needed,
        payer = user,
        space = MonkeBurn::SIZE,
        seeds = [b"monke_burn", goose_nft_mint.key().as_ref()],
        bump
    )]
    pub monke_burn: Account<'info, MonkeBurn>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    /// Anyone can call (permissionless — keeper calls weekly)
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"monke_state"],
        bump = state.state_bump
    )]
    pub state: Account<'info, MonkeState>,

    /// CHECK: dist_pool PDA — SOL source
    #[account(
        mut,
        seeds = [b"dist_pool"],
        bump = state.dist_pool_bump
    )]
    pub dist_pool: AccountInfo<'info>,

    /// CHECK: program_vault PDA — SOL destination
    #[account(
        mut,
        seeds = [b"program_vault"],
        bump = state.program_vault_bump
    )]
    pub program_vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositPegged<'info> {
    /// Anyone can call (permissionless — keeper calls weekly)
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [b"monke_state"],
        bump = state.state_bump
    )]
    pub state: Account<'info, MonkeState>,

    /// CHECK: dist_pool PDA — authority for the dist_pool $PEGGED ATA
    #[account(
        seeds = [b"dist_pool"],
        bump = state.dist_pool_bump
    )]
    pub dist_pool: AccountInfo<'info>,

    /// Dist pool's $PEGGED ATA — source (receives from bridge)
    #[account(
        mut,
        constraint = dist_pool_pegged_ata.owner == dist_pool.key() @ MonkeError::InvalidTokenAccount,
        constraint = dist_pool_pegged_ata.mint == state.pegged_mint @ MonkeError::InvalidMint,
    )]
    pub dist_pool_pegged_ata: InterfaceAccount<'info, TokenAccount>,

    /// Program vault's $PEGGED ATA — destination
    #[account(
        mut,
        constraint = program_vault_pegged_ata.owner == program_vault.key() @ MonkeError::InvalidTokenAccount,
        constraint = program_vault_pegged_ata.mint == state.pegged_mint @ MonkeError::InvalidMint,
    )]
    pub program_vault_pegged_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: program_vault PDA — for ATA ownership validation
    #[account(
        seeds = [b"program_vault"],
        bump = state.program_vault_bump
    )]
    pub program_vault: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"monke_state"],
        bump = state.state_bump
    )]
    pub state: Account<'info, MonkeState>,

    #[account(
        mut,
        seeds = [b"monke_burn", monke_burn.nft_mint.as_ref()],
        bump
    )]
    pub monke_burn: Account<'info, MonkeBurn>,

    /// User's NFT token account — proves ownership (balance must be 1)
    #[account(
        constraint = user_nft_account.mint == monke_burn.nft_mint @ MonkeError::InvalidNftMint,
        constraint = user_nft_account.owner == user.key() @ MonkeError::NotNftHolder,
        constraint = user_nft_account.amount == 1 @ MonkeError::NotNftHolder,
    )]
    pub user_nft_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: program_vault PDA — SOL source for claim
    #[account(
        mut,
        seeds = [b"program_vault"],
        bump = state.program_vault_bump
    )]
    pub program_vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPegged<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"monke_state"],
        bump = state.state_bump
    )]
    pub state: Account<'info, MonkeState>,

    #[account(
        mut,
        seeds = [b"monke_burn", monke_burn.nft_mint.as_ref()],
        bump
    )]
    pub monke_burn: Account<'info, MonkeBurn>,

    /// User's NFT token account — proves ownership (balance must be 1)
    #[account(
        constraint = user_nft_account.mint == monke_burn.nft_mint @ MonkeError::InvalidNftMint,
        constraint = user_nft_account.owner == user.key() @ MonkeError::NotNftHolder,
        constraint = user_nft_account.amount == 1 @ MonkeError::NotNftHolder,
    )]
    pub user_nft_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: program_vault PDA — authority for the vault $PEGGED ATA
    #[account(
        seeds = [b"program_vault"],
        bump = state.program_vault_bump
    )]
    pub program_vault: AccountInfo<'info>,

    /// Program vault's $PEGGED ATA — source of claim payout
    #[account(
        mut,
        constraint = program_vault_pegged_ata.owner == program_vault.key() @ MonkeError::InvalidTokenAccount,
        constraint = program_vault_pegged_ata.mint == state.pegged_mint @ MonkeError::InvalidMint,
    )]
    pub program_vault_pegged_ata: InterfaceAccount<'info, TokenAccount>,

    /// User's $PEGGED ATA — destination
    #[account(
        mut,
        constraint = user_pegged_ata.owner == user.key() @ MonkeError::InvalidTokenAccount,
        constraint = user_pegged_ata.mint == state.pegged_mint @ MonkeError::InvalidMint,
    )]
    pub user_pegged_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = authority.key() == state.authority @ MonkeError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut, seeds = [b"monke_state"], bump = state.state_bump)]
    pub state: Account<'info, MonkeState>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(
        constraint = new_authority.key() == state.pending_authority @ MonkeError::Unauthorized,
        constraint = state.pending_authority != Pubkey::default() @ MonkeError::NoPendingAuthority
    )]
    pub new_authority: Signer<'info>,

    #[account(mut, seeds = [b"monke_state"], bump = state.state_bump)]
    pub state: Account<'info, MonkeState>,
}

#[derive(Accounts)]
pub struct CompostMonke<'info> {
    /// Anyone can compost — gets rent refund as incentive
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(mut, seeds = [b"monke_state"], bump = state.state_bump)]
    pub state: Account<'info, MonkeState>,

    #[account(
        mut,
        close = caller,
        seeds = [b"monke_burn", monke_burn.nft_mint.as_ref()],
        bump
    )]
    pub monke_burn: Account<'info, MonkeBurn>,

    /// NFT mint — verify supply == 0 (burned)
    #[account(constraint = nft_mint.key() == monke_burn.nft_mint @ MonkeError::InvalidNftMint)]
    pub nft_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: program_vault PDA — unclaimed SOL stays here
    #[account(mut, seeds = [b"program_vault"], bump = state.program_vault_bump)]
    pub program_vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// ============ EVENTS ============

#[event]
pub struct FeedEvent {
    pub user: Pubkey,
    pub nft_mint: Pubkey,
    pub new_weight: u64,
    pub total_weight: u64,
    pub timestamp: i64,
}

#[event]
pub struct DepositEvent {
    pub amount: u64,
    pub total_distributed: u64,
    pub accumulator: u128,
    pub total_share_weight: u64,
    pub timestamp: i64,
}

#[event]
pub struct ClaimEvent {
    pub user: Pubkey,
    pub nft_mint: Pubkey,
    pub amount: u64,
    pub total_claimed: u64,
    pub share_weight: u64,
    pub timestamp: i64,
}

#[event]
pub struct CompostEvent {
    pub nft_mint: Pubkey,
    pub weight_removed: u64,
    /// SOL stays in program_vault as surplus, boosting future claims for all holders
    pub unclaimed_sol_absorbed: u64,
    pub new_total_weight: u64,
    pub timestamp: i64,
}

// ============ ERRORS ============

#[error_code]
pub enum MonkeError {
    #[msg("Not authorized")]
    Unauthorized,

    #[msg("Program is paused")]
    Paused,

    #[msg("No monkes exist (total share weight is 0)")]
    NoMonkes,

    #[msg("Nothing to deposit (dist_pool below minimum)")]
    NothingToDeposit,

    #[msg("Nothing to claim")]
    NothingToClaim,

    #[msg("Caller does not hold the NFT")]
    NotNftHolder,

    #[msg("Invalid NFT mint")]
    InvalidNftMint,

    #[msg("Invalid token mint")]
    InvalidMint,

    #[msg("Not the token owner")]
    NotTokenOwner,

    #[msg("NFT is not from the SMB Gen2 or Gen3 collection")]
    InvalidCollection,

    #[msg("NFT collection is not verified")]
    CollectionNotVerified,

    #[msg("Invalid metadata account")]
    InvalidMetadata,

    #[msg("Arithmetic overflow")]
    Overflow,

    #[msg("No pending authority")]
    NoPendingAuthority,

    #[msg("Insufficient SOL in program vault — wait for next deposit_sol")]
    InsufficientVaultBalance,

    #[msg("NFT has not been burned (supply must be 0)")]
    NftNotBurned,

    #[msg("$PEGGED mint not configured — call set_pegged_mint first")]
    PeggedNotConfigured,

    #[msg("Invalid token account owner")]
    InvalidTokenAccount,

    #[msg("Wallet does not hold a GooseDAO Core NFT (required on first feed)")]
    GooseDaoMembershipRequired,

    #[msg("Pixel goose NFT is not from the gooseswtf collection")]
    InvalidGooseCollection,

    #[msg("Invalid Metaplex Core asset account")]
    InvalidCoreAsset,
}
