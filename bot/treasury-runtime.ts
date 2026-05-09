/**
 * bot/treasury-runtime.ts
 *
 * Bootstraps the Path B (treasury-matched) governance subsystem at bot
 * startup. Pulls config from env, derives PDAs, instantiates the
 * orchestrator, runs a one-shot reconcile, and starts the worker loop.
 *
 * If `GOVERNANCE_REALM_NAME` is unset, this is a no-op (Path B disabled).
 * That lets the bot run during early dev / before realm bootstrap without
 * touching any governance code.
 *
 * Caller (discord-bot/src/index.ts) wires the returned `TreasuryRuntime`
 * into `BotContext` so commands like /sell, /buy, /close can enqueue jobs.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { SplGovernance } from 'governance-idl-sdk';
import {
  WalletService,
  type WhitelistContext,
} from '@crankbot/core-sdk';
import {
  TreasuryOrchestrator,
  type ProposalJob,
} from './treasury-orchestrator';

export interface TreasuryRuntime {
  /** SPL Governance SDK instance — for reading proposal state, deriving PDAs. */
  sdk: SplGovernance;
  /** Realm PDA. */
  realm: PublicKey;
  /** Governance account PDA. */
  governance: PublicKey;
  /** Native Treasury PDA (signing authority for proposal-executed inner ixs). */
  nativeTreasuryPda: PublicKey;
  /** bin-farm UserVault owned by nativeTreasuryPda — holds treasury inventory. */
  treasuryUserVault: PublicKey;
  /**
   * The mint whose TOR the bot votes against. With the addin enabled, this is
   * the community-side proposal-perm mint (supply=1, addin-gated). Without
   * the addin, this is the council mint (legacy in-bot-validator path).
   */
  governingTokenMint: PublicKey;
  /**
   * Council mint — kept on the realm for HW-signed emergency operations
   * (admin authority, withdraw_*, program upgrades). NEVER delegated to bot.
   */
  councilMint: PublicKey;
  /** Operator's TokenOwnerRecord on the bot's voting axis (community when addin set, else council). */
  operatorTor: PublicKey;
  /** Operator's wallet pubkey (= TOR owner). */
  operatorWallet: PublicKey;
  /**
   * Optional proposal-whitelist-addin program ID. When set, every Path B
   * proposal goes through the addin's update_voter_weight_record before
   * castVote — an on-chain whitelist gate that survives bot compromise.
   * Requires the realm to be configured with community vote enabled and
   * community_voter_weight_addin = this program id (see bootstrap-realm.ts).
   */
  addinProgramId?: PublicKey;
  /** Background queue + worker. */
  orchestrator: TreasuryOrchestrator;
}

/**
 * Build the runtime if governance env is set. Returns `undefined` for the
 * "Path B disabled" case so the caller can short-circuit.
 *
 * Required env (all-or-nothing):
 *   GOVERNANCE_REALM_NAME
 *   GOVERNANCE_PUBKEY            — output of bootstrap-realm step 4
 *   NATIVE_TREASURY_PDA          — output of bootstrap-realm step 4
 *   TREASURY_USER_VAULT          — output of bootstrap-realm step 6
 *   COUNCIL_MINT                 — output of bootstrap-realm step 1 (or env-pinned)
 *   OPERATOR_PUBKEY              — operator wallet that holds the council token
 *
 * Optional env:
 *   GOVERNANCE_PROGRAM_ID        — defaults to SPL Governance default
 *   TREASURY_POLL_INTERVAL_MS    — orchestrator worker tick interval, default 200
 *   TREASURY_MAX_RETRIES         — transient-failure retry budget, default 3
 */
export async function initTreasuryRuntime(
  connection: Connection,
  bot: Keypair,
  walletService: WalletService,
): Promise<TreasuryRuntime | undefined> {
  const realmName = process.env.GOVERNANCE_REALM_NAME;
  if (!realmName) return undefined;

  const must = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`Path B init failed: ${k} required when GOVERNANCE_REALM_NAME is set`);
    return v;
  };

  const governanceProgramId = process.env.GOVERNANCE_PROGRAM_ID
    ? new PublicKey(process.env.GOVERNANCE_PROGRAM_ID)
    : undefined; // SDK falls back to its default

  const sdk = new SplGovernance(connection, governanceProgramId);
  const realm = sdk.pda.realmAccount({ name: realmName }).publicKey;
  const governance = new PublicKey(must('GOVERNANCE_PUBKEY'));
  const nativeTreasuryPda = new PublicKey(must('NATIVE_TREASURY_PDA'));
  const treasuryUserVault = new PublicKey(must('TREASURY_USER_VAULT'));
  const councilMint = new PublicKey(must('COUNCIL_MINT'));
  const operatorWallet = new PublicKey(must('OPERATOR_PUBKEY'));
  const addinProgramId = process.env.GOVERNANCE_ADDIN_PROGRAM_ID
    ? new PublicKey(process.env.GOVERNANCE_ADDIN_PROGRAM_ID)
    : undefined;
  // Bot's voting mint: with addin → community proposal-perm mint, else council.
  const governingTokenMint = addinProgramId
    ? new PublicKey(must('PROPOSAL_PERM_MINT'))
    : councilMint;
  const operatorTor = sdk.pda.tokenOwnerRecordAccount({
    realmAccount: realm,
    governingTokenMintAccount: governingTokenMint,
    governingTokenOwner: operatorWallet,
  }).publicKey;

  // Sanity check derivations against on-chain reality before starting workers.
  const realmInfo = await connection.getAccountInfo(realm);
  if (!realmInfo) {
    throw new Error(`Path B init failed: realm ${realm.toBase58()} not found on-chain. Has bootstrap-realm.ts run?`);
  }
  const govInfo = await connection.getAccountInfo(governance);
  if (!govInfo) {
    throw new Error(`Path B init failed: governance ${governance.toBase58()} not found on-chain`);
  }
  const treasuryVaultInfo = await connection.getAccountInfo(treasuryUserVault);
  if (!treasuryVaultInfo) {
    throw new Error(`Path B init failed: treasury_user_vault ${treasuryUserVault.toBase58()} not found on-chain. Has step 6 of bootstrap-realm.ts run?`);
  }

  const pollIntervalMs = Number(process.env.TREASURY_POLL_INTERVAL_MS ?? 200);
  const maxRetries = Number(process.env.TREASURY_MAX_RETRIES ?? 3);

  // Curator.json pool addresses are loaded by the discord-bot at startup;
  // we accept a thunk here to keep this module independent of that wiring.
  // Caller can later replace this with a populated set.
  let knownPoolAddresses = new Set<string>();

  const orchestrator = new TreasuryOrchestrator({
    connection,
    bot,
    walletService,
    realm,
    governance,
    tokenOwnerRecord: operatorTor,
    governingTokenMint,
    addinProgramId,
    governingTokenOwner: operatorWallet,
    pollIntervalMs,
    maxRetries,
    buildValidatorContext: (job: ProposalJob): WhitelistContext => {
      const expectedProposerWallet =
        job.kind === 'open' ? new PublicKey(job.proposerWallet)
        : undefined; // close jobs validate against on-chain PositionSettle, not env
      return {
        botPubkey: bot.publicKey,
        nativeTreasuryPda,
        treasuryUserVault,
        knownPoolAddresses,
        expectedProposerWallet,
      };
    },
    onTerminal: rec => {
      const tag = rec.status === 'executed' ? '✓' : '✗';
      console.log(
        `[treasury] ${tag} ${rec.kind}/${rec.status} proposal=${rec.proposal_pda.slice(0, 12)}…` +
          (rec.last_error ? ` reason=${rec.last_error.slice(0, 80)}` : ''),
      );
    },
  });

  // Allow the discord-bot to populate the pool whitelist after it loads
  // curator.json. We expose it via mutation since the validator context is
  // built per-job.
  (orchestrator as TreasuryOrchestrator & {
    setKnownPools(pools: Iterable<string>): void;
  }).setKnownPools = (pools) => {
    knownPoolAddresses = new Set(pools);
  };

  await orchestrator.reconcile();
  orchestrator.startWorker();

  console.log(`[treasury] Path B online`);
  console.log(`  realm:           ${realm.toBase58()}`);
  console.log(`  governance:      ${governance.toBase58()}`);
  console.log(`  nativeTreasury:  ${nativeTreasuryPda.toBase58()}`);
  console.log(`  treasuryVault:   ${treasuryUserVault.toBase58()}`);
  console.log(`  bot delegate:    ${bot.publicKey.toBase58()}`);
  console.log(`  addin gate:      ${addinProgramId ? addinProgramId.toBase58() : 'DISABLED (in-bot validator only)'}`);
  console.log(`  poll interval:   ${pollIntervalMs}ms`);

  return {
    sdk,
    realm,
    governance,
    nativeTreasuryPda,
    treasuryUserVault,
    governingTokenMint,
    councilMint,
    operatorTor,
    operatorWallet,
    addinProgramId,
    orchestrator,
  };
}
