use crate::state::keeper_oracle::KeeperOracleState;
use crate::MarginfiResult;
use anchor_lang::prelude::*;
use marginfi_type_crate::types::MarginfiGroup;

pub fn init_keeper_oracle(
    ctx: Context<InitKeeperOracle>,
    authority: Pubkey,
) -> MarginfiResult {
    let oracle = &mut ctx.accounts.keeper_oracle.load_init()?;
    oracle.authority = authority;
    oracle.last_updated_at = 0;

    msg!("Keeper oracle initialized, authority: {}", authority);
    Ok(())
}

#[derive(Accounts)]
pub struct InitKeeperOracle<'info> {
    #[account(has_one = admin)]
    pub group: AccountLoader<'info, MarginfiGroup>,

    pub admin: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<KeeperOracleState>(),
    )]
    pub keeper_oracle: AccountLoader<'info, KeeperOracleState>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}
