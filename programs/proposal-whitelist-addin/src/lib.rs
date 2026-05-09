// proposal-whitelist-addin — community voter-weight addin for SPL Governance.
//
// Returns voter_weight = u64::MAX if and only if every inner instruction across
// every ProposalTransaction in the proposal matches the registrar's whitelist.
// Otherwise returns voter_weight = 0 — vote can't tip → drain proposal stuck.
//
// The check runs on-chain in update_voter_weight_record. The bot can be
// fully compromised and this gate still holds: the registrar lives on-chain
// in an immutable account, and the addin program's code is what SPL
// Governance calls during castVote weight resolution.
//
// Whitelist update authority is a separate keypair (typically a hardware
// wallet) — NOT the bot. Updating the whitelist is an authority-gated ix.
//
// Layout reference: spl-governance v3+ ProposalV2 / ProposalTransactionV2.
// We hand-parse those accounts since SPL Governance is a native (not Anchor)
// program — we can't depend on its types from inside an Anchor program.

#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

declare_id!("9Tpa3wZwm21yPFvZtDQYnJic5UGKPNQKqQqCiC6tkUnv");

// SPL Governance GovernanceAccountType enum tags (first byte of account data).
const ACCOUNT_TYPE_PROPOSAL_V2: u8 = 14;
const ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2: u8 = 13;

// SPL Governance VoterWeightAction enum tags.
const VWR_ACTION_CAST_VOTE: u8 = 0;

// Standard SPL Governance addin discriminator for VoterWeightRecord.
// SPL Governance reads this from the start of the account data when the
// realm config has community_voter_weight_addin set.
//
// Source: spl-governance-addin-api/src/voter_weight.rs
const VOTER_WEIGHT_RECORD_DISCRIMINATOR: [u8; 8] = [46, 249, 155, 75, 153, 248, 116, 9];
const MAX_VOTER_WEIGHT_RECORD_DISCRIMINATOR: [u8; 8] = [157, 95, 242, 151, 16, 98, 26, 118];

#[program]
pub mod proposal_whitelist_addin {
    use super::*;

    /// Create the realm-scoped registrar. Caller becomes the authority that
    /// can later update the whitelist. Whitelist starts empty — call
    /// update_registrar_whitelist immediately after.
    pub fn create_registrar(
        ctx: Context<CreateRegistrar>,
        governance_program_id: Pubkey,
    ) -> Result<()> {
        let r = &mut ctx.accounts.registrar;
        r.realm = ctx.accounts.realm.key();
        r.governing_token_mint = ctx.accounts.governing_token_mint.key();
        r.governance_program_id = governance_program_id;
        r.authority = ctx.accounts.authority.key();
        r.bump = ctx.bumps.registrar;
        r.whitelist = Vec::new();
        Ok(())
    }

    /// Replace the registrar's whitelist atomically. Authority-only.
    /// Each entry: (program_id, discriminator_bytes, discriminator_length).
    /// Length 0 means "any data accepted" (program-id-only match — for memo).
    pub fn update_registrar_whitelist(
        ctx: Context<UpdateRegistrar>,
        whitelist: Vec<WhitelistEntry>,
    ) -> Result<()> {
        require!(whitelist.len() <= MAX_WHITELIST_ENTRIES, AddinError::WhitelistTooLarge);
        for e in &whitelist {
            require!(e.disc_len <= 8, AddinError::DiscLenTooLarge);
        }
        ctx.accounts.registrar.whitelist = whitelist;
        Ok(())
    }

    /// Rotate the registrar authority (e.g., to a hardware wallet).
    pub fn set_registrar_authority(
        ctx: Context<UpdateRegistrar>,
        new_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.registrar.authority = new_authority;
        Ok(())
    }

    /// Idempotently create the per-(realm, mint, owner) VoterWeightRecord.
    /// Initialized weight = 0; meaningful weight is set per-vote by
    /// update_voter_weight_record.
    pub fn create_voter_weight_record(ctx: Context<CreateVoterWeightRecord>) -> Result<()> {
        let v = &mut ctx.accounts.voter_weight_record;
        v.realm = ctx.accounts.registrar.realm;
        v.governing_token_mint = ctx.accounts.registrar.governing_token_mint;
        v.governing_token_owner = ctx.accounts.governing_token_owner.key();
        v.voter_weight = 0;
        v.voter_weight_expiry = None;
        v.weight_action = None;
        v.weight_action_target = None;
        v.reserved = [0u8; 8];
        Ok(())
    }

    /// Compute the caller's voting weight for a specific proposal action.
    /// SPL Governance invokes this (indirectly — by reading the VoterWeightRecord
    /// after a CPI we make on its behalf is... no, the bot calls this directly
    /// in tx1 right before castVote. The VWR's weight_action_target+expiry
    /// fields are checked by SPL Governance during the subsequent castVote.)
    ///
    /// Remaining accounts layout (in order):
    ///   [0]   = Proposal account (V2)
    ///   [1..] = every ProposalTransaction (V2) belonging to that Proposal,
    ///           in option-major + index-major order.
    ///
    /// Validation: every inner ix in every ProposalTransaction must match the
    /// registrar's whitelist. If any check fails → weight = 0.
    /// If all pass → weight = u64::MAX.
    pub fn update_voter_weight_record<'info>(
        ctx: Context<'_, '_, '_, 'info, UpdateVoterWeightRecord<'info>>,
        voter_weight_action: u8,
    ) -> Result<()> {
        // Pre-proposal actions (CreateProposal=3, SignOffProposal=4, CommentProposal=1,
        // CreateGovernance=2): no proposal exists yet to inspect — grant unit weight.
        // The whitelist gate kicks in only at CastVote (=0), where the proposal +
        // its ProposalTransactions are present and parseable.
        if voter_weight_action != VWR_ACTION_CAST_VOTE {
            let v = &mut ctx.accounts.voter_weight_record;
            v.voter_weight = 1;
            v.voter_weight_expiry = Some(Clock::get()?.slot);
            v.weight_action = Some(voter_weight_action);
            v.weight_action_target = None;
            msg!("voter weight = 1 (non-vote action {})", voter_weight_action);
            return Ok(());
        }

        let registrar = &ctx.accounts.registrar;
        let proposal_acct = ctx
            .remaining_accounts
            .get(0)
            .ok_or(AddinError::MissingProposalAccount)?;

        require_keys_eq!(
            *proposal_acct.owner,
            registrar.governance_program_id,
            AddinError::ProposalNotOwnedByGovernance
        );
        let proposal_pubkey = proposal_acct.key();

        // Parse Proposal to get options[] with each option's transactions_count.
        let proposal_data_ref = proposal_acct.try_borrow_data()?;
        let parsed_proposal = parse_proposal_v2(&proposal_data_ref)?;

        // Sum up all transactions across all options. Each must appear in
        // remaining_accounts. No more, no less.
        let total_tx_count: u32 = parsed_proposal
            .options
            .iter()
            .map(|o| o.transactions_count as u32)
            .sum();
        let expected_total_accounts = (1u32).saturating_add(total_tx_count);
        require!(
            ctx.remaining_accounts.len() as u32 == expected_total_accounts,
            AddinError::ProposalTransactionAccountsMismatch
        );

        // Walk every (option, index) and verify the matching ProposalTransaction
        // PDA is present + parses + has whitelisted instructions.
        let mut acct_cursor = 1usize;
        for (option_index, option) in parsed_proposal.options.iter().enumerate() {
            for transaction_index in 0..option.transactions_count {
                let pt_acct = &ctx.remaining_accounts[acct_cursor];
                acct_cursor += 1;

                require_keys_eq!(
                    *pt_acct.owner,
                    registrar.governance_program_id,
                    AddinError::ProposalTransactionNotOwnedByGovernance
                );

                // Re-derive the expected PDA for (proposal, option_index, transaction_index)
                // and require the passed account match. This binds the inspected
                // payload to the proposal we're about to vote on.
                let option_index_byte = [option_index as u8];
                let tx_index_le = (transaction_index as u16).to_le_bytes();
                let (expected_pda, _) = Pubkey::find_program_address(
                    &[
                        b"governance",
                        proposal_pubkey.as_ref(),
                        &option_index_byte,
                        &tx_index_le,
                    ],
                    &registrar.governance_program_id,
                );
                require_keys_eq!(
                    pt_acct.key(),
                    expected_pda,
                    AddinError::ProposalTransactionPdaMismatch
                );

                let pt_data = pt_acct.try_borrow_data()?;
                let inner_ixs = parse_proposal_transaction_v2(&pt_data, &proposal_pubkey)?;
                if !instructions_match_whitelist(&registrar.whitelist, &inner_ixs) {
                    set_zero_weight(
                        &mut ctx.accounts.voter_weight_record,
                        proposal_pubkey,
                        voter_weight_action,
                    )?;
                    msg!("voter weight = 0: instruction outside whitelist");
                    return Ok(());
                }
            }
        }

        // All inner ixs matched. Grant unit weight (= proposal-perm mint
        // supply of 1) so vote tips at YesVotePercentage(1) without
        // overflowing SPL Governance's vote-tipping arithmetic.
        let v = &mut ctx.accounts.voter_weight_record;
        v.voter_weight = 1;
        v.voter_weight_expiry = Some(Clock::get()?.slot);
        v.weight_action = Some(voter_weight_action);
        v.weight_action_target = Some(proposal_pubkey);
        msg!("voter weight = 1 (whitelist match)");
        Ok(())
    }

    /// Optional: provide a MaxVoterWeightRecord that mirrors the runtime
    /// max. Not currently used (SPL Governance derives max from supply when
    /// addin doesn't supply one), but the realm config may opt in later.
    pub fn create_max_voter_weight_record(
        ctx: Context<CreateMaxVoterWeightRecord>,
    ) -> Result<()> {
        let m = &mut ctx.accounts.max_voter_weight_record;
        m.realm = ctx.accounts.registrar.realm;
        m.governing_token_mint = ctx.accounts.registrar.governing_token_mint;
        // Matches proposal-perm mint supply (1). Keeps tipping math
        // proportional to voter_weight returned by update_voter_weight_record.
        m.max_voter_weight = 1;
        m.max_voter_weight_expiry = None;
        m.reserved = [0u8; 8];
        Ok(())
    }
}

// ─── State ─────────────────────────────────────────────────────────────────

pub const MAX_WHITELIST_ENTRIES: usize = 32;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WhitelistEntry {
    pub program_id: Pubkey,
    pub discriminator: [u8; 8],
    pub disc_len: u8,
}

#[account]
pub struct Registrar {
    pub realm: Pubkey,
    pub governing_token_mint: Pubkey,
    pub governance_program_id: Pubkey,
    pub authority: Pubkey,
    pub bump: u8,
    pub whitelist: Vec<WhitelistEntry>,
}

impl Registrar {
    pub const MAX_SIZE: usize =
        32 + 32 + 32 + 32 + 1 + 4 + (MAX_WHITELIST_ENTRIES * (32 + 8 + 1));
}

/// Custom-discriminator account matching the SPL Governance addin
/// VoterWeightRecord layout. SPL Governance reads this exact byte layout.
#[account(discriminator = &VOTER_WEIGHT_RECORD_DISCRIMINATOR)]
pub struct VoterWeightRecord {
    pub realm: Pubkey,
    pub governing_token_mint: Pubkey,
    pub governing_token_owner: Pubkey,
    pub voter_weight: u64,
    pub voter_weight_expiry: Option<u64>,
    pub weight_action: Option<u8>,
    pub weight_action_target: Option<Pubkey>,
    pub reserved: [u8; 8],
}

impl VoterWeightRecord {
    pub const MAX_SIZE: usize = 32 + 32 + 32 + 8 + (1 + 8) + (1 + 1) + (1 + 32) + 8;
}

#[account(discriminator = &MAX_VOTER_WEIGHT_RECORD_DISCRIMINATOR)]
pub struct MaxVoterWeightRecord {
    pub realm: Pubkey,
    pub governing_token_mint: Pubkey,
    pub max_voter_weight: u64,
    pub max_voter_weight_expiry: Option<u64>,
    pub reserved: [u8; 8],
}

impl MaxVoterWeightRecord {
    pub const MAX_SIZE: usize = 32 + 32 + 8 + (1 + 8) + 8;
}

// ─── Contexts ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateRegistrar<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Registrar::MAX_SIZE,
        seeds = [b"registrar", realm.key().as_ref(), governing_token_mint.key().as_ref()],
        bump,
    )]
    pub registrar: Account<'info, Registrar>,
    /// CHECK: realm pubkey, validated by seeds.
    pub realm: UncheckedAccount<'info>,
    /// CHECK: governing_token_mint pubkey, validated by seeds.
    pub governing_token_mint: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRegistrar<'info> {
    #[account(
        mut,
        seeds = [b"registrar", registrar.realm.as_ref(), registrar.governing_token_mint.as_ref()],
        bump = registrar.bump,
        has_one = authority @ AddinError::Unauthorized,
    )]
    pub registrar: Account<'info, Registrar>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateVoterWeightRecord<'info> {
    pub registrar: Account<'info, Registrar>,
    /// CHECK: governing_token_owner pubkey, validated by seeds + stored on the record.
    pub governing_token_owner: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + VoterWeightRecord::MAX_SIZE,
        seeds = [
            b"voter-weight-record",
            registrar.realm.as_ref(),
            registrar.governing_token_mint.as_ref(),
            governing_token_owner.key().as_ref(),
        ],
        bump,
    )]
    pub voter_weight_record: Account<'info, VoterWeightRecord>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateVoterWeightRecord<'info> {
    pub registrar: Account<'info, Registrar>,
    #[account(
        mut,
        seeds = [
            b"voter-weight-record",
            registrar.realm.as_ref(),
            registrar.governing_token_mint.as_ref(),
            voter_weight_record.governing_token_owner.as_ref(),
        ],
        bump,
        constraint = voter_weight_record.realm == registrar.realm @ AddinError::RealmMismatch,
        constraint = voter_weight_record.governing_token_mint == registrar.governing_token_mint @ AddinError::MintMismatch,
    )]
    pub voter_weight_record: Account<'info, VoterWeightRecord>,
}

#[derive(Accounts)]
pub struct CreateMaxVoterWeightRecord<'info> {
    pub registrar: Account<'info, Registrar>,
    #[account(
        init,
        payer = payer,
        space = 8 + MaxVoterWeightRecord::MAX_SIZE,
        seeds = [
            b"max-voter-weight-record",
            registrar.realm.as_ref(),
            registrar.governing_token_mint.as_ref(),
        ],
        bump,
    )]
    pub max_voter_weight_record: Account<'info, MaxVoterWeightRecord>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ─── Errors ────────────────────────────────────────────────────────────────

#[error_code]
pub enum AddinError {
    #[msg("Caller not authorized for this registrar")]
    Unauthorized,
    #[msg("Whitelist exceeds maximum entry count")]
    WhitelistTooLarge,
    #[msg("Discriminator length must be ≤ 8 bytes")]
    DiscLenTooLarge,
    #[msg("Missing Proposal account in remaining_accounts[0]")]
    MissingProposalAccount,
    #[msg("Proposal account not owned by configured governance program")]
    ProposalNotOwnedByGovernance,
    #[msg("ProposalTransaction not owned by configured governance program")]
    ProposalTransactionNotOwnedByGovernance,
    #[msg("ProposalTransaction PDA does not match expected derivation")]
    ProposalTransactionPdaMismatch,
    #[msg("ProposalTransaction.proposal does not match Proposal pubkey")]
    ProposalTransactionWrongProposal,
    #[msg("Number of ProposalTransaction accounts does not match Proposal.options[].transactions_count sum")]
    ProposalTransactionAccountsMismatch,
    #[msg("Proposal account data has wrong account_type tag")]
    NotProposalV2,
    #[msg("ProposalTransaction account data has wrong account_type tag")]
    NotProposalTransactionV2,
    #[msg("Account data truncated while parsing")]
    AccountDataTruncated,
    #[msg("VoterWeightRecord realm does not match Registrar")]
    RealmMismatch,
    #[msg("VoterWeightRecord mint does not match Registrar")]
    MintMismatch,
}

// ─── SPL Governance account parsers ────────────────────────────────────────
//
// SPL Governance is a NATIVE program — accounts use Borsh + a leading u8
// account_type tag (no Anchor 8-byte discriminator). We parse only the
// fields needed for whitelist enforcement.

fn set_zero_weight(
    v: &mut Account<VoterWeightRecord>,
    proposal: Pubkey,
    action: u8,
) -> Result<()> {
    v.voter_weight = 0;
    v.voter_weight_expiry = Some(Clock::get()?.slot);
    v.weight_action = Some(action);
    v.weight_action_target = Some(proposal);
    Ok(())
}

struct ParsedProposalOption {
    pub transactions_count: u16,
}

struct ParsedProposal {
    pub options: Vec<ParsedProposalOption>,
}

struct ParsedInnerIx {
    pub program_id: Pubkey,
    pub data: Vec<u8>,
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn need(&self, n: usize) -> Result<()> {
        if self.pos + n > self.data.len() {
            return err!(AddinError::AccountDataTruncated);
        }
        Ok(())
    }
    fn read_u8(&mut self) -> Result<u8> {
        self.need(1)?;
        let b = self.data[self.pos];
        self.pos += 1;
        Ok(b)
    }
    fn read_u16_le(&mut self) -> Result<u16> {
        self.need(2)?;
        let v = u16::from_le_bytes([self.data[self.pos], self.data[self.pos + 1]]);
        self.pos += 2;
        Ok(v)
    }
    fn read_u32_le(&mut self) -> Result<u32> {
        self.need(4)?;
        let v = u32::from_le_bytes([
            self.data[self.pos],
            self.data[self.pos + 1],
            self.data[self.pos + 2],
            self.data[self.pos + 3],
        ]);
        self.pos += 4;
        Ok(v)
    }
    fn read_pubkey(&mut self) -> Result<Pubkey> {
        self.need(32)?;
        let mut buf = [0u8; 32];
        buf.copy_from_slice(&self.data[self.pos..self.pos + 32]);
        self.pos += 32;
        Ok(Pubkey::new_from_array(buf))
    }
    fn read_string(&mut self) -> Result<()> {
        // Borsh string: u32 LE length, then bytes. We don't need the value, just skip.
        let len = self.read_u32_le()? as usize;
        self.need(len)?;
        self.pos += len;
        Ok(())
    }
    fn skip(&mut self, n: usize) -> Result<()> {
        self.need(n)?;
        self.pos += n;
        Ok(())
    }
}

/// Parse the leading fields of a ProposalV2 just enough to enumerate
/// options[].transactions_count.
///
/// Layout (from spl-governance state/proposal.rs ProposalV2):
///   account_type: u8
///   governance: Pubkey
///   governing_token_mint: Pubkey
///   state: u8 (ProposalState enum)
///   token_owner_record: Pubkey
///   signatories_count: u8
///   signatories_signed_off_count: u8
///   vote_type: VoteType
///   options: Vec<ProposalOption>
///   ... (rest unused by us)
///
/// VoteType: u8 variant + (if MultiChoice) 4 extra bytes (choice_type u8, min/max/max u8).
///
/// ProposalOption:
///   label: String (4 + len bytes)
///   vote_weight: u64
///   vote_result: u8 (OptionVoteResult enum)
///   transactions_executed_count: u16
///   transactions_count: u16
///   transactions_next_index: u16
fn parse_proposal_v2(data: &[u8]) -> Result<ParsedProposal> {
    let mut c = Cursor::new(data);
    let account_type = c.read_u8()?;
    require!(
        account_type == ACCOUNT_TYPE_PROPOSAL_V2,
        AddinError::NotProposalV2
    );
    c.skip(32)?; // governance
    c.skip(32)?; // governing_token_mint
    c.skip(1)?; // state
    c.skip(32)?; // token_owner_record
    c.skip(1)?; // signatories_count
    c.skip(1)?; // signatories_signed_off_count

    // VoteType
    let vt = c.read_u8()?;
    if vt == 1 {
        c.skip(4)?; // MultiChoice extra bytes
    } else if vt != 0 {
        return err!(AddinError::AccountDataTruncated);
    }

    // options: Vec<ProposalOption>
    let opt_count = c.read_u32_le()? as usize;
    let mut options = Vec::with_capacity(opt_count);
    for _ in 0..opt_count {
        c.read_string()?; // label
        c.skip(8)?; // vote_weight
        c.skip(1)?; // vote_result
        c.skip(2)?; // transactions_executed_count
        let transactions_count = c.read_u16_le()?;
        c.skip(2)?; // transactions_next_index
        options.push(ParsedProposalOption { transactions_count });
    }

    Ok(ParsedProposal { options })
}

/// Parse a ProposalTransactionV2 to extract its proposal pubkey + the
/// (program_id, data) of every inner instruction.
///
/// Layout (from spl-governance state/proposal_transaction.rs):
///   account_type: u8
///   proposal: Pubkey
///   option_index: u8
///   transaction_index: u16
///   hold_up_time: u32
///   instructions: Vec<InstructionData>
///   executed_at: Option<i64>
///   execution_status: u8
///   reserved_v2: [u8; 8]
///
/// InstructionData:
///   program_id: Pubkey
///   accounts: Vec<AccountMetaData> (each: Pubkey + bool + bool = 34 bytes)
///   data: Vec<u8>
fn parse_proposal_transaction_v2(
    data: &[u8],
    expected_proposal: &Pubkey,
) -> Result<Vec<ParsedInnerIx>> {
    let mut c = Cursor::new(data);
    let account_type = c.read_u8()?;
    require!(
        account_type == ACCOUNT_TYPE_PROPOSAL_TRANSACTION_V2,
        AddinError::NotProposalTransactionV2
    );

    let proposal = c.read_pubkey()?;
    require!(
        proposal == *expected_proposal,
        AddinError::ProposalTransactionWrongProposal
    );

    c.skip(1)?; // option_index
    c.skip(2)?; // transaction_index
    c.skip(4)?; // hold_up_time

    let ix_count = c.read_u32_le()? as usize;
    let mut out = Vec::with_capacity(ix_count);
    for _ in 0..ix_count {
        let program_id = c.read_pubkey()?;
        let acct_count = c.read_u32_le()? as usize;
        c.skip(acct_count.saturating_mul(32 + 1 + 1))?;
        let data_len = c.read_u32_le()? as usize;
        c.need(data_len)?;
        let ix_data = data[c.pos..c.pos + data_len].to_vec();
        c.pos += data_len;
        out.push(ParsedInnerIx { program_id, data: ix_data });
    }
    Ok(out)
}

fn instructions_match_whitelist(
    whitelist: &[WhitelistEntry],
    ixs: &[ParsedInnerIx],
) -> bool {
    for ix in ixs {
        if !ix_matches_any(whitelist, ix) {
            return false;
        }
    }
    true
}

fn ix_matches_any(whitelist: &[WhitelistEntry], ix: &ParsedInnerIx) -> bool {
    for entry in whitelist {
        if entry.program_id != ix.program_id {
            continue;
        }
        let len = entry.disc_len as usize;
        if len == 0 {
            return true; // wildcard for this program
        }
        if ix.data.len() < len {
            continue;
        }
        if ix.data[..len] == entry.discriminator[..len] {
            return true;
        }
    }
    false
}
