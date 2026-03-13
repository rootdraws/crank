// meteora_dlmm_cpi.rs
//
// Meteora DLMM CPI module for crank.money
// Program: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
//
// All CPI calls use V2 variants (Token-2022 compatible).
// V1 functions removed — see git history for reference.
//
// Discriminators verified against carbon-meteora-dlmm-decoder v0.12.0
// and ref/dlmm-sdk/idls/dlmm.json.

use anchor_lang::prelude::*;
use anchor_lang::solana_program;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAM ID & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

pub const METEORA_DLMM_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

pub const SPL_MEMO_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

pub const BINS_PER_ARRAY: i32 = 70;
pub const MAX_POSITION_WIDTH: i32 = 70;

// ═══════════════════════════════════════════════════════════════════════════
// DISCRIMINATORS
// ═══════════════════════════════════════════════════════════════════════════

pub mod disc {
    pub const INITIALIZE_POSITION2: [u8; 8]   = [0x8f, 0x13, 0xf2, 0x91, 0xd5, 0x0f, 0x68, 0x73];
    pub const ADD_LIQ_BY_STRATEGY2: [u8; 8]   = [0x03, 0xdd, 0x95, 0xda, 0x6f, 0x8d, 0x76, 0xd5];
    pub const REMOVE_LIQ_BY_RANGE2: [u8; 8]   = [0xcc, 0x02, 0xc3, 0x91, 0x35, 0x91, 0x91, 0xcd];
    pub const CLAIM_FEE2: [u8; 8]             = [0x70, 0xbf, 0x65, 0xab, 0x1c, 0x90, 0x7f, 0xbb];
    pub const CLOSE_POSITION2: [u8; 8]        = [0xae, 0x5a, 0x23, 0x73, 0xba, 0x28, 0x93, 0xe2];
    pub const INITIALIZE_BIN_ARRAY: [u8; 8]   = [0x23, 0x56, 0x13, 0xb9, 0x4e, 0xd4, 0x4b, 0xd3];
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq)]
pub enum StrategyType {
    SpotOneSide,
    CurveOneSide,
    BidAskOneSide,
    SpotBalanced,
    CurveBalanced,
    BidAskBalanced,
    SpotImBalanced,
    CurveImBalanced,
    BidAskImBalanced,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StrategyParameters {
    pub min_bin_id: i32,
    pub max_bin_id: i32,
    pub strategy_type: StrategyType,
    pub parameteres: [u8; 64], // typo is in Meteora's IDL
}

impl StrategyParameters {
    pub fn spot_imbalanced(min_bin_id: i32, max_bin_id: i32) -> Self {
        Self {
            min_bin_id,
            max_bin_id,
            strategy_type: StrategyType::SpotImBalanced,
            parameteres: [0u8; 64],
        }
    }

    /// BidAsk distribution via V2 two-sided CPI with one side zeroed.
    /// parameteres[0] = 1 favors X side (sell-side rover: deposit token X, amount_y = 0).
    pub fn bid_ask_imbalanced(min_bin_id: i32, max_bin_id: i32) -> Self {
        let mut parameteres = [0u8; 64];
        parameteres[0] = 1;
        Self {
            min_bin_id,
            max_bin_id,
            strategy_type: StrategyType::BidAskImBalanced,
            parameteres,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct LiquidityParameterByStrategy {
    pub amount_x: u64,
    pub amount_y: u64,
    pub active_id: i32,
    pub max_active_bin_slippage: i32,
    pub strategy_parameters: StrategyParameters,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub enum AccountsType {
    TransferHookX,
    TransferHookY,
    TransferHookReward,
    TransferHookMultiReward(u8),
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RemainingAccountsSlice {
    pub accounts_type: AccountsType,
    pub length: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RemainingAccountsInfo {
    pub slices: Vec<RemainingAccountsSlice>,
}

impl RemainingAccountsInfo {
    pub fn none() -> Self { Self { slices: vec![] } }

    pub fn empty_hooks() -> Self {
        Self {
            slices: vec![
                RemainingAccountsSlice { accounts_type: AccountsType::TransferHookX, length: 0 },
                RemainingAccountsSlice { accounts_type: AccountsType::TransferHookY, length: 0 },
            ],
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// PDA HELPERS
// ═══════════════════════════════════════════════════════════════════════════

pub fn event_authority() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"__event_authority"], &METEORA_DLMM_PROGRAM_ID)
}

pub fn bin_array_pda(lb_pair: &Pubkey, index: i64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"bin_array", lb_pair.as_ref(), &index.to_le_bytes()],
        &METEORA_DLMM_PROGRAM_ID,
    )
}

pub fn bin_id_to_array_index(bin_id: i32) -> i64 {
    if bin_id >= 0 {
        (bin_id / BINS_PER_ARRAY) as i64
    } else {
        ((bin_id - (BINS_PER_ARRAY - 1)) / BINS_PER_ARRAY) as i64
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

fn bitmap_meta(account: &AccountInfo) -> AccountMeta {
    if account.is_writable {
        AccountMeta::new(account.key(), false)
    } else {
        AccountMeta::new_readonly(account.key(), false)
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CPI INSTRUCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/// V2 position init — no rent sysvar.
/// Accounts: payer(ms), position(ms), lb_pair, owner(s), system_program, event_auth, program
pub fn initialize_position2<'info>(
    accounts: &[AccountInfo<'info>; 7],
    lower_bin_id: i32,
    width: i32,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&disc::INITIALIZE_POSITION2);
    data.extend_from_slice(&lower_bin_id.to_le_bytes());
    data.extend_from_slice(&width.to_le_bytes());

    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), true),           // payer
            AccountMeta::new(accounts[1].key(), true),           // position
            AccountMeta::new_readonly(accounts[2].key(), false), // lb_pair
            AccountMeta::new_readonly(accounts[3].key(), true),  // owner (vault signer)
            AccountMeta::new_readonly(accounts[4].key(), false), // system_program
            AccountMeta::new_readonly(accounts[5].key(), false), // event_authority
            AccountMeta::new_readonly(accounts[6].key(), false), // program
        ],
        data,
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// V2 add liquidity (Token-2022 compatible). Two-sided params, separate token programs.
/// Fixed accounts (14): position(m), lb_pair(m), bitmap_ext(opt), user_token_x(m), user_token_y(m),
///   reserve_x(m), reserve_y(m), token_x_mint, token_y_mint, sender(s),
///   token_x_prog, token_y_prog, event_auth, program
/// + remaining_accounts for bin arrays
pub fn add_liquidity_by_strategy2<'info>(
    accounts: &[AccountInfo<'info>; 14],
    params: LiquidityParameterByStrategy,
    remaining_accounts_info: RemainingAccountsInfo,
    signer_seeds: &[&[&[u8]]],
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let mut data = Vec::with_capacity(120);
    data.extend_from_slice(&disc::ADD_LIQ_BY_STRATEGY2);
    params.serialize(&mut data)?;
    remaining_accounts_info.serialize(&mut data)?;

    let mut metas = vec![
        AccountMeta::new(accounts[0].key(), false),            // position
        AccountMeta::new(accounts[1].key(), false),            // lb_pair
        bitmap_meta(&accounts[2]),                              // bitmap_ext (optional)
        AccountMeta::new(accounts[3].key(), false),            // user_token_x
        AccountMeta::new(accounts[4].key(), false),            // user_token_y
        AccountMeta::new(accounts[5].key(), false),            // reserve_x
        AccountMeta::new(accounts[6].key(), false),            // reserve_y
        AccountMeta::new_readonly(accounts[7].key(), false),   // token_x_mint
        AccountMeta::new_readonly(accounts[8].key(), false),   // token_y_mint
        AccountMeta::new_readonly(accounts[9].key(), true),    // sender
        AccountMeta::new_readonly(accounts[10].key(), false),  // token_x_program
        AccountMeta::new_readonly(accounts[11].key(), false),  // token_y_program
        AccountMeta::new_readonly(accounts[12].key(), false),  // event_authority
        AccountMeta::new_readonly(accounts[13].key(), false),  // program
    ];
    for a in remaining_accounts { metas.push(AccountMeta::new(a.key(), false)); }
    let mut all: Vec<AccountInfo<'info>> = accounts.to_vec();
    all.extend_from_slice(remaining_accounts);
    invoke_signed(&Instruction { program_id: METEORA_DLMM_PROGRAM_ID, accounts: metas, data }, &all, signer_seeds)?;
    Ok(())
}

/// V2 remove liquidity — bin arrays in remaining_accounts, adds memo_program.
/// Accounts (15): position(m), lb_pair(m), bitmap_ext(m), user_token_x(m), user_token_y(m),
///   reserve_x(m), reserve_y(m), token_x_mint, token_y_mint, sender(s),
///   token_x_prog, token_y_prog, memo_prog, event_auth, program
///   + remaining (bin_arrays, transfer hooks)
pub fn remove_liquidity_by_range2<'info>(
    accounts: &[AccountInfo<'info>; 15],
    from_bin_id: i32,
    to_bin_id: i32,
    bps_to_remove: u16,
    remaining_accounts_info: RemainingAccountsInfo,
    signer_seeds: &[&[&[u8]]],
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&disc::REMOVE_LIQ_BY_RANGE2);
    data.extend_from_slice(&from_bin_id.to_le_bytes());
    data.extend_from_slice(&to_bin_id.to_le_bytes());
    data.extend_from_slice(&bps_to_remove.to_le_bytes());
    remaining_accounts_info.serialize(&mut data)?;

    let mut metas = vec![
        AccountMeta::new(accounts[0].key(), false),
        AccountMeta::new(accounts[1].key(), false),
        bitmap_meta(&accounts[2]),
        AccountMeta::new(accounts[3].key(), false),
        AccountMeta::new(accounts[4].key(), false),
        AccountMeta::new(accounts[5].key(), false),
        AccountMeta::new(accounts[6].key(), false),
        AccountMeta::new_readonly(accounts[7].key(), false),
        AccountMeta::new_readonly(accounts[8].key(), false),
        AccountMeta::new_readonly(accounts[9].key(), true),
        AccountMeta::new_readonly(accounts[10].key(), false),
        AccountMeta::new_readonly(accounts[11].key(), false),
        AccountMeta::new_readonly(accounts[12].key(), false),
        AccountMeta::new_readonly(accounts[13].key(), false),
        AccountMeta::new_readonly(accounts[14].key(), false),
    ];
    for a in remaining_accounts { metas.push(AccountMeta::new(a.key(), false)); }
    let mut all: Vec<AccountInfo<'info>> = accounts.to_vec();
    all.extend_from_slice(remaining_accounts);
    invoke_signed(&Instruction { program_id: METEORA_DLMM_PROGRAM_ID, accounts: metas, data }, &all, signer_seeds)?;
    Ok(())
}

/// V2 claim — separate token programs + memo.
/// Accounts (14): lb_pair(m), position(m), sender(s), reserve_x(m), reserve_y(m),
///   user_token_x(m), user_token_y(m), token_x_mint, token_y_mint,
///   token_prog_x, token_prog_y, memo_prog, event_auth, program
///   + remaining (bin_arrays, transfer hooks)
pub fn claim_fee2<'info>(
    accounts: &[AccountInfo<'info>; 14],
    min_bin_id: i32,
    max_bin_id: i32,
    remaining_accounts_info: RemainingAccountsInfo,
    signer_seeds: &[&[&[u8]]],
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&disc::CLAIM_FEE2);
    data.extend_from_slice(&min_bin_id.to_le_bytes());
    data.extend_from_slice(&max_bin_id.to_le_bytes());
    remaining_accounts_info.serialize(&mut data)?;

    let mut metas = vec![
        AccountMeta::new(accounts[0].key(), false),
        AccountMeta::new(accounts[1].key(), false),
        AccountMeta::new_readonly(accounts[2].key(), true),
        AccountMeta::new(accounts[3].key(), false),
        AccountMeta::new(accounts[4].key(), false),
        AccountMeta::new(accounts[5].key(), false),
        AccountMeta::new(accounts[6].key(), false),
        AccountMeta::new_readonly(accounts[7].key(), false),
        AccountMeta::new_readonly(accounts[8].key(), false),
        AccountMeta::new_readonly(accounts[9].key(), false),
        AccountMeta::new_readonly(accounts[10].key(), false),
        AccountMeta::new_readonly(accounts[11].key(), false),
        AccountMeta::new_readonly(accounts[12].key(), false),
        AccountMeta::new_readonly(accounts[13].key(), false),
    ];
    for a in remaining_accounts { metas.push(AccountMeta::new(a.key(), false)); }
    let mut all: Vec<AccountInfo<'info>> = accounts.to_vec();
    all.extend_from_slice(remaining_accounts);
    invoke_signed(&Instruction { program_id: METEORA_DLMM_PROGRAM_ID, accounts: metas, data }, &all, signer_seeds)?;
    Ok(())
}

/// V2 close — no bin arrays needed.
/// Accounts (5): position(m), sender(s), rent_receiver(m), event_auth, program
pub fn close_position2<'info>(
    accounts: &[AccountInfo<'info>; 5],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts[0].key(), false),
            AccountMeta::new_readonly(accounts[1].key(), true),
            AccountMeta::new(accounts[2].key(), false),
            AccountMeta::new_readonly(accounts[3].key(), false),
            AccountMeta::new_readonly(accounts[4].key(), false),
        ],
        data: disc::CLOSE_POSITION2.to_vec(),
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}

/// Accounts: lb_pair, bin_array(m), funder(ms), system_program
pub fn initialize_bin_array<'info>(
    accounts: &[AccountInfo<'info>; 4],
    index: i64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&disc::INITIALIZE_BIN_ARRAY);
    data.extend_from_slice(&index.to_le_bytes());

    let ix = Instruction {
        program_id: METEORA_DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts[0].key(), false),
            AccountMeta::new(accounts[1].key(), false),
            AccountMeta::new(accounts[2].key(), true),
            AccountMeta::new_readonly(accounts[3].key(), false),
        ],
        data,
    };
    invoke_signed(&ix, accounts, signer_seeds)?;
    Ok(())
}
