/**
 * bot/treasury-orchestrator.ts
 *
 * Background queue + worker for Path B (treasury-matched) governance proposals.
 *
 * Why a queue? Discord interactions can't wait on governance lifecycle latency
 * (~1-2s end-to-end) without timing out user replies. Path A (the user's own
 * position) replies immediately; Path B (treasury match) runs async after.
 *
 * Why serial? Two `treasury_open_position` proposals racing on the same
 * (governance, lb_pair) pair can collide on the per-position counter. The
 * worker processes jobs one at a time per realm to avoid that class of bug.
 *
 * Reconciliation: on bot startup, query SPL Governance for the actual on-chain
 * state of every 'pending' / 'inserted' / 'voted' proposal in the DB and
 * normalize. Handles bot crashes mid-lifecycle.
 */

import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createHash } from 'crypto';
import {
  WalletService,
  type OpenProposalRecord,
  type ProposalKind,
  type ProposalStatus,
  type WhitelistContext,
  submitTreasuryProposal,
  type ProposalResult,
  type ValidatorClient,
  TreasuryProposalError,
  TreasuryValidationError,
} from '@crankbot/core-sdk';

// ─── Job shape ──────────────────────────────────────────────────────────────

export type ProposalJob =
  | OpenJob
  | CloseJob
  | CancelJob;

export interface OpenJob {
  kind: 'open';
  innerIxs: TransactionInstruction[];
  userPositionPda: string;
  proposerUserId: string;
  proposerWallet: string;
  meteoraPosition: string;
  treasuryVault: string;
  lbPair: string;
  side: 'Buy' | 'Sell';
  minBinId: number;
  maxBinId: number;
  matchedAmount: bigint;
  outputMint: string;
  payoutBps: number;
  proposalName: string;
}

export interface CloseJob {
  kind: 'close';
  innerIxs: TransactionInstruction[];
  userPositionPda: string;
  treasuryPositionPda: string;
  proposerUserId: string;
  proposalName: string;
}

export interface CancelJob {
  kind: 'cancel';
  proposalPda: string;
  reason: string;
}

// ─── Orchestrator config ────────────────────────────────────────────────────

export interface OrchestratorConfig {
  connection: Connection;
  bot: Keypair;
  walletService: WalletService;
  realm: PublicKey;
  governance: PublicKey;
  /** Operator's TokenOwnerRecord (bot signs as delegate). */
  tokenOwnerRecord: PublicKey;
  /** Bot's voting mint — community proposal-perm with addin, else council. */
  governingTokenMint: PublicKey;
  /** Addin program ID — when set, every proposal goes through on-chain whitelist gate. */
  addinProgramId?: PublicKey;
  /** Owner of the VWR PDA (operator wallet). Required when addinProgramId is set. */
  governingTokenOwner?: PublicKey;
  /** v1.5 separate-machine validator co-signer. v1: undefined. */
  validatorClient?: ValidatorClient;
  /** Whitelist context resolver — called per-job to populate proposer/treasury fields. */
  buildValidatorContext: (job: ProposalJob) => WhitelistContext;
  /** Optional callback fired on terminal state for any job (executed/failed/cancelled). */
  onTerminal?: (rec: OpenProposalRecord) => void;
  /** Worker poll interval. Default 200ms — fast enough for sub-second responsiveness. */
  pollIntervalMs?: number;
  /** Max retries for transient tx failures before giving up. Default 3. */
  maxRetries?: number;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export class TreasuryOrchestrator {
  private cfg: OrchestratorConfig;
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  /** In-memory FIFO of jobs awaiting first dispatch. */
  private queue: ProposalJob[] = [];

  constructor(cfg: OrchestratorConfig) {
    this.cfg = cfg;
  }

  // ─── Enqueue / inspect ────────────────────────────────────────────────────

  /**
   * Enqueue a job. Persists initial 'pending' record keyed by payload hash
   * (proposal_pda not yet known — will be set on first dispatch).
   */
  enqueue(job: ProposalJob): void {
    if (job.kind === 'cancel') {
      this.queue.push(job);
      return;
    }
    const payloadHash = hashPayload(job.innerIxs);
    const existing = this.cfg.walletService.findProposalByPayloadHash(payloadHash);
    if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
      // Replay-detection: same payload already in flight or completed → skip.
      console.log(`[treasury] skipping duplicate enqueue payload=${payloadHash.slice(0, 8)} existing=${existing.proposal_pda}/${existing.status}`);
      return;
    }
    this.queue.push(job);
  }

  pendingCount(): number {
    return this.queue.length;
  }

  // ─── Worker loop ──────────────────────────────────────────────────────────

  startWorker(): void {
    if (this.timer) return;
    const ms = this.cfg.pollIntervalMs ?? 200;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
  }

  stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.inflight) return;
    if (this.queue.length === 0) return;
    this.inflight = true;
    try {
      const job = this.queue.shift()!;
      await this.runJob(job);
    } catch (e) {
      console.error('[treasury] worker tick error:', (e as Error).message);
    } finally {
      this.inflight = false;
    }
  }

  /** Run a single job to completion (success or terminal failure). */
  async runJob(job: ProposalJob): Promise<void> {
    if (job.kind === 'cancel') {
      await this.runCancel(job);
      return;
    }
    await this.runProposal(job);
  }

  // ─── Proposal job execution ──────────────────────────────────────────────

  private async runProposal(job: OpenJob | CloseJob): Promise<void> {
    const payloadHash = hashPayload(job.innerIxs);
    const validatorContext = this.cfg.buildValidatorContext(job);
    const maxRetries = this.cfg.maxRetries ?? 3;

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const result = await submitTreasuryProposal(
          {
            innerIxs: job.innerIxs,
            bot: this.cfg.bot,
            validatorClient: this.cfg.validatorClient,
            realm: this.cfg.realm,
            governance: this.cfg.governance,
            tokenOwnerRecord: this.cfg.tokenOwnerRecord,
            governingTokenMint: this.cfg.governingTokenMint,
            addinProgramId: this.cfg.addinProgramId,
            governingTokenOwner: this.cfg.governingTokenOwner,
            name: job.proposalName,
            validatorContext,
          },
          this.cfg.connection,
        );
        this.persistSuccess(job, result, payloadHash);
        return;
      } catch (e) {
        if (e instanceof TreasuryValidationError) {
          // Validation failures are NOT retried — payload won't change.
          this.persistTerminalFailure(job, payloadHash, `validator: ${e.message}`);
          return;
        }
        if (e instanceof TreasuryProposalError && e.stage === 'validator-service') {
          // Validator service refused — NOT retried (alert operator).
          this.persistTerminalFailure(job, payloadHash, `validator-service: ${e.message}`);
          return;
        }
        attempt += 1;
        const last = attempt > maxRetries;
        const reason = `${(e as Error).message?.slice(0, 200)}`;
        console.warn(`[treasury] proposal ${job.kind} attempt ${attempt}/${maxRetries + 1} failed: ${reason}`);
        if (last) {
          this.persistTerminalFailure(job, payloadHash, reason);
          return;
        }
        // Backoff before next attempt: 250ms, 1s, 4s
        const delay = 250 * Math.pow(4, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  private persistSuccess(
    job: OpenJob | CloseJob,
    result: ProposalResult,
    payloadHash: string,
  ): void {
    this.cfg.walletService.recordProposalLifecycle({
      proposal_pda: result.proposalPda.toBase58(),
      kind: job.kind,
      status: 'executed',
      user_position_pda: job.userPositionPda,
      treasury_position_pda: job.kind === 'open' ? job.userPositionPda /* set after on-chain confirmation */ : job.treasuryPositionPda,
      insert_tx_sig: result.insertSig,
      execute_tx_sig: result.executeSig,
      payload_hash: payloadHash,
    });

    if (job.kind === 'open') {
      // Treasury position pda derivation happens at the call site once we know
      // the new meteora_position. Caller passes meteoraPosition pre-computed.
      const treasuryPositionPda = job.userPositionPda; // best-effort placeholder; caller may override
      this.cfg.walletService.saveTreasuryPosition({
        treasury_position_pda: treasuryPositionPda,
        user_position_pda: job.userPositionPda,
        proposer_user_id: job.proposerUserId,
        proposer_wallet: job.proposerWallet,
        meteora_position: job.meteoraPosition,
        treasury_vault: job.treasuryVault,
        lb_pair: job.lbPair,
        side: job.side,
        min_bin_id: job.minBinId,
        max_bin_id: job.maxBinId,
        matched_amount: job.matchedAmount.toString(),
        output_mint: job.outputMint,
        payout_bps: job.payoutBps,
        status: 'open',
        opened_at: Date.now(),
        open_proposal_pda: result.proposalPda.toBase58(),
      });
    } else {
      // Close: mark treasury position closed. Payout amount (proposer's share)
      // is read from the close tx's effect — the orchestrator caller can
      // override later by reading the actual transferred amount via getTransaction.
      this.cfg.walletService.closeTreasuryPosition(
        job.treasuryPositionPda,
        result.proposalPda.toBase58(),
        0n,                    // placeholder; bot updates after parsing tx logs
      );
    }

    const rec = this.cfg.walletService.getProposal(result.proposalPda.toBase58());
    if (rec && this.cfg.onTerminal) this.cfg.onTerminal(rec);

    console.log(`[treasury] ✓ ${job.kind} executed: ${result.executeSig} (${result.durationMs}ms)`);
  }

  private persistTerminalFailure(
    job: OpenJob | CloseJob,
    payloadHash: string,
    reason: string,
  ): void {
    // No proposal_pda yet — synthesize a stable key from payload hash for tracking.
    const placeholderPda = `failed-${payloadHash.slice(0, 16)}`;
    this.cfg.walletService.recordProposalLifecycle({
      proposal_pda: placeholderPda,
      kind: job.kind,
      status: 'failed',
      user_position_pda: job.userPositionPda,
      treasury_position_pda: job.kind === 'close' ? job.treasuryPositionPda : undefined,
      retry_count: this.cfg.maxRetries ?? 3,
      last_error: reason,
      payload_hash: payloadHash,
    });
    const rec = this.cfg.walletService.getProposal(placeholderPda);
    if (rec && this.cfg.onTerminal) this.cfg.onTerminal(rec);
    console.error(`[treasury] ✗ ${job.kind} FAILED: ${reason}`);
  }

  // ─── Cancel job ───────────────────────────────────────────────────────────

  private async runCancel(_job: CancelJob): Promise<void> {
    // SPL Governance has cancelProposal + refundProposalDeposit. v1 stub:
    // just mark the DB record cancelled. Full implementation deferred until we
    // have observed real-world stuck proposals to design against.
    console.warn(`[treasury] cancel job not yet implemented`);
  }

  // ─── Reconciliation ────────────────────────────────────────────────────────

  /**
   * On startup, walk every non-terminal proposal record and reconcile against
   * on-chain state. v1 stub: marks pending/inserted records as failed if they
   * have no insert_tx_sig and are >5min old. Full implementation queries SPL
   * Governance's getProposalByPubkey and normalizes status accordingly.
   */
  async reconcile(): Promise<void> {
    const candidates = this.cfg.walletService.listProposalsByStatus('pending', 'inserted', 'voted');
    const cutoff = Date.now() - 5 * 60_000;
    let stale = 0;
    for (const rec of candidates) {
      if (rec.created_at < cutoff && !rec.execute_tx_sig) {
        this.cfg.walletService.recordProposalLifecycle({
          proposal_pda: rec.proposal_pda,
          kind: rec.kind,
          status: 'failed',
          last_error: 'reconciler: stale (>5min) without execute_tx_sig',
          payload_hash: rec.payload_hash,
        });
        stale += 1;
      }
    }
    if (stale > 0) {
      console.warn(`[treasury] reconcile: marked ${stale} stale proposals as failed`);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** sha256 of the inner-ix payload — used for replay detection and idempotency. */
function hashPayload(innerIxs: TransactionInstruction[]): string {
  const hasher = createHash('sha256');
  for (const ix of innerIxs) {
    hasher.update(ix.programId.toBuffer());
    hasher.update(Buffer.from([ix.keys.length & 0xff]));
    for (const k of ix.keys) {
      hasher.update(k.pubkey.toBuffer());
      hasher.update(Buffer.from([k.isSigner ? 1 : 0, k.isWritable ? 1 : 0]));
    }
    hasher.update(Buffer.from([(ix.data.length >> 8) & 0xff, ix.data.length & 0xff]));
    hasher.update(ix.data);
  }
  return hasher.digest('hex');
}

export const __test = { hashPayload };
