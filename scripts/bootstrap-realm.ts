/**
 * scripts/bootstrap-realm.ts
 *
 * One-shot realm bootstrap for buttfuck. Walks the realm from "doesn't exist"
 * to "ready for treasury matching" via the 9-step procedure documented in
 * .claude/plans/functional-inventing-trinket.md.
 *
 * USAGE
 *   tsx scripts/bootstrap-realm.ts [--dry-run] [--from-step N]
 *
 *   Required env (in bot/.env or process env):
 *     RPC_URL                 — Solana RPC endpoint
 *     OPERATOR_KEYPAIR_PATH   — Path to operator's wallet JSON (high-trust signer)
 *     BOT_PUBKEY              — Bot wallet pubkey (delegated post-bootstrap)
 *     REALM_NAME              — Permanent realm name (e.g. 'crankbot') — irreversible after step 3
 *     TREASURY_SEED_AMOUNT    — Raw u64 of CRANK to seed (e.g. 1000000000000 = 1M at 6 decimals)
 *
 *   Optional env:
 *     COMMUNITY_MINT          — Default = CRANK
 *     COUNCIL_MINT_KEYPAIR    — Path to council mint keypair (auto-gen if missing)
 *     HOLDUP_TIME             — Default = 0 (instant)
 *     VOTING_BASE_TIME        — Default = 1
 *     COUNCIL_THRESHOLD_PCT   — Default = 1
 *     SKIP_FINAL_AUTHORITY_TRANSFER — Set to '1' to halt before step 9 (irreversible step)
 *
 * SAFETY
 *   - Step 9 (setRealmAuthority) is irreversible. The script pauses 30s before it.
 *   - All steps are idempotent where possible: re-running detects existing state and skips.
 *   - --dry-run prints the plan + derived addresses without sending any tx.
 *
 * AFTER BOOTSTRAP (separate scripts, not this file):
 *   - FFwq calls bin-farm `init_payout_config(payout_bps=2000, match_ratio_bps=10000, payout_admin=native_treasury_pda)`.
 *   - FFwq calls hopper `update_routing` with all three slots = native_treasury_pda.
 *   - Bot deploy with new BotContext fields (governanceAccount, realmAccount, treasury orchestrator).
 *   - Run `tsx scripts/bootstrap-verify.ts` (memo-only proposal end-to-end test).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  SystemProgram,
  AccountMeta,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import { SplGovernance } from 'governance-idl-sdk';
import BN from 'bn.js';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import dotenv from 'dotenv';
import { BIN_FARM_PROGRAM_ID, CRANK_MINT, SPL_MEMO_PROGRAM_ID } from '@crankbot/core-sdk';
import {
  buildCreateRegistrarIx,
  buildUpdateRegistrarWhitelistIx,
  buildCreateVoterWeightRecordIx,
  getRegistrarPDA,
  getVoterWeightRecordPDA,
  type WhitelistEntry,
} from '@crankbot/core-sdk';

dotenv.config({ path: 'bot/.env' });

// ─── bin-farm create_vault hand-rolled ix (avoids Codama regen dependency) ──
// Discriminator from packages/core-sdk/generated/bin-farm/instructions/createVault.ts
const CREATE_VAULT_DISC = Buffer.from([29, 237, 247, 208, 193, 82, 54, 135]);

function buildCreateVaultIx(
  payer: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  const [userVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_vault'), owner.toBuffer()],
    BIN_FARM_PROGRAM_ID,
  );
  return new TransactionInstruction({
    programId: BIN_FARM_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: userVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: CREATE_VAULT_DISC,
  });
}

// ─── Config ─────────────────────────────────────────────────────────────────

type Cfg = {
  conn: Connection;
  operator: Keypair;
  botPubkey: PublicKey;
  realmName: string;
  /**
   * The token used for treasury content (CRANK by default). Held in NTP ATAs +
   * staged through bin-farm vaults. NOT a governing token in the addin model.
   */
  treasuryAssetMint: PublicKey;
  /** Token program owning treasuryAssetMint. Resolved at preflight (legacy or Token-2022). */
  treasuryAssetTokenProgram: PublicKey;
  /**
   * Community-side governing token. Membership type, supply 1, addin-gated.
   * Operator holds the supply, delegates community TOR to bot.
   */
  proposalPermMintKp: Keypair;
  /**
   * Council-side governing token. Membership type, supply 1, operator HW wallet.
   * Used for emergency / admin proposals (ungated). Bot is NOT delegate.
   */
  councilMintKp: Keypair;
  addinProgramId: PublicKey;
  treasurySeedAmount: bigint;
  holdUpTime: number;
  votingBaseTime: number;
  councilThresholdPct: number;
  skipFinalAuthorityTransfer: boolean;
  dryRun: boolean;
  fromStep: number;
};

function loadCfg(): Cfg {
  const must = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env: ${k}`);
    return v;
  };
  const conn = new Connection(must('RPC_URL'), 'confirmed');
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(must('OPERATOR_KEYPAIR_PATH'), 'utf8'))),
  );
  const botPubkey = new PublicKey(must('BOT_PUBKEY'));
  const realmName = must('REALM_NAME');
  if (realmName.length < 3 || realmName.length > 32) {
    throw new Error(`realmName must be 3-32 chars (got ${realmName.length})`);
  }
  if (realmName.toLowerCase() === 'buttfuck') {
    throw new Error('realm name "buttfuck" is the working file name, not the on-chain artifact name. Pick crankbot or similar.');
  }
  const treasuryAssetMint = new PublicKey(process.env.TREASURY_ASSET_MINT ?? CRANK_MINT.toBase58());
  const loadOrGenMint = (pathEnvKey: string, label: string): Keypair => {
    const path = process.env[pathEnvKey];
    if (path && existsSync(path)) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
    }
    const kp = Keypair.generate();
    if (path) {
      writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
      console.log(`[cfg] generated ${label} keypair, saved to ${path}`);
    } else {
      console.log(`[cfg] generated ephemeral ${label} keypair: ${kp.publicKey.toBase58()} (NOT saved — set ${pathEnvKey} to persist)`);
    }
    return kp;
  };
  const councilMintKp = loadOrGenMint('COUNCIL_MINT_KEYPAIR', 'council mint');
  const proposalPermMintKp = loadOrGenMint('PROPOSAL_PERM_MINT_KEYPAIR', 'proposal-perm mint');
  const addinProgramId = new PublicKey(must('GOVERNANCE_ADDIN_PROGRAM_ID'));
  const treasurySeedAmount = BigInt(must('TREASURY_SEED_AMOUNT'));
  return {
    conn,
    operator,
    botPubkey,
    realmName,
    treasuryAssetMint,
    // Set at runtime by step0_preflight (after we can read mint.owner from chain).
    treasuryAssetTokenProgram: TOKEN_PROGRAM_ID,
    proposalPermMintKp,
    councilMintKp,
    addinProgramId,
    treasurySeedAmount,
    holdUpTime: Number(process.env.HOLDUP_TIME ?? 0),
    votingBaseTime: Number(process.env.VOTING_BASE_TIME ?? 1),
    councilThresholdPct: Number(process.env.COUNCIL_THRESHOLD_PCT ?? 1),
    skipFinalAuthorityTransfer: process.env.SKIP_FINAL_AUTHORITY_TRANSFER === '1',
    dryRun: process.argv.includes('--dry-run'),
    fromStep: Number(process.argv.find(a => a.startsWith('--from-step='))?.split('=')[1] ?? 0),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const tx = new Transaction();
  // Modest priority fee — bootstrap is one-shot, value modest signal-boost
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
  tx.add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
  console.log(`  ✓ ${label}: ${sig}`);
  return sig;
}

async function exists(conn: Connection, pda: PublicKey): Promise<boolean> {
  const acc = await conn.getAccountInfo(pda);
  return acc !== null;
}

function header(stepNum: number, name: string) {
  console.log(`\n${'='.repeat(60)}\nSTEP ${stepNum}: ${name}\n${'='.repeat(60)}`);
}

// ─── Step 0: pre-flight ─────────────────────────────────────────────────────

async function step0_preflight(cfg: Cfg, sdk: SplGovernance) {
  header(0, 'Pre-flight checks');

  const opBalance = await cfg.conn.getBalance(cfg.operator.publicKey);
  console.log(`  operator: ${cfg.operator.publicKey.toBase58()}`);
  console.log(`  balance:  ${(opBalance / 1e9).toFixed(4)} SOL`);
  if (opBalance < 500_000_000) {
    throw new Error(`operator needs >= 0.5 SOL for bootstrap (have ${opBalance / 1e9})`);
  }

  // Detect whether treasuryAssetMint is legacy SPL or Token-2022 (CRANK is the latter).
  const mintInfo = await cfg.conn.getAccountInfo(cfg.treasuryAssetMint);
  if (!mintInfo) throw new Error(`treasury-asset mint ${cfg.treasuryAssetMint.toBase58()} not found on-chain`);
  if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    cfg.treasuryAssetTokenProgram = TOKEN_2022_PROGRAM_ID;
  } else if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
    cfg.treasuryAssetTokenProgram = TOKEN_PROGRAM_ID;
  } else {
    throw new Error(`treasury-asset mint owned by ${mintInfo.owner.toBase58()} (neither legacy SPL nor Token-2022)`);
  }
  console.log(`  treasury-asset mint program: ${cfg.treasuryAssetTokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'legacy SPL'}`);

  // Check operator's treasury-asset (CRANK) balance — funds the treasury seed.
  const opAssetAta = getAssociatedTokenAddressSync(
    cfg.treasuryAssetMint, cfg.operator.publicKey, false, cfg.treasuryAssetTokenProgram,
  );
  try {
    const bal = await cfg.conn.getTokenAccountBalance(opAssetAta);
    const raw = BigInt(bal.value.amount);
    console.log(`  treasury-asset ATA: ${opAssetAta.toBase58()}`);
    console.log(`  ${cfg.treasuryAssetMint.toBase58().slice(0, 8)}…: ${raw} raw`);
    if (raw < cfg.treasurySeedAmount) {
      throw new Error(`operator needs >= ${cfg.treasurySeedAmount} raw treasury-asset tokens for seed (have ${raw})`);
    }
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('Invalid param')) {
      throw new Error(`operator has no treasury-asset ATA at ${opAssetAta.toBase58()}`);
    }
    throw e;
  }

  // Verify addin program is deployed.
  if (!(await exists(cfg.conn, cfg.addinProgramId))) {
    throw new Error(`addin program not deployed at ${cfg.addinProgramId.toBase58()}`);
  }
  console.log(`  addin: ${cfg.addinProgramId.toBase58()} ✓`);

  const realmPda = sdk.pda.realmAccount({ name: cfg.realmName }).publicKey;
  console.log(`  realm pda: ${realmPda.toBase58()}`);
  if (await exists(cfg.conn, realmPda)) {
    if (cfg.fromStep < 3) {
      throw new Error(`realm '${cfg.realmName}' already exists at ${realmPda} — re-run with --from-step=3 (or higher) to resume`);
    }
    console.log(`  ⚠ realm exists — resuming from step ${cfg.fromStep}`);
  }

  console.log('  ✓ pre-flight passed');
}

// ─── Step 1: create council mint (membership type, supply=1) ────────────────

async function step1_councilMint(cfg: Cfg): Promise<PublicKey> {
  header(1, 'Create council mint (membership, supply=1, FFwq operator holder)');

  const councilMint = cfg.councilMintKp.publicKey;
  if (await exists(cfg.conn, councilMint)) {
    console.log(`  council mint ${councilMint.toBase58()} already exists — skipping`);
    return councilMint;
  }
  if (cfg.dryRun) {
    console.log(`  [dry-run] would create mint ${councilMint.toBase58()}`);
    return councilMint;
  }

  const lamports = await getMinimumBalanceForRentExemptMint(cfg.conn);
  const operatorAta = getAssociatedTokenAddressSync(councilMint, cfg.operator.publicKey);

  await send(
    cfg.conn,
    [
      SystemProgram.createAccount({
        fromPubkey: cfg.operator.publicKey,
        newAccountPubkey: councilMint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        councilMint,
        0,                              // 0 decimals — discrete tokens
        cfg.operator.publicKey,         // mint authority (about to burn)
        cfg.operator.publicKey,         // freeze authority (about to burn — membership token)
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        cfg.operator.publicKey,
        operatorAta,
        cfg.operator.publicKey,
        councilMint,
      ),
      createMintToInstruction(councilMint, operatorAta, cfg.operator.publicKey, 1n),
      // Burn mint authority — supply locked at 1
      createSetAuthorityInstruction(
        councilMint,
        cfg.operator.publicKey,
        AuthorityType.MintTokens,
        null,
      ),
      // Burn freeze authority — making it effectively a "membership" token
      createSetAuthorityInstruction(
        councilMint,
        cfg.operator.publicKey,
        AuthorityType.FreezeAccount,
        null,
      ),
    ],
    [cfg.operator, cfg.councilMintKp],
    'council mint created + 1 minted to operator + authorities burned',
  );

  return councilMint;
}

// ─── Step 2: createRealm ────────────────────────────────────────────────────

async function step1b_proposalPermMint(cfg: Cfg): Promise<PublicKey> {
  header(1.5, 'Create proposal-perm mint (membership, supply=1, operator holder, addin-gated community side)');

  const ppMint = cfg.proposalPermMintKp.publicKey;
  if (await exists(cfg.conn, ppMint)) {
    console.log(`  proposal-perm mint ${ppMint.toBase58()} already exists — skipping`);
    return ppMint;
  }
  if (cfg.dryRun) {
    console.log(`  [dry-run] would create mint ${ppMint.toBase58()}`);
    return ppMint;
  }

  const lamports = await getMinimumBalanceForRentExemptMint(cfg.conn);
  const operatorAta = getAssociatedTokenAddressSync(ppMint, cfg.operator.publicKey);

  await send(
    cfg.conn,
    [
      SystemProgram.createAccount({
        fromPubkey: cfg.operator.publicKey,
        newAccountPubkey: ppMint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        ppMint,
        0,                                // 0 decimals — discrete membership
        cfg.operator.publicKey,           // mint authority
        cfg.operator.publicKey,           // freeze authority
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        cfg.operator.publicKey,
        operatorAta,
        cfg.operator.publicKey,
        ppMint,
      ),
      createMintToInstruction(ppMint, operatorAta, cfg.operator.publicKey, BigInt(1)),
      // Burn the mint authority so supply is frozen at 1.
      createSetAuthorityInstruction(ppMint, cfg.operator.publicKey, AuthorityType.MintTokens, null),
    ],
    [cfg.operator, cfg.proposalPermMintKp],
    `proposal-perm mint created + minted 1 to operator @ ${ppMint.toBase58()}`,
  );
  return ppMint;
}

async function step2_createRealm(
  cfg: Cfg,
  sdk: SplGovernance,
  proposalPermMint: PublicKey,
  councilMint: PublicKey,
): Promise<PublicKey> {
  header(2, `createRealm "${cfg.realmName}" — PERMANENT name`);

  const realm = sdk.pda.realmAccount({ name: cfg.realmName }).publicKey;
  if (await exists(cfg.conn, realm)) {
    console.log(`  realm ${realm.toBase58()} already exists — skipping`);
    return realm;
  }
  if (cfg.dryRun) {
    console.log(`  [dry-run] would create realm ${realm.toBase58()}`);
    return realm;
  }

  // community = proposal-perm (1-supply, addin-gated)
  // council  = council mint (1-supply, HW emergency)
  // addin registered at create time so realm_config has it from t=0.
  const ix = await sdk.createRealmInstruction(
    cfg.realmName,
    proposalPermMint,                     // communityTokenMint
    1,                                    // minCommunityWeightToCreateGovernance
    cfg.operator.publicKey,               // payer
    { type: 'absolute', amount: new BN(1) },  // community max — 1 (matches supply)
    councilMint,                          // councilTokenMint
    'membership',                         // communityTokenType — frozen post-deposit
    'membership',                         // councilTokenType   — frozen post-deposit
    cfg.addinProgramId,                   // communityVoterWeightAddinProgramId
  );

  await send(cfg.conn, [ix], [cfg.operator], `createRealm @ ${realm.toBase58()}`);
  return realm;
}

// ─── Step 3: deposit BOTH governing tokens (operator gets two TORs) ────────
//
// Council TOR — used for emergency / admin proposals (HW-signed, ungated).
// Community TOR (proposal-perm) — bot-delegated for ongoing operations,
//   gated by the addin's voter weight at vote time.

async function step3_depositCouncil(
  cfg: Cfg,
  sdk: SplGovernance,
  realm: PublicKey,
  councilMint: PublicKey,
): Promise<PublicKey> {
  header(3, 'Deposit council token (operator gets council TokenOwnerRecord)');
  return depositGoverning(cfg, sdk, realm, councilMint, 'council');
}

async function step3b_depositProposalPerm(
  cfg: Cfg,
  sdk: SplGovernance,
  realm: PublicKey,
  proposalPermMint: PublicKey,
): Promise<PublicKey> {
  header(3.5, 'Deposit proposal-perm token (operator gets community TokenOwnerRecord)');
  return depositGoverning(cfg, sdk, realm, proposalPermMint, 'proposal-perm');
}

async function depositGoverning(
  cfg: Cfg,
  sdk: SplGovernance,
  realm: PublicKey,
  mint: PublicKey,
  label: string,
): Promise<PublicKey> {
  const tor = sdk.pda.tokenOwnerRecordAccount({
    realmAccount: realm,
    governingTokenMintAccount: mint,
    governingTokenOwner: cfg.operator.publicKey,
  }).publicKey;

  if (await exists(cfg.conn, tor)) {
    console.log(`  ${label} TOR ${tor.toBase58()} already exists — skipping`);
    return tor;
  }
  if (cfg.dryRun) {
    console.log(`  [dry-run] would deposit 1 ${label} token`);
    return tor;
  }

  const operatorAta = getAssociatedTokenAddressSync(mint, cfg.operator.publicKey);
  const ix = await sdk.depositGoverningTokensInstruction(
    realm,
    mint,
    operatorAta,
    cfg.operator.publicKey,
    cfg.operator.publicKey,
    cfg.operator.publicKey,
    new BN(1),
  );

  await send(cfg.conn, [ix], [cfg.operator], `deposit ${label} — TOR @ ${tor.toBase58()}`);
  return tor;
}

// ─── Step 4: createGovernance + createNativeTreasury ───────────────────────

async function step4_governance(
  cfg: Cfg,
  sdk: SplGovernance,
  realm: PublicKey,
  operatorTor: PublicKey,
): Promise<{ governance: PublicKey; nativeTreasury: PublicKey; govSeed: PublicKey }> {
  header(4, 'createGovernance + createNativeTreasury');

  // Idempotency: derive seed from realm name (deterministic), allowing resume.
  // The realm name + literal salt avoids accidental collision with other governances.
  const seedBytes = Buffer.alloc(32);
  Buffer.from(`bf-gov-${cfg.realmName}`).copy(seedBytes);
  const govSeed = new PublicKey(seedBytes);

  const governance = sdk.pda.governanceAccount({ realmAccount: realm, seed: govSeed }).publicKey;
  const nativeTreasury = sdk.pda.nativeTreasuryAccount({ governanceAccount: governance }).publicKey;

  console.log(`  govSeed:        ${govSeed.toBase58()}`);
  console.log(`  governance:     ${governance.toBase58()}`);
  console.log(`  nativeTreasury: ${nativeTreasury.toBase58()}`);

  const govExists = await exists(cfg.conn, governance);
  const treasuryExists = await exists(cfg.conn, nativeTreasury);

  if (govExists && treasuryExists) {
    console.log(`  governance + native treasury already exist — skipping`);
    return { governance, nativeTreasury, govSeed };
  }
  if (cfg.dryRun) {
    console.log(`  [dry-run] would create governance + native treasury`);
    return { governance, nativeTreasury, govSeed };
  }

  const ixs: TransactionInstruction[] = [];

  if (!govExists) {
    // Both axes enabled:
    //  - community: addin-gated, bot tips with delegated proposal-perm TOR (1-supply)
    //  - council:   ungated, operator HW signs for emergency / admin proposals
    // Anchor IDL variants are camelCase (yesVotePercentage / disabled / early).
    const govConfig = {
      communityVoteThreshold: { yesVotePercentage: [1] } as never,
      minCommunityWeightToCreateProposal: new BN(1),
      minTransactionHoldUpTime: cfg.holdUpTime,
      votingBaseTime: cfg.votingBaseTime,
      communityVoteTipping: { early: {} } as never,
      councilVoteThreshold: { yesVotePercentage: [cfg.councilThresholdPct] } as never,
      councilVetoVoteThreshold: { disabled: {} } as never,
      minCouncilWeightToCreateProposal: new BN(1),
      councilVoteTipping: { early: {} } as never,
      communityVetoVoteThreshold: { disabled: {} } as never,
      votingCoolOffTime: 0,
      depositExemptProposalCount: 10,
    };
    ixs.push(
      await sdk.createGovernanceInstruction(
        govConfig as never,
        realm,
        cfg.operator.publicKey,
        operatorTor,
        cfg.operator.publicKey,
        govSeed,
      ),
    );
  }

  if (!treasuryExists) {
    ixs.push(await sdk.createNativeTreasuryInstruction(governance, cfg.operator.publicKey));
  }

  await send(cfg.conn, ixs, [cfg.operator], `governance + nativeTreasury`);
  return { governance, nativeTreasury, govSeed };
}

// ─── Step 4.5: addin registrar + whitelist + VWR ──────────────────────────

async function step4b_setupAddin(
  cfg: Cfg,
  realm: PublicKey,
  proposalPermMint: PublicKey,
): Promise<{ registrar: PublicKey; vwr: PublicKey }> {
  header(4.5, 'Addin: create_registrar + whitelist + create_voter_weight_record');

  const [registrar] = getRegistrarPDA(cfg.addinProgramId, realm, proposalPermMint);
  const [vwr] = getVoterWeightRecordPDA(
    cfg.addinProgramId, realm, proposalPermMint, cfg.operator.publicKey,
  );
  console.log(`  registrar: ${registrar.toBase58()}`);
  console.log(`  vwr:       ${vwr.toBase58()}`);

  if (cfg.dryRun) {
    console.log(`  [dry-run] would create registrar + whitelist + VWR`);
    return { registrar, vwr };
  }

  const ixs: TransactionInstruction[] = [];

  if (!(await exists(cfg.conn, registrar))) {
    ixs.push(buildCreateRegistrarIx({
      addinProgramId: cfg.addinProgramId,
      realm,
      governingTokenMint: proposalPermMint,
      authority: cfg.operator.publicKey,
      payer: cfg.operator.publicKey,
      governanceProgramId: new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw'),
    }));
  } else {
    console.log(`  registrar already exists — skipping create`);
  }

  // Whitelist: bin-farm settle ixs (treasury-match flow) + memo (sanity).
  // PR-2 requires these are governance-only callable; the addin enforces
  // which proposals can tip → only matched-trade payloads pass.
  const { createHash } = await import('crypto');
  const disc = (name: string): Buffer => {
    return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
  };
  const whitelist: WhitelistEntry[] = [
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('record_settle_meta'),  discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('settle_proposer'),     discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('close_settle'),        discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('open_position_v2'),    discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('user_close'),          discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('create_vault'),        discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('harvest_bins'),        discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('claim_fees'),          discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('wrap_sol_in_vault'),   discLen: 8 },
    { programId: BIN_FARM_PROGRAM_ID, discriminator: disc('unwrap_wsol_in_vault'),discLen: 8 },
    { programId: SPL_MEMO_PROGRAM_ID, discriminator: Buffer.alloc(0),             discLen: 0 },
  ];
  ixs.push(buildUpdateRegistrarWhitelistIx({
    addinProgramId: cfg.addinProgramId,
    realm,
    governingTokenMint: proposalPermMint,
    authority: cfg.operator.publicKey,
    whitelist,
  }));

  if (!(await exists(cfg.conn, vwr))) {
    ixs.push(buildCreateVoterWeightRecordIx({
      addinProgramId: cfg.addinProgramId,
      realm,
      governingTokenMint: proposalPermMint,
      governingTokenOwner: cfg.operator.publicKey,
      payer: cfg.operator.publicKey,
    }));
  } else {
    console.log(`  vwr already exists — skipping create`);
  }

  if (ixs.length > 0) {
    await send(cfg.conn, ixs, [cfg.operator], `addin setup (${ixs.length} ixs)`);
  }
  return { registrar, vwr };
}

// ─── Step 6: bootstrap proposal — wraps create_vault(owner=native_treasury) ─

async function step6_bootstrapVaultProposal(
  cfg: Cfg,
  sdk: SplGovernance,
  realm: PublicKey,
  governance: PublicKey,
  councilMint: PublicKey,
  operatorTor: PublicKey,
  nativeTreasury: PublicKey,
): Promise<PublicKey> {
  header(6, 'Bootstrap proposal — create_vault(owner=nativeTreasury)');

  const [treasuryVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_vault'), nativeTreasury.toBuffer()],
    BIN_FARM_PROGRAM_ID,
  );
  console.log(`  treasury user_vault PDA: ${treasuryVault.toBase58()}`);

  if (await exists(cfg.conn, treasuryVault)) {
    console.log(`  treasury vault already exists — skipping`);
    return treasuryVault;
  }
  if (cfg.dryRun) {
    console.log(`  [dry-run] would wrap create_vault in proposal + execute`);
    return treasuryVault;
  }

  // Inner ix: create_vault. payer = operator (signs outer execute tx).
  const createVaultIx = buildCreateVaultIx(cfg.operator.publicKey, nativeTreasury);

  // Build governance proposal lifecycle
  const proposalSeedBytes = Buffer.alloc(32);
  Buffer.from(`bootstrap-vault-${cfg.realmName}`.padEnd(32, '\0')).copy(proposalSeedBytes);
  const proposalSeed = new PublicKey(proposalSeedBytes);
  const proposalPda = sdk.pda.proposalAccount({
    governanceAccount: governance,
    governingTokenMint: councilMint,
    proposalSeed,
  }).publicKey;
  const proposalTxPda = sdk.pda.proposalTransactionAccount({
    proposal: proposalPda,
    optionIndex: 0,
    index: 0,
  }).publicKey;

  console.log(`  proposalPda:    ${proposalPda.toBase58()}`);
  console.log(`  proposalTxPda:  ${proposalTxPda.toBase58()}`);

  // Council-side bootstrap proposal — ungated by the addin (council vote axis).
  // Split into tx1a + tx1b because:
  //  - useDenyOption=true keeps single-option proposals in Draft after createProposal
  //    (otherwise they auto-progress, and insertTransaction is rejected with
  //    "Proposal is not not executable" / 0x248).
  //  - Vote.Approve uses indexed-key tuple form `{ approve: { 0: [...] } }`;
  //    the bare-array form fails Borsh encoding (Sequence over wrong shape).
  const createIx = await sdk.createProposalInstruction(
    `bootstrap-vault-${cfg.realmName.slice(0, 16)}`,
    '',
    { choiceType: 'single', multiChoiceOptions: null },
    ['Approve'],
    true,                                 // useDenyOption=true
    realm,
    governance,
    operatorTor,
    councilMint,
    cfg.operator.publicKey,
    cfg.operator.publicKey,
    proposalSeed,
  );

  const insertIx = await sdk.insertTransactionInstruction(
    [createVaultIx],
    0, 0,
    cfg.holdUpTime,
    governance,
    proposalPda,
    operatorTor,
    cfg.operator.publicKey,
    cfg.operator.publicKey,
  );

  const signOffIx = await sdk.signOffProposalInstruction(
    realm,
    governance,
    proposalPda,
    cfg.operator.publicKey,
    undefined,
    operatorTor,
  );

  const castVoteIx = await sdk.castVoteInstruction(
    { approve: { 0: [{ rank: 0, weightPercentage: 100 }] } } as never,
    realm,
    governance,
    proposalPda,
    operatorTor,
    operatorTor,
    cfg.operator.publicKey,
    councilMint,
    cfg.operator.publicKey,
  );

  // Idempotency: skip create/insert/signOff/castVote if proposal already exists.
  if (!(await exists(cfg.conn, proposalPda))) {
    await send(cfg.conn, [createIx], [cfg.operator], 'tx1a: createProposal');
    await send(cfg.conn, [insertIx, signOffIx, castVoteIx], [cfg.operator], 'tx1b: insert + signOff + castVote');
  } else {
    console.log(`  proposal already exists at ${proposalPda.toBase58()} — skipping create/vote, going straight to execute`);
  }

  // tx2: executeTransaction with all create_vault accounts as remainingAccounts.
  // governance enforces hold-up window (>= holdUpTime AFTER voting end). Retry
  // a few times to ride out clock drift on RPC nodes — error 0x20d means
  // "voting succeeded but hold-up not yet elapsed".
  const remaining: AccountMeta[] = [
    ...createVaultIx.keys,
    { pubkey: createVaultIx.programId, isSigner: false, isWritable: false },
  ];
  const executeIx = await sdk.executeTransactionInstruction(
    governance,
    proposalPda,
    proposalTxPda,
    remaining,
  );

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await send(cfg.conn, [executeIx], [cfg.operator], `tx2: executeTransaction → treasury vault @ ${treasuryVault.toBase58()}`);
      return treasuryVault;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes('0x20d') || msg.includes('hold up time')) {
        const wait = attempt * 5_000;
        console.log(`  hold-up not yet elapsed (attempt ${attempt}/6) — sleeping ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw new Error('executeTransaction still failing after 6 retries; manually re-run from-step=6 after governance hold-up clears');
}

// ─── Step 7: direct CRANK transfer to treasury vault ATA ───────────────────

async function step7_seedTreasury(cfg: Cfg, treasuryVault: PublicKey) {
  header(7, `Seed treasury with ${cfg.treasurySeedAmount} raw treasury-asset tokens`);

  const treasuryAta = getAssociatedTokenAddressSync(
    cfg.treasuryAssetMint, treasuryVault, true, cfg.treasuryAssetTokenProgram,
  );
  console.log(`  treasury ATA: ${treasuryAta.toBase58()}`);

  // Idempotency: check current balance; if >= seed amount, skip.
  try {
    const bal = await cfg.conn.getTokenAccountBalance(treasuryAta);
    const cur = BigInt(bal.value.amount);
    if (cur >= cfg.treasurySeedAmount) {
      console.log(`  treasury already holds ${cur} raw — skipping seed`);
      return;
    }
  } catch {
    // ATA doesn't exist yet — fall through to create + transfer
  }

  if (cfg.dryRun) {
    console.log(`  [dry-run] would create ATA + transfer ${cfg.treasurySeedAmount}`);
    return;
  }

  const opAta = getAssociatedTokenAddressSync(
    cfg.treasuryAssetMint, cfg.operator.publicKey, false, cfg.treasuryAssetTokenProgram,
  );
  await send(
    cfg.conn,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        cfg.operator.publicKey,
        treasuryAta,
        treasuryVault,
        cfg.treasuryAssetMint,
        cfg.treasuryAssetTokenProgram,
      ),
      createTransferInstruction(
        opAta,
        treasuryAta,
        cfg.operator.publicKey,
        cfg.treasurySeedAmount,
        [],
        cfg.treasuryAssetTokenProgram,
      ),
    ],
    [cfg.operator],
    `seeded ${cfg.treasurySeedAmount} raw to ${treasuryAta.toBase58()}`,
  );
}

// ─── Step 8: setGovernanceDelegate(bot) ─────────────────────────────────────

async function step8_delegate(
  cfg: Cfg,
  sdk: SplGovernance,
  communityTor: PublicKey,
) {
  header(8, `setGovernanceDelegate(bot=${cfg.botPubkey.toBase58()}) — community side ONLY`);
  console.log(`  council TOR retained on operator HW wallet (emergency / admin axis)`);

  if (cfg.dryRun) {
    console.log(`  [dry-run] would delegate operator's community TOR to bot`);
    return;
  }

  const ix = await sdk.setGovernanceDelegateInstruction(
    communityTor,
    cfg.operator.publicKey,
    cfg.botPubkey,
  );
  await send(cfg.conn, [ix], [cfg.operator], 'community-side governance delegate set to bot');
}

// ─── Step 9: setRealmAuthority(setChecked, governance) — POINT OF NO RETURN ─

async function step9_transferRealmAuthority(
  cfg: Cfg,
  sdk: SplGovernance,
  realm: PublicKey,
  governance: PublicKey,
) {
  header(9, '⚠️  setRealmAuthority — IRREVERSIBLE');

  if (cfg.skipFinalAuthorityTransfer) {
    console.log('  SKIP_FINAL_AUTHORITY_TRANSFER=1 — halting before step 9.');
    console.log(`  realm authority remains with operator. Re-run without the flag to commit.`);
    return;
  }

  if (cfg.dryRun) {
    console.log(`  [dry-run] would transfer realm authority to ${governance.toBase58()}`);
    return;
  }

  console.log(`\n  Realm authority will move from operator → ${governance.toBase58()}.`);
  console.log(`  After this, all realm config changes require a passed governance proposal.`);
  console.log(`  Press Ctrl-C within 30s to abort.\n`);
  await new Promise(r => setTimeout(r, 30_000));

  const ix = await sdk.setRealmAuthorityInstruction(
    realm,
    cfg.operator.publicKey,
    'setChecked',
    governance,
  );
  await send(cfg.conn, [ix], [cfg.operator], 'realm authority transferred to governance');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadCfg();
  const sdk = new SplGovernance(cfg.conn);

  console.log('\n═══ buttfuck realm bootstrap ═══');
  console.log(`  cluster: ${process.env.RPC_URL?.slice(0, 60)}…`);
  console.log(`  realm:   ${cfg.realmName}`);
  console.log(`  treasury seed: ${cfg.treasurySeedAmount} raw community tokens`);
  console.log(`  dry-run: ${cfg.dryRun}`);
  console.log(`  from-step: ${cfg.fromStep}`);

  // Detect treasury-asset token program (legacy vs Token-2022) unconditionally
  // — must run before any step that touches the asset, regardless of fromStep
  // because step 0's preflight may be skipped on resume.
  {
    const mintInfo = await cfg.conn.getAccountInfo(cfg.treasuryAssetMint);
    if (!mintInfo) throw new Error(`treasury-asset mint ${cfg.treasuryAssetMint.toBase58()} not found`);
    if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      cfg.treasuryAssetTokenProgram = TOKEN_2022_PROGRAM_ID;
    } else if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      cfg.treasuryAssetTokenProgram = TOKEN_PROGRAM_ID;
    } else {
      throw new Error(`treasury-asset mint owned by ${mintInfo.owner.toBase58()} (neither legacy SPL nor Token-2022)`);
    }
  }

  if (cfg.fromStep <= 0) await step0_preflight(cfg, sdk);

  const councilMint = cfg.fromStep <= 1
    ? await step1_councilMint(cfg)
    : cfg.councilMintKp.publicKey;

  const proposalPermMint = cfg.fromStep <= 1.5
    ? await step1b_proposalPermMint(cfg)
    : cfg.proposalPermMintKp.publicKey;

  const realm = cfg.fromStep <= 2
    ? await step2_createRealm(cfg, sdk, proposalPermMint, councilMint)
    : sdk.pda.realmAccount({ name: cfg.realmName }).publicKey;

  const councilTor = cfg.fromStep <= 3
    ? await step3_depositCouncil(cfg, sdk, realm, councilMint)
    : sdk.pda.tokenOwnerRecordAccount({
        realmAccount: realm,
        governingTokenMintAccount: councilMint,
        governingTokenOwner: cfg.operator.publicKey,
      }).publicKey;

  const communityTor = cfg.fromStep <= 3.5
    ? await step3b_depositProposalPerm(cfg, sdk, realm, proposalPermMint)
    : sdk.pda.tokenOwnerRecordAccount({
        realmAccount: realm,
        governingTokenMintAccount: proposalPermMint,
        governingTokenOwner: cfg.operator.publicKey,
      }).publicKey;

  const { governance, nativeTreasury } = await step4_governance(cfg, sdk, realm, councilTor);

  if (cfg.fromStep <= 4.5) await step4b_setupAddin(cfg, realm, proposalPermMint);

  // Step 5 (bin-farm Config init_payout_config + set_native_treasury_pda) is
  // separate — runs AFTER bin-farm program upgrade is deployed. Skipped here.

  // Step 6 uses COUNCIL side (bot is not delegate yet, addin not relevant for
  // bootstrap proposal). Operator HW signs.
  const treasuryVault = cfg.fromStep <= 6
    ? await step6_bootstrapVaultProposal(cfg, sdk, realm, governance, councilMint, councilTor, nativeTreasury)
    : PublicKey.findProgramAddressSync(
        [Buffer.from('user_vault'), nativeTreasury.toBuffer()],
        BIN_FARM_PROGRAM_ID,
      )[0];

  if (cfg.fromStep <= 7) await step7_seedTreasury(cfg, treasuryVault);
  // Delegate the COMMUNITY (proposal-perm) TOR — addin-gated, bot-driven.
  // Council TOR stays with operator HW wallet for emergency / admin proposals.
  if (cfg.fromStep <= 8) await step8_delegate(cfg, sdk, communityTor);
  if (cfg.fromStep <= 9) await step9_transferRealmAuthority(cfg, sdk, realm, governance);

  console.log(`\n═══ bootstrap complete ═══`);
  console.log(`  realm:             ${realm.toBase58()}`);
  console.log(`  governance:        ${governance.toBase58()}`);
  console.log(`  nativeTreasury:    ${nativeTreasury.toBase58()}`);
  console.log(`  treasuryVault:     ${treasuryVault.toBase58()}`);
  console.log(`  councilMint:       ${councilMint.toBase58()}  (HW wallet only)`);
  console.log(`  proposalPermMint:  ${proposalPermMint.toBase58()}  (bot delegate)`);
  console.log(`  addin:             ${cfg.addinProgramId.toBase58()}`);
  console.log(`  councilTor:        ${councilTor.toBase58()}`);
  console.log(`  communityTor:      ${communityTor.toBase58()}  (delegated to bot)`);
  console.log(`\nNext steps (separate scripts):`);
  console.log(`  - tsx scripts/init-payout-config.ts  (FFwq calls bin-farm init_payout_config)`);
  console.log(`  - tsx scripts/repoint-hopper.ts       (FFwq calls hopper update_routing → nativeTreasury)`);
  console.log(`  - tsx scripts/bootstrap-verify.ts     (memo-only proposal end-to-end test)`);
}

main().catch((e: unknown) => {
  console.error('\n[bootstrap] FATAL:', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
