use anchor_lang::prelude::*;
use marginfi_type_crate::types::WrappedI80F48;

/// An on-chain oracle account updated by a permissioned keeper.
/// The keeper posts price, confidence, and the Pumpswap pool's TVL (in USD)
/// so that the HybridDlmmKeeper can compute a TVL-weighted average price.
#[account(zero_copy)]
#[repr(C)]
pub struct KeeperOracleState {
    /// The authority permitted to update this oracle.
    pub authority: Pubkey,
    /// Current price in USD (same denomination as other oracles in the system).
    pub price: WrappedI80F48,
    /// Confidence interval in USD (absolute, not relative).
    pub confidence: WrappedI80F48,
    /// Unix timestamp of the last update.
    pub last_updated_at: i64,
    /// Pumpswap pool TVL in USD, used as the keeper source's weight in
    /// TVL-weighted averaging against the DLMM on-chain TVL.
    pub pumpswap_tvl_usd: WrappedI80F48,
    /// Reserved for future use.
    pub _reserved: [u8; 48],
}
