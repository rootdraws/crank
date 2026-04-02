// merkle_distributor — cumulative Merkle-based SOL distribution
//
// Adapted from Jito's merkle-distributor pattern. Each epoch the bot:
//   1. Computes all rewards (BANK holder 40% + trader 40% unified)
//   2. Builds a Merkle tree of (wallet, cumulative_sol_amount) leaves
//   3. Pins the tree JSON to IPFS
//   4. Calls new_epoch to upload root + IPFS CID + fund the vault with WSOL
//
// Claims are cumulative: each root represents total lifetime entitlements.
// The program tracks how much each user has already claimed and pays the delta.
// Auto-claimed daily by the keeper (user pays gas from custody wallet).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV");

/// Maximum depth of the Merkle tree (supports 2^20 = ~1M leaves).
pub const MAX_TREE_DEPTH: usize = 20;
/// Maximum length for IPFS CID string.
pub const MAX_IPFS_CID_LEN: usize = 64;

// ─── program ───────────────────────────────────────────────────────────────

#[program]
pub mod merkle_distributor {
    use super::*;

    /// Initialize the distributor. Sets the admin and token mint.
    /// The vault ATA is created off-chain before calling this.
    pub fn initialize(ctx: Context<InitializeDistributor>) -> Result<()> {
        let dist = &mut ctx.accounts.distributor;
        dist.authority = ctx.accounts.authority.key();
        dist.pending_authority = Pubkey::default();
        dist.mint = ctx.accounts.mint.key();
        dist.vault = ctx.accounts.vault.key();
        dist.current_epoch = 0;
        dist.merkle_root = [0u8; 32];
        dist.total_amount_funded = 0;
        dist.total_amount_claimed = 0;
        dist.paused = false;
        dist.bump = ctx.bumps.distributor;
        dist.ipfs_cid = String::new();
        Ok(())
    }

    /// Upload a new Merkle root for the next epoch.
    /// The bot calls this daily at 4:20 PM CST after computing rewards.
    /// Funds the vault with this epoch's WSOL in the same transaction.
    pub fn new_epoch(
        ctx: Context<NewEpoch>,
        merkle_root: [u8; 32],
        epoch_amount: u64,
        ipfs_cid: String,
    ) -> Result<()> {
        require!(epoch_amount > 0, DistributorError::ZeroAmount);
        require!(ipfs_cid.len() <= MAX_IPFS_CID_LEN, DistributorError::CidTooLong);

        // Transfer epoch's WSOL from funder to vault
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funder_ata.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            epoch_amount,
            ctx.accounts.mint.decimals,
        )?;

        let dist = &mut ctx.accounts.distributor;
        dist.current_epoch = dist
            .current_epoch
            .checked_add(1)
            .ok_or(DistributorError::Overflow)?;
        dist.merkle_root = merkle_root;
        dist.total_amount_funded = dist
            .total_amount_funded
            .checked_add(epoch_amount)
            .ok_or(DistributorError::Overflow)?;
        dist.ipfs_cid = ipfs_cid.clone();

        emit!(NewEpochEvent {
            epoch: dist.current_epoch,
            merkle_root,
            epoch_amount,
            total_funded: dist.total_amount_funded,
            ipfs_cid,
        });

        Ok(())
    }

    /// Claim accumulated rewards. Anyone can call on behalf of the claimant
    /// (bot auto-claims for custody wallets using user's SOL for tx fee).
    ///
    /// `cumulative_amount` is the total lifetime entitlement from the current tree.
    /// The program pays out `cumulative_amount - already_claimed`.
    pub fn claim(
        ctx: Context<Claim>,
        index: u64,
        cumulative_amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let dist = &ctx.accounts.distributor;
        require!(!dist.paused, DistributorError::Paused);
        require!(proof.len() <= MAX_TREE_DEPTH, DistributorError::ProofTooLong);

        // Verify Merkle proof
        let leaf = anchor_lang::solana_program::keccak::hashv(&[
            &index.to_le_bytes(),
            ctx.accounts.claimant.key().as_ref(),
            &cumulative_amount.to_le_bytes(),
        ]);
        let mut current = leaf.0;
        for node in proof.iter() {
            if current <= *node {
                current = anchor_lang::solana_program::keccak::hashv(&[&current, node]).0;
            } else {
                current = anchor_lang::solana_program::keccak::hashv(&[node, &current]).0;
            }
        }
        require!(
            current == dist.merkle_root,
            DistributorError::InvalidProof
        );

        let claim_status = &mut ctx.accounts.claim_status;
        let already_claimed = claim_status.cumulative_claimed;
        let claimable = cumulative_amount
            .checked_sub(already_claimed)
            .ok_or(DistributorError::NothingToClaim)?;
        require!(claimable > 0, DistributorError::NothingToClaim);

        // Transfer from vault to claimant
        let seeds: &[&[u8]] = &[b"distributor", &[ctx.accounts.distributor.bump]];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.claimant_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    authority: ctx.accounts.distributor.to_account_info(),
                },
                &[seeds],
            ),
            claimable,
            ctx.accounts.mint.decimals,
        )?;

        claim_status.cumulative_claimed = cumulative_amount;
        claim_status.last_claim_epoch = ctx.accounts.distributor.current_epoch;

        // Update distributor totals
        let dist = &mut ctx.accounts.distributor;
        dist.total_amount_claimed = dist
            .total_amount_claimed
            .checked_add(claimable)
            .ok_or(DistributorError::Overflow)?;

        emit!(ClaimEvent {
            claimant: ctx.accounts.claimant.key(),
            index,
            cumulative_amount,
            claimed_this_tx: claimable,
            epoch: dist.current_epoch,
        });

        Ok(())
    }

    pub fn pause(ctx: Context<DistributorAdmin>) -> Result<()> {
        ctx.accounts.distributor.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<DistributorAdmin>) -> Result<()> {
        ctx.accounts.distributor.paused = false;
        Ok(())
    }

    pub fn propose_authority(ctx: Context<DistributorAdmin>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.distributor.pending_authority = new_authority;
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptDistributorAuthority>) -> Result<()> {
        let dist = &mut ctx.accounts.distributor;
        dist.authority = dist.pending_authority;
        dist.pending_authority = Pubkey::default();
        Ok(())
    }

    /// Update the distribution mint and vault ATA. Authority-gated.
    /// Authority-gated. The new vault must be an ATA owned by the distributor PDA.
    pub fn update_mint(ctx: Context<UpdateMint>) -> Result<()> {
        let dist = &mut ctx.accounts.distributor;
        dist.mint = ctx.accounts.new_mint.key();
        dist.vault = ctx.accounts.new_vault.key();
        msg!("Distributor mint updated to {}", dist.mint);
        msg!("Distributor vault updated to {}", dist.vault);
        Ok(())
    }
}

// ─── accounts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeDistributor<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Distributor::INIT_SPACE,
        seeds = [b"distributor"],
        bump,
    )]
    pub distributor: Account<'info, Distributor>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// Vault ATA owned by the distributor PDA. Created off-chain.
    #[account(
        token::mint = mint,
        token::authority = distributor,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct NewEpoch<'info> {
    #[account(
        mut,
        seeds = [b"distributor"],
        bump = distributor.bump,
        has_one = authority @ DistributorError::Unauthorized,
        has_one = mint @ DistributorError::MintMismatch,
        has_one = vault @ DistributorError::VaultMismatch,
    )]
    pub distributor: Account<'info, Distributor>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = authority,
        token::token_program = token_program,
    )]
    pub funder_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Bot (or user) paying for the tx. Does NOT need to be the claimant.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"distributor"],
        bump = distributor.bump,
        has_one = mint @ DistributorError::MintMismatch,
        has_one = vault @ DistributorError::VaultMismatch,
    )]
    pub distributor: Account<'info, Distributor>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: The wallet that receives tokens. Validated by the Merkle proof.
    pub claimant: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = mint,
        token::authority = claimant,
        token::token_program = token_program,
    )]
    pub claimant_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ClaimStatus::INIT_SPACE,
        seeds = [b"claim_status", distributor.key().as_ref(), claimant.key().as_ref()],
        bump,
    )]
    pub claim_status: Account<'info, ClaimStatus>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributorAdmin<'info> {
    #[account(
        mut,
        seeds = [b"distributor"],
        bump = distributor.bump,
        has_one = authority @ DistributorError::Unauthorized,
    )]
    pub distributor: Account<'info, Distributor>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptDistributorAuthority<'info> {
    #[account(
        mut,
        seeds = [b"distributor"],
        bump = distributor.bump,
        constraint = distributor.pending_authority == new_authority.key() @ DistributorError::Unauthorized,
        constraint = distributor.pending_authority != Pubkey::default() @ DistributorError::NoPendingAuthority,
    )]
    pub distributor: Account<'info, Distributor>,

    pub new_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateMint<'info> {
    #[account(
        mut,
        seeds = [b"distributor"],
        bump = distributor.bump,
        has_one = authority @ DistributorError::Unauthorized,
    )]
    pub distributor: Account<'info, Distributor>,

    pub authority: Signer<'info>,

    pub new_mint: InterfaceAccount<'info, Mint>,

    /// New vault ATA owned by the distributor PDA, denominated in new_mint.
    #[account(
        token::mint = new_mint,
        token::authority = distributor,
        token::token_program = token_program,
    )]
    pub new_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ─── state ─────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct Distributor {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub current_epoch: u64,
    pub merkle_root: [u8; 32],
    pub total_amount_funded: u64,
    pub total_amount_claimed: u64,
    pub paused: bool,
    pub bump: u8,
    #[max_len(64)]
    pub ipfs_cid: String,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimStatus {
    pub cumulative_claimed: u64,
    pub last_claim_epoch: u64,
}

// ─── events ────────────────────────────────────────────────────────────────

#[event]
pub struct NewEpochEvent {
    pub epoch: u64,
    pub merkle_root: [u8; 32],
    pub epoch_amount: u64,
    pub total_funded: u64,
    pub ipfs_cid: String,
}

#[event]
pub struct ClaimEvent {
    pub claimant: Pubkey,
    pub index: u64,
    pub cumulative_amount: u64,
    pub claimed_this_tx: u64,
    pub epoch: u64,
}

// ─── errors ────────────────────────────────────────────────────────────────

#[error_code]
pub enum DistributorError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("IPFS CID exceeds maximum length")]
    CidTooLong,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid Merkle proof")]
    InvalidProof,
    #[msg("Nothing to claim (already fully claimed)")]
    NothingToClaim,
    #[msg("Merkle proof exceeds maximum depth")]
    ProofTooLong,
    #[msg("Program is paused")]
    Paused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Mint address mismatch")]
    MintMismatch,
    #[msg("Vault address mismatch")]
    VaultMismatch,
    #[msg("No pending authority transfer")]
    NoPendingAuthority,
}
