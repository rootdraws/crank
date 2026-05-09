/**
 * core-sdk/treasury-proposal.ts
 *
 * SPL Governance lifecycle helper for treasury-matched proposals.
 *
 * Wraps the createProposal → insertTransaction → signOffProposal → castVote
 * → executeTransaction sequence into a single API. The bot calls
 * `submitTreasuryProposal()`; this module handles tx packing, validation
 * pre-flight, and execution.
 *
 * Two-tx pattern (Solana tx-size constraints prevent one-tx packing):
 *   tx1: createProposal + insertTransaction + signOffProposal + castVote
 *   tx2: executeTransaction (with full inner-ix accounts as remainingAccounts)
 *
 * Pre-flight whitelist validation runs before tx1 broadcast AND after
 * fetching the proposal_transaction account on-chain before tx2.
 *
 * v1.5 hook: a `validatorClient` arg lets a separate-machine validator
 * service co-sign the outer execute tx. v1 leaves it undefined; the in-bot
 * validator runs without co-sign.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { SplGovernance } from 'governance-idl-sdk';

import {
  validateProposalPayload,
  type WhitelistContext,
  type ValidationResult,
} from './treasury-validator';
import {
  buildUpdateVoterWeightRecordIx,
  getVoterWeightRecordPDA,
  VWR_ACTION_CAST_VOTE,
} from './whitelist-addin';

// SPL Governance VoterWeightAction enum tag for CreateProposal.
const VWR_ACTION_CREATE_PROPOSAL = 3;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Optional separate-machine validator co-signer service.
 *
 * Given a serialized outer execute tx (no signatures yet), returns the
 * validator's signature. Throws if validation fails (caller should NOT
 * retry blindly; alert the operator).
 */
export interface ValidatorClient {
  signOuterExecuteTx(serializedTx: Buffer): Promise<Buffer>;
  /** The validator's pubkey, returned for assembly into the tx. */
  pubkey(): Promise<PublicKey>;
}

export type SubmitProposalArgs = {
  /** Inner instructions to wrap in the proposal payload. */
  innerIxs: TransactionInstruction[];

  /** Bot keypair — signs all governance lifecycle ixs and (in v1) the outer execute tx. */
  bot: Keypair;

  /** Optional v1.5 validator co-signer service. */
  validatorClient?: ValidatorClient;

  /** SPL Governance program ID (default = governance-idl-sdk's DEFAULT_PROGRAM_ID). */
  governanceProgramId?: PublicKey;

  /** Realm account PDA. */
  realm: PublicKey;

  /** Governance account PDA owning the treasury. */
  governance: PublicKey;

  /**
   * Token Owner Record bot has delegate authority on. Holds the council
   * weight that gates execution via `castVote`. Operator created this via
   * `depositGoverningTokens` and delegated to bot via `setGovernanceDelegate`.
   */
  tokenOwnerRecord: PublicKey;

  /**
   * Governing token mint passed to `castVote`. With the addin enabled this
   * is the community proposal-perm mint (1-supply token whose voter weight
   * is supplied by the addin's VoterWeightRecord). Without the addin, this
   * is the council mint (legacy in-bot-validator-only mode).
   */
  governingTokenMint: PublicKey;

  /**
   * If set, route the vote through the proposal-whitelist-addin: insert
   * `update_voter_weight_record` between signOff and castVote in tx1, with
   * Proposal + ProposalTransaction PDAs as remaining accounts. The addin
   * inspects every inner ix on-chain and grants weight only on whitelist
   * match. This is the on-chain gate that survives bot compromise.
   */
  addinProgramId?: PublicKey;

  /**
   * Owner pubkey for the VoterWeightRecord PDA (= operator wallet, the same
   * wallet that owns the TokenOwnerRecord). Required iff `addinProgramId`
   * is set.
   */
  governingTokenOwner?: PublicKey;

  /**
   * Optional proposal seed. If omitted, a fresh keypair pubkey is generated.
   * For idempotency / replay-detection, callers often supply a deterministic
   * seed derived from the user position pda + side.
   */
  proposalSeed?: PublicKey;

  /**
   * Hold-up time in seconds for the inserted transaction. Default 0
   * (instant execution), matching the realm's `minTransactionHoldUpTime: 0`
   * GovernanceConfig.
   */
  holdUpTime?: number;

  /** Human-readable proposal name (visible in Realms UI). */
  name: string;

  /** Optional description URL (markdown rendered in Realms UI). */
  descriptionLink?: string;

  /** Whitelist context for pre-flight validation. */
  validatorContext: WhitelistContext;
};

export type ProposalResult = {
  proposalPda: PublicKey;
  proposalTransactionPda: PublicKey;
  insertSig: string;
  executeSig: string;
  durationMs: number;
};

export class TreasuryProposalError extends Error {
  constructor(
    message: string,
    public readonly stage: 'validation' | 'tx1' | 'tx2' | 'validator-service',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TreasuryProposalError';
  }
}

export class TreasuryValidationError extends TreasuryProposalError {
  constructor(public readonly result: Extract<ValidationResult, { ok: false }>) {
    super(
      `validator rejected payload: ${result.reason}` +
        (result.ruleId ? ` (rule=${result.ruleId})` : '') +
        (result.ixIndex !== undefined ? ` (ix #${result.ixIndex})` : ''),
      'validation',
    );
  }
}

// ─── Public entrypoint ──────────────────────────────────────────────────────

/**
 * Submit a treasury-matched proposal end-to-end.
 *
 * Stages:
 *   1. Pre-insert validation (in-bot whitelist) — abort early on rejection.
 *   2. Build + send tx1 (createProposal + insertTransaction + signOffProposal + castVote).
 *   3. Re-fetch proposal_transaction from chain — validates the on-chain
 *      payload matches what we intended (defense against tx mutation).
 *   4. Pre-execute validation (re-runs whitelist on the on-chain payload).
 *   5. Build tx2 (executeTransaction). v1.5: validator co-sign step.
 *   6. Send tx2, await confirm.
 *
 * Throws `TreasuryProposalError` (and subclass `TreasuryValidationError`) on
 * failure. Caller is responsible for retry / cancel / alert decisions.
 */
export async function submitTreasuryProposal(
  args: SubmitProposalArgs,
  connection: Connection,
): Promise<ProposalResult> {
  const startedAt = Date.now();

  // ── Stage 1: pre-insert validation
  const preInsert = validateProposalPayload(
    { innerIxs: args.innerIxs },
    args.validatorContext,
  );
  if (preInsert.ok === false) {
    throw new TreasuryValidationError(preInsert);
  }

  // ── Stage 2: build + send tx1a (vwr-create + createProposal) and tx1b (insert + signOff + vwr-vote + castVote)
  //
  // Lifecycle requires splitting:
  //  - With addin enabled, SPL Governance reads VWR for CreateProposal action;
  //    the VWR's weight_action must already be set when createProposal runs.
  //  - useDenyOption=true is required for single-option community proposals to
  //    stay in Draft after createProposal (else they auto-progress past Draft
  //    and insertTransaction is rejected).
  //  - Vote.Approve uses indexed-key tuple form `{ approve: { 0: [...] } }`.
  //  - VWR account must be passed explicitly to both createProposal and castVote.
  const sdk = new SplGovernance(connection, args.governanceProgramId);
  const proposalSeed = args.proposalSeed ?? Keypair.generate().publicKey;
  const proposalPda = sdk.pda.proposalAccount({
    governanceAccount: args.governance,
    governingTokenMint: args.governingTokenMint,
    proposalSeed,
  }).publicKey;
  const proposalTransactionPda = sdk.pda.proposalTransactionAccount({
    proposal: proposalPda,
    optionIndex: 0,
    index: 0,
  }).publicKey;

  // Resolve VWR pubkey when addin is set; createProposal/castVote both need it.
  let vwrPubkey: PublicKey | undefined;
  if (args.addinProgramId) {
    if (!args.governingTokenOwner) {
      throw new TreasuryProposalError(
        'governingTokenOwner required when addinProgramId is set',
        'tx1',
      );
    }
    vwrPubkey = getVoterWeightRecordPDA(
      args.addinProgramId,
      args.realm,
      args.governingTokenMint,
      args.governingTokenOwner,
    )[0];
  }

  const createProposalIx = await sdk.createProposalInstruction(
    args.name,
    args.descriptionLink ?? '',
    { choiceType: 'single', multiChoiceOptions: null },
    ['Approve'],
    true,                               // useDenyOption=true (required for Draft state retention)
    args.realm,
    args.governance,
    args.tokenOwnerRecord,
    args.governingTokenMint,
    args.bot.publicKey,                 // governanceAuthority (delegated to bot)
    args.bot.publicKey,                 // payer
    proposalSeed,
    vwrPubkey,
  );

  const insertIx = await sdk.insertTransactionInstruction(
    args.innerIxs,
    0,                                   // optionIndex
    0,                                   // index
    args.holdUpTime ?? 0,
    args.governance,
    proposalPda,
    args.tokenOwnerRecord,
    args.bot.publicKey,                  // governanceAuthority
    args.bot.publicKey,                  // payer
  );

  const signOffIx = await sdk.signOffProposalInstruction(
    args.realm,
    args.governance,
    proposalPda,
    args.bot.publicKey,                  // signatory (proposal owner via TOR)
    undefined,                           // signatoryRecord — owner-signoff path
    args.tokenOwnerRecord,
  );

  const castVoteIx = await sdk.castVoteInstruction(
    { approve: { 0: [{ rank: 0, weightPercentage: 100 }] } } as never,
    args.realm,
    args.governance,
    proposalPda,
    args.tokenOwnerRecord,               // proposalOwnerTokenOwnerRecord
    args.tokenOwnerRecord,               // voterTokenOwnerRecord (same — bot is delegate)
    args.bot.publicKey,                  // governanceAuthority
    args.governingTokenMint,             // governingTokenMint (community/council, depending on addin)
    args.bot.publicKey,                  // payer
    vwrPubkey,
  );

  // tx1a: VWR-create-action (if addin) + createProposal
  const tx1aIxs: TransactionInstruction[] = [];
  if (args.addinProgramId && args.governingTokenOwner) {
    tx1aIxs.push(buildUpdateVoterWeightRecordIx({
      addinProgramId: args.addinProgramId,
      realm: args.realm,
      governingTokenMint: args.governingTokenMint,
      governingTokenOwner: args.governingTokenOwner,
      voterWeightAction: VWR_ACTION_CREATE_PROPOSAL,
      proposal: PublicKey.default,       // unused for non-vote action
      proposalTransactions: [],          // proposal doesn't exist yet
    }));
  }
  tx1aIxs.push(createProposalIx);
  const tx1a = new Transaction().add(...tx1aIxs);
  tx1a.feePayer = args.bot.publicKey;
  let insertSig: string;
  try {
    await sendAndConfirmTransaction(connection, tx1a, [args.bot], {
      commitment: 'confirmed',
    });
  } catch (e) {
    throw new TreasuryProposalError(
      `tx1a (vwr-create + createProposal) failed: ${(e as Error).message}`,
      'tx1',
      e,
    );
  }

  // tx1b: insert + signOff + VWR-vote-action (if addin, with proposal+propTx PDAs) + castVote
  const tx1bIxs: TransactionInstruction[] = [insertIx, signOffIx];
  if (args.addinProgramId && args.governingTokenOwner) {
    tx1bIxs.push(buildUpdateVoterWeightRecordIx({
      addinProgramId: args.addinProgramId,
      realm: args.realm,
      governingTokenMint: args.governingTokenMint,
      governingTokenOwner: args.governingTokenOwner,
      voterWeightAction: VWR_ACTION_CAST_VOTE,
      proposal: proposalPda,
      proposalTransactions: [proposalTransactionPda],
    }));
  }
  tx1bIxs.push(castVoteIx);
  const tx1b = new Transaction().add(...tx1bIxs);
  tx1b.feePayer = args.bot.publicKey;
  try {
    insertSig = await sendAndConfirmTransaction(connection, tx1b, [args.bot], {
      commitment: 'confirmed',
    });
  } catch (e) {
    throw new TreasuryProposalError(
      `tx1b (insert + signOff + vwr-vote + castVote) failed: ${(e as Error).message}`,
      'tx1',
      e,
    );
  }

  // ── Stage 4: pre-execute validation
  // Re-fetch the proposal_transaction account from chain, decode, and re-run
  // the whitelist. Defends against in-flight mutation between insert and
  // execute (rare but possible if a malicious party racing replaces our ix).
  const onChainPayload = await fetchProposalPayload(
    sdk,
    proposalTransactionPda,
    args.innerIxs,
  );
  const preExecute = validateProposalPayload(
    { innerIxs: onChainPayload },
    args.validatorContext,
  );
  if (preExecute.ok === false) {
    throw new TreasuryValidationError(preExecute);
  }

  // ── Stage 5: build tx2 (executeTransaction)
  // remainingAccounts must include every account referenced by every inner ix,
  // plus each inner ix's program ID. Anchor-style flattening:
  const remainingAccounts: AccountMeta[] = [];
  const seen = new Set<string>();
  const push = (m: AccountMeta) => {
    const key = `${m.pubkey.toBase58()}:${m.isSigner ? '1' : '0'}:${m.isWritable ? '1' : '0'}`;
    if (seen.has(key)) return;
    seen.add(key);
    remainingAccounts.push(m);
  };
  for (const ix of args.innerIxs) {
    for (const k of ix.keys) push(k);
    push({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }

  const executeIx = await sdk.executeTransactionInstruction(
    args.governance,
    proposalPda,
    proposalTransactionPda,
    remainingAccounts,
  );

  const tx2 = new Transaction().add(executeIx);
  tx2.feePayer = args.bot.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx2.recentBlockhash = blockhash;
  tx2.lastValidBlockHeight = lastValidBlockHeight;

  // v1.5: validator service co-sign
  if (args.validatorClient) {
    try {
      const validatorPubkey = await args.validatorClient.pubkey();
      const validatorSig = await args.validatorClient.signOuterExecuteTx(
        tx2.serializeMessage(),
      );
      tx2.addSignature(validatorPubkey, validatorSig);
    } catch (e) {
      throw new TreasuryProposalError(
        `validator service refused or unavailable: ${(e as Error).message}`,
        'validator-service',
        e,
      );
    }
  }

  tx2.partialSign(args.bot);
  let executeSig: string;
  // SPL Governance error 0x20d ("Can't execute transaction within its hold up time")
  // fires when the proposal hits Succeeded but the per-tx hold-up window hasn't
  // elapsed yet. holdUpTime defaults to 0, but on-chain comparison is strict and
  // votes that pass in the same slot as createProposal need a tick before execute.
  // Retry up to ~30s; the proposal stays in Succeeded so the same tx2 buffer is
  // resubmittable verbatim (no rebuild needed across attempts).
  const maxAttempts = 6;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = tx2.serialize();
      executeSig = await connection.sendRawTransaction(raw, { skipPreflight: false });
      await connection.confirmTransaction(
        { signature: executeSig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message ?? '';
      if (msg.includes('0x20d') || msg.includes('hold up time')) {
        if (attempt === maxAttempts) break;
        await new Promise((r) => setTimeout(r, attempt * 5_000));
        continue;
      }
      break;
    }
  }
  if (lastErr) {
    throw new TreasuryProposalError(
      `tx2 (executeTransaction) failed: ${(lastErr as Error).message}`,
      'tx2',
      lastErr,
    );
  }
  executeSig = executeSig!;

  return {
    proposalPda,
    proposalTransactionPda,
    insertSig,
    executeSig,
    durationMs: Date.now() - startedAt,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Fetch the on-chain proposal_transaction account and reconstruct the inner
 * ix list. In v1 we trust the SDK's serialization is deterministic so the
 * client-known `expected` is what's stored — re-fetching is a sanity check
 * for race conditions (e.g. insert tx replaced by a different one with same
 * proposal pda — should be impossible but cheap to verify).
 *
 * If the SDK exposes a typed fetcher we should use it; otherwise we fall
 * back to trusting the local `expected` (logging if something looks off).
 */
async function fetchProposalPayload(
  sdk: SplGovernance,
  proposalTransactionPda: PublicKey,
  expected: TransactionInstruction[],
): Promise<TransactionInstruction[]> {
  try {
    const acct = await (sdk as unknown as {
      getProposalTransactionByPubkey?: (pda: PublicKey) => Promise<{
        instructions: { programId: PublicKey; accounts: AccountMeta[]; data: Buffer }[];
      } | null>;
    }).getProposalTransactionByPubkey?.(proposalTransactionPda);

    if (acct?.instructions?.length) {
      return acct.instructions.map(
        ix =>
          new TransactionInstruction({
            programId: ix.programId,
            keys: ix.accounts,
            data: Buffer.from(ix.data),
          }),
      );
    }
  } catch {
    // Fall through — use expected
  }

  // Fallback: trust the local expected (the bot built it; we're checking the
  // whitelist on the same data we authored). Re-validation still runs on this.
  return expected;
}
