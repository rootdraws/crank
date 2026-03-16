use anchor_lang::prelude::*;

#[account]
pub struct VaultState {
    /// The admin who can deposit, withdraw, and manage the vault.
    pub admin: Pubkey,
    /// The crank-lend group this vault operates against.
    pub crank_lend_group: Pubkey,
    /// The crank-lend marginfi account owned by this vault (PDA).
    pub marginfi_account: Pubkey,
    /// CRANK token mint.
    pub crank_mint: Pubkey,
    /// Collateral token mint (e.g. USDC).
    pub collateral_mint: Pubkey,
    /// PDA bump for the vault authority.
    pub vault_authority_bump: u8,

    // --- Inventory tracking ---
    /// Total liquidations executed.
    pub liquidation_count: u64,
    /// Cumulative CRANK (native units) used to repay debts during liquidations.
    pub total_crank_liquidated: u64,
    /// Cumulative USDC (native units) received as collateral from liquidations.
    pub total_usdc_collected: u64,
    /// Cumulative SOL (lamports) acquired via USDC->SOL swaps.
    pub total_sol_swapped: u64,
    /// Cumulative crankSOL (native units) minted via Sanctum.
    pub total_cranksol_minted: u64,
    /// Cumulative DLMM bid placement operations.
    pub total_dlmm_bids_placed: u64,

    /// Reserved for future use.
    pub _reserved: [u8; 64],
}
