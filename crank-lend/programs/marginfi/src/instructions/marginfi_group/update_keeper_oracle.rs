use crate::state::keeper_oracle::KeeperOracleState;
use crate::{check, errors::MarginfiError, MarginfiResult};
use anchor_lang::prelude::*;
use marginfi_type_crate::types::WrappedI80F48;

pub fn update_keeper_oracle(
    ctx: Context<UpdateKeeperOracle>,
    price: WrappedI80F48,
    confidence: WrappedI80F48,
    pumpswap_tvl_usd: WrappedI80F48,
) -> MarginfiResult {
    let mut oracle = ctx.accounts.keeper_oracle.load_mut()?;
    let clock = Clock::get()?;

    check!(
        ctx.accounts.authority.key() == oracle.authority,
        MarginfiError::Unauthorized
    );

    oracle.price = price;
    oracle.confidence = confidence;
    oracle.pumpswap_tvl_usd = pumpswap_tvl_usd;
    oracle.last_updated_at = clock.unix_timestamp;

    Ok(())
}

#[derive(Accounts)]
pub struct UpdateKeeperOracle<'info> {
    #[account(mut)]
    pub keeper_oracle: AccountLoader<'info, KeeperOracleState>,

    pub authority: Signer<'info>,
}
