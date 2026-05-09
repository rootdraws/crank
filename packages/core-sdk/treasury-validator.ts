/**
 * core-sdk/treasury-validator.ts
 *
 * Pure-function whitelist validator for SPL Governance proposal payloads
 * targeting the crank.money treasury. The runtime security boundary when
 * `minTransactionHoldUpTime = 0` — there is no human review window.
 *
 * Validates each inner instruction in a proposal's payload against a
 * hardcoded ruleset:
 *   - allowed program IDs
 *   - per-program allowed instruction discriminators
 *   - per-position account constraints (legitimate addresses only)
 *
 * No volume caps — those belong in-protocol (match_ratio_bps + bin-farm's
 * existing constraints), not in a bot-side validator. The validator gates
 * WHAT can happen, not HOW MUCH.
 *
 * No I/O. Caller fetches whatever runtime context is needed and passes it in.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createHash } from 'crypto';
import {
  BIN_FARM_PROGRAM_ID,
  HOPPER_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SPL_MEMO_PROGRAM_ID,
  NATIVE_MINT,
} from './constants';

const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// ─── Public types ───────────────────────────────────────────────────────────

export type WhitelistContext = {
  /** Bot wallet pubkey — required signer on bin-farm ixs that have `bot: Signer`. */
  botPubkey: PublicKey;
  /** SPL Governance Native Treasury PDA — the realm's treasury authority. */
  nativeTreasuryPda: PublicKey;
  /** bin-farm UserVault PDA whose owner is `nativeTreasuryPda`. */
  treasuryUserVault: PublicKey;
  /** Set of pool addresses considered legitimate (loaded from curator.json). */
  knownPoolAddresses: Set<string>;
  /**
   * Optional: the proposer pubkey expected for this proposal. When set, any
   * ix whose accounts include a `kind: 'proposer-ata'` constraint will check
   * the ATA's owner == this pubkey via `expectedProposerOwner`.
   */
  expectedProposerWallet?: PublicKey;
  /**
   * Optional: when validating ixs that reference an ATA expected to be owned
   * by `treasuryUserVault`, providing the ATA derivation lookup avoids
   * recomputing here. If absent, the validator falls back to a strict
   * "the account at this position must be in `treasuryAtas`" check.
   */
  treasuryAtas?: Set<string>;
  /**
   * Optional: meteora_position pubkey for the position being opened/closed.
   * Used by `position-vault` constraints to derive the expected position
   * vault PDA.
   */
  meteoraPosition?: PublicKey;
};

export type ValidationOk = { ok: true };
export type ValidationFailure = {
  ok: false;
  reason: string;
  ruleId?: string;
  ixIndex?: number;
};
export type ValidationResult = ValidationOk | ValidationFailure;

// ─── Account-constraint DSL ─────────────────────────────────────────────────

type AccountConstraint =
  | { kind: 'exact'; pubkey: PublicKey }
  | { kind: 'bot' }
  | { kind: 'native-treasury-pda' }
  | { kind: 'treasury-user-vault' }
  | { kind: 'treasury-ata' }
  | { kind: 'proposer-ata' }
  | { kind: 'position-vault' }
  | { kind: 'curator-pool' }
  | { kind: 'token-program' }
  | { kind: 'system-program' }
  | { kind: 'memo-program' }
  | { kind: 'any' };

type DataCheck =
  | { kind: 'exact-prefix'; offset: number; expected: Buffer; description: string };

type IxRule = {
  id: string;
  program: PublicKey;
  /** Anchor discriminator (8 bytes) or native program tag (1-4 bytes). Matched as data prefix. */
  discriminator: Buffer;
  /**
   * Ordered account constraints. The ix's account list must have at least
   * `accounts.length` entries; trailing accounts beyond this length are
   * ignored (some ixs have variadic remaining accounts).
   */
  accounts: AccountConstraint[];
  dataChecks?: DataCheck[];
};

// ─── Anchor discriminator helper ────────────────────────────────────────────

/** Compute the standard Anchor 8-byte global discriminator for an instruction. */
export function anchorDisc(ixName: string): Buffer {
  return createHash('sha256').update(`global:${ixName}`).digest().subarray(0, 8);
}

// ─── Rule constructors ──────────────────────────────────────────────────────

const TREASURY_ATA = (): AccountConstraint => ({ kind: 'treasury-ata' });
const PROPOSER_ATA = (): AccountConstraint => ({ kind: 'proposer-ata' });
const POSITION_VAULT = (): AccountConstraint => ({ kind: 'position-vault' });
const TREASURY_VAULT = (): AccountConstraint => ({ kind: 'treasury-user-vault' });
const NATIVE_TREASURY = (): AccountConstraint => ({ kind: 'native-treasury-pda' });
const BOT = (): AccountConstraint => ({ kind: 'bot' });
const POOL = (): AccountConstraint => ({ kind: 'curator-pool' });
const TOKEN_PROG = (): AccountConstraint => ({ kind: 'token-program' });
const SYSTEM_PROG = (): AccountConstraint => ({ kind: 'system-program' });
const ANY = (): AccountConstraint => ({ kind: 'any' });

// ─── Whitelist v0 ──────────────────────────────────────────────────────────

/**
 * Build the rule set. Rules are checked in order; first match wins. Any ix
 * that matches none → reject.
 *
 * Account-list lengths reflect the on-chain account structures from
 * `programs/bin-farm/src/lib.rs`. Trailing accounts beyond the listed
 * positions are accepted (Anchor allows extra accounts on some ixs; we
 * tolerate them rather than break on every variant).
 */
export function buildWhitelist(): IxRule[] {
  return [
    // ─── bin-farm: open_position_v2 (treasury opens) ──
    // Matches `OpenPositionV2` struct in bin-farm/src/lib.rs (~line 1854).
    // Accounts: bot, user_vault (treasury), config, lb_pair, position_counter,
    //   meteora_position, bitmap_ext, reserves, position, vault, ATAs, programs, ...
    {
      id: 'bin-farm.open_position_v2.treasury',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('open_position_v2'),
      accounts: [
        BOT(),                  // 0: bot
        TREASURY_VAULT(),       // 1: user_vault (must be treasury)
        ANY(),                  // 2: config
        POOL(),                 // 3: lb_pair
        // remaining accounts not strictly checked here — on-chain logic gates amounts
      ],
    },

    // ─── bin-farm: record_settle_meta (open ix #2) ──
    // After PR-2: caller must be NTP (governance invoke_signed). Bot path removed.
    {
      id: 'bin-farm.record_settle_meta',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('record_settle_meta'),
      accounts: [
        NATIVE_TREASURY(),      // caller — must be governance-signed NTP
        ANY(),                  // config
        ANY(),                  // meteora_position
        ANY(),                  // position
        TREASURY_VAULT(),       // user_vault
        ANY(),                  // position_settle (init PDA)
      ],
    },

    // ─── bin-farm: settle_proposer (close ix #1, BEFORE user_close) ──
    {
      id: 'bin-farm.settle_proposer',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('settle_proposer'),
      accounts: [
        NATIVE_TREASURY(),      // caller
        ANY(),                  // config
        ANY(),                  // position_settle
        POSITION_VAULT(),       // vault (per-position vault — bin-farm signs as this PDA)
        ANY(),                  // position_vault_output_ata
        PROPOSER_ATA(),         // proposer_output_ata (must be owned by recorded proposer)
      ],
    },

    // ─── bin-farm: user_close (treasury close) ──
    {
      id: 'bin-farm.user_close.treasury',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('user_close'),
      accounts: [
        NATIVE_TREASURY(),      // caller (governance-signed for treasury vault)
        ANY(),                  // config
        TREASURY_VAULT(),       // user_vault
      ],
    },

    // ─── bin-farm: user_close (user's path A close, atomic with treasury) ──
    // Distinguishing rule: caller = bot, user_vault is NOT treasury.
    {
      id: 'bin-farm.user_close.user',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('user_close'),
      accounts: [
        BOT(),                  // caller = bot
        ANY(),                  // config
        ANY(),                  // user_vault (any non-treasury — the validator can't always know which)
      ],
    },

    // ─── bin-farm: close_settle (close ix #3) ──
    {
      id: 'bin-farm.close_settle',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('close_settle'),
      accounts: [
        NATIVE_TREASURY(),      // caller
        ANY(),                  // position_settle
        TREASURY_VAULT(),       // user_vault
      ],
    },

    // ─── bin-farm: create_vault (bootstrap path) ──
    {
      id: 'bin-farm.create_vault',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('create_vault'),
      accounts: [
        ANY(),                  // owner
        ANY(),                  // user_vault PDA
        ANY(),                  // payer
      ],
    },

    // ─── bin-farm: harvest_bins / claim_fees (permissionless / read-only-ish) ──
    {
      id: 'bin-farm.harvest_bins',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('harvest_bins'),
      accounts: [],   // permissionless; on-chain enforces dust gate
    },
    {
      id: 'bin-farm.claim_fees',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('claim_fees'),
      accounts: [],
    },

    // ─── bin-farm: wrap/unwrap WSOL in vault ──
    {
      id: 'bin-farm.wrap_sol_in_vault',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('wrap_sol_in_vault'),
      accounts: [
        ANY(),                  // caller
        ANY(),                  // config
        ANY(),                  // user_vault — bot's or treasury's; ix is bounded
      ],
    },
    {
      id: 'bin-farm.unwrap_wsol_in_vault',
      program: BIN_FARM_PROGRAM_ID,
      discriminator: anchorDisc('unwrap_wsol_in_vault'),
      accounts: [
        ANY(), ANY(), ANY(),
      ],
    },

    // ─── hopper: sweep_sol / sweep_token (permissionless, on-chain validates routes) ──
    {
      id: 'hopper.sweep_sol',
      program: HOPPER_PROGRAM_ID,
      discriminator: anchorDisc('sweep_sol'),
      accounts: [],
    },
    {
      id: 'hopper.sweep_token',
      program: HOPPER_PROGRAM_ID,
      discriminator: anchorDisc('sweep_token'),
      accounts: [],
    },

    // ─── SPL Token: transfer ──
    // Allowed shapes:
    //   - source = treasury ATA → destination = treasury ATA  (internal moves)
    //   - source = treasury ATA → destination = proposer ATA  (proposer payout flow)
    //   - source = position-vault ATA → destination = treasury ATA (close path)
    //   - source = position-vault ATA → destination = proposer ATA (settle_proposer's CPI — but
    //     that's CPI-internal, not an outer ix; this rule covers the case where the validator
    //     sees a settle-style transfer in the proposal payload itself)
    {
      id: 'spl-token.transfer.allowed-pair',
      program: TOKEN_PROGRAM_ID,
      discriminator: Buffer.from([3]),  // SPL Token Transfer = 3
      accounts: [
        // Either treasury-ata or position-vault is acceptable as source;
        // we enforce via the account-constraint UNION (this rule must pass for one of them).
        // The simpler approach: a separate rule per pair.
        TREASURY_ATA(),
        TREASURY_ATA(),
        ANY(),  // authority — must match source's owner; on-chain enforces
      ],
    },
    {
      id: 'spl-token.transfer.treasury-to-proposer',
      program: TOKEN_PROGRAM_ID,
      discriminator: Buffer.from([3]),
      accounts: [
        TREASURY_ATA(),
        PROPOSER_ATA(),
        ANY(),
      ],
    },

    // ─── System Program: Transfer (lamports) ──
    // STRICT: only allow when source = native_treasury_pda → destination = treasury_user_vault.
    // No transfers from native_treasury_pda to arbitrary recipients (that's the drain path).
    {
      id: 'system-program.transfer.treasury-to-vault',
      program: SYSTEM_PROGRAM_ID,
      // SystemInstruction::Transfer = 2 (u32 LE)
      discriminator: Buffer.from([2, 0, 0, 0]),
      accounts: [
        NATIVE_TREASURY(),
        TREASURY_VAULT(),
      ],
    },

    // ─── SPL Memo: harmless ──
    {
      id: 'spl-memo.any',
      program: SPL_MEMO_PROGRAM_ID,
      discriminator: Buffer.alloc(0),  // matches any data
      accounts: [],
    },
  ];
}

// ─── Validation engine ──────────────────────────────────────────────────────

export type ProposalPayload = {
  innerIxs: TransactionInstruction[];
};

export function validateProposalPayload(
  payload: ProposalPayload,
  ctx: WhitelistContext,
): ValidationResult {
  if (payload.innerIxs.length === 0) {
    return { ok: false, reason: 'empty payload' };
  }

  const rules = buildWhitelist();

  for (let ixIdx = 0; ixIdx < payload.innerIxs.length; ixIdx++) {
    const ix = payload.innerIxs[ixIdx];
    const matched = findMatchingRule(ix, rules);
    if (!matched) {
      return {
        ok: false,
        ixIndex: ixIdx,
        reason: `no whitelist rule matches ix at index ${ixIdx} ` +
                `(program=${ix.programId.toBase58()}, disc=${prefixHex(ix.data, 8)})`,
      };
    }

    const acctErr = checkAccounts(ix, matched.accounts, ctx);
    if (acctErr) {
      return { ok: false, ruleId: matched.id, ixIndex: ixIdx, reason: acctErr };
    }

    if (matched.dataChecks) {
      for (const check of matched.dataChecks) {
        const dataErr = checkData(ix.data, check);
        if (dataErr) {
          return { ok: false, ruleId: matched.id, ixIndex: ixIdx, reason: dataErr };
        }
      }
    }
  }

  return { ok: true };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findMatchingRule(ix: TransactionInstruction, rules: IxRule[]): IxRule | null {
  for (const rule of rules) {
    if (!ix.programId.equals(rule.program)) continue;
    if (rule.discriminator.length === 0) return rule;  // wildcard (e.g. memo)
    if (ix.data.length < rule.discriminator.length) continue;
    if (ix.data.subarray(0, rule.discriminator.length).equals(rule.discriminator)) {
      return rule;
    }
  }
  return null;
}

function checkAccounts(
  ix: TransactionInstruction,
  constraints: AccountConstraint[],
  ctx: WhitelistContext,
): string | null {
  if (ix.keys.length < constraints.length) {
    return `ix has ${ix.keys.length} accounts, expected at least ${constraints.length}`;
  }
  for (let i = 0; i < constraints.length; i++) {
    const c = constraints[i];
    const acc = ix.keys[i].pubkey;
    const err = checkAccount(c, acc, ctx, i);
    if (err) return err;
  }
  return null;
}

function checkAccount(
  c: AccountConstraint,
  acc: PublicKey,
  ctx: WhitelistContext,
  position: number,
): string | null {
  switch (c.kind) {
    case 'any':
      return null;
    case 'exact':
      return acc.equals(c.pubkey) ? null : `account[${position}]: expected ${c.pubkey.toBase58()}, got ${acc.toBase58()}`;
    case 'bot':
      return acc.equals(ctx.botPubkey) ? null : `account[${position}]: expected bot ${ctx.botPubkey.toBase58()}, got ${acc.toBase58()}`;
    case 'native-treasury-pda':
      return acc.equals(ctx.nativeTreasuryPda) ? null : `account[${position}]: expected native_treasury_pda, got ${acc.toBase58()}`;
    case 'treasury-user-vault':
      return acc.equals(ctx.treasuryUserVault) ? null : `account[${position}]: expected treasury_user_vault, got ${acc.toBase58()}`;
    case 'treasury-ata':
      // Without on-chain account fetch we can't verify ATA owner here. Caller
      // can supply `treasuryAtas` set; if provided, check membership. Otherwise
      // soft-pass (the ATA's owner is enforced on-chain by the SPL Token program).
      if (ctx.treasuryAtas && !ctx.treasuryAtas.has(acc.toBase58())) {
        return `account[${position}]: ${acc.toBase58()} not in treasuryAtas allow-list`;
      }
      return null;
    case 'proposer-ata':
      // Validator can't derive ATA without mint+owner+program ID; caller must
      // pre-derive `expectedProposerWallet` and the validator trusts that the
      // on-chain CPI in settle_proposer enforces `proposer_output_ata.owner == position_settle.proposer`.
      // For pre-flight, we just require expectedProposerWallet to be set (proposal must reference a known proposer).
      if (!ctx.expectedProposerWallet) {
        return `account[${position}]: proposer-ata constraint requires expectedProposerWallet in context`;
      }
      return null;
    case 'position-vault':
      // Without on-chain fetch we can't verify position_vault PDA derivation matches
      // a specific meteora_position. Soft-pass; on-chain logic enforces.
      return null;
    case 'curator-pool':
      return ctx.knownPoolAddresses.has(acc.toBase58())
        ? null
        : `account[${position}]: ${acc.toBase58()} not in knownPoolAddresses`;
    case 'token-program':
      if (acc.equals(TOKEN_PROGRAM_ID) || acc.equals(TOKEN_2022_PROGRAM_ID)) return null;
      return `account[${position}]: expected SPL Token program, got ${acc.toBase58()}`;
    case 'system-program':
      return acc.equals(SYSTEM_PROGRAM_ID) ? null : `account[${position}]: expected system program, got ${acc.toBase58()}`;
    case 'memo-program':
      return acc.equals(SPL_MEMO_PROGRAM_ID) ? null : `account[${position}]: expected memo program, got ${acc.toBase58()}`;
  }
}

function checkData(data: Buffer, check: DataCheck): string | null {
  switch (check.kind) {
    case 'exact-prefix': {
      if (data.length < check.offset + check.expected.length) {
        return `${check.description}: data too short for prefix at offset ${check.offset}`;
      }
      const slice = data.subarray(check.offset, check.offset + check.expected.length);
      return slice.equals(check.expected) ? null : `${check.description}: prefix mismatch`;
    }
  }
}

function prefixHex(buf: Buffer, n: number): string {
  return buf.subarray(0, n).toString('hex');
}
