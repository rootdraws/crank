/**
 * scripts/devnet-rehearsal.ts
 *
 * One-shot end-to-end rehearsal of the addin-gated governance flow on devnet.
 *
 *   1. Mint a proposal-perm token (membership, 1 supply, operator-held)
 *   2. createRealm (community-side proposal-perm, no council for simplicity)
 *   3. depositGoverningTokens → operator gets community TOR with weight 1
 *   4. createGovernance (community vote enabled, YesVotePercentage(1), Early tipping)
 *   5. createNativeTreasury
 *   6. addin.create_registrar + update_registrar_whitelist([memo])
 *   7. setRealmConfig (community_voter_weight_addin = our addin)
 *   8. addin.create_voter_weight_record for operator
 *   9. setGovernanceDelegate (community TOR → bot)
 *   10. POSITIVE TEST: bot submits memo proposal — should tip + execute
 *   11. NEGATIVE TEST: bot submits proposal with non-whitelisted ix (system transfer)
 *       — addin returns weight=0 — proposal must NOT tip.
 *
 * Run: tsx scripts/devnet-rehearsal.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  createInitializeMintInstruction,
  createMintToInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from '@solana/spl-token';
import { SplGovernance } from 'governance-idl-sdk';
import BN from 'bn.js';
import { readFileSync } from 'fs';
import * as os from 'os';
import type * as AddinT from '../packages/core-sdk/whitelist-addin';
type Addin = typeof AddinT;
type WhitelistEntry = AddinT.WhitelistEntry;
// treasury-proposal imported dynamically below to dodge tsx ESM named-export issue
type WhitelistContext = {
  botPubkey: PublicKey;
  nativeTreasuryPda: PublicKey;
  treasuryUserVault: PublicKey;
  knownPoolAddresses: Set<string>;
  expectedProposerWallet?: PublicKey;
  treasuryAtas?: Set<string>;
  meteoraPosition?: PublicKey;
};

const VWR_ACTION_CAST_VOTE = 0;

const SPL_MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const RPC = 'https://api.devnet.solana.com';
const ADDIN_PROGRAM_ID = new PublicKey('9Tpa3wZwm21yPFvZtDQYnJic5UGKPNQKqQqCiC6tkUnv');
const SPL_GOVERNANCE = new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw');

const conn = new Connection(RPC, 'confirmed');

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
}

async function send(
  ixs: TransactionInstruction[],
  signers: Keypair[],
  payer: Keypair,
  label: string,
): Promise<string> {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
    .add(...ixs);
  tx.feePayer = payer.publicKey;
  const allSigners = signers.find(s => s.publicKey.equals(payer.publicKey)) ? signers : [payer, ...signers];
  const sig = await sendAndConfirmTransaction(conn, tx, allSigners, {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`  ${label}: ${sig}`);
  return sig;
}

async function main() {
  const Addin: Addin = await import('../packages/core-sdk/whitelist-addin');
  console.log('=== devnet-rehearsal ===');
  console.log('addin keys:', Object.keys(Addin).filter(k => k.includes('PDA') || k.includes('Registrar') || k.includes('Voter')).join(','));
  const operator = loadKp(`${os.homedir()}/.config/solana/id.json`);
  console.log(`operator: ${operator.publicKey.toBase58()}`);

  const balance = await conn.getBalance(operator.publicKey);
  console.log(`operator balance: ${balance / 1e9} SOL`);
  if (balance < 0.5 * 1e9) {
    throw new Error('insufficient devnet SOL — need >= 0.5');
  }

  // Bot keypair — fresh for this rehearsal
  const bot = Keypair.generate();
  console.log(`bot: ${bot.publicKey.toBase58()}`);

  // Fund bot for tx fees
  await send(
    [SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: bot.publicKey, lamports: 0.2 * 1e9 })],
    [operator],
    operator,
    'fund bot',
  );

  const sdk = new SplGovernance(conn, SPL_GOVERNANCE);

  // ─── Step 1: proposal-perm mint (membership, supply 1) ────────────────────
  console.log('\n[1] proposal-perm mint');
  const ppMintKp = Keypair.generate();
  console.log(`  proposal-perm mint: ${ppMintKp.publicKey.toBase58()}`);
  const opPpAta = getAssociatedTokenAddressSync(ppMintKp.publicKey, operator.publicKey);
  const mintRent = await getMinimumBalanceForRentExemptMint(conn);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: operator.publicKey,
        newAccountPubkey: ppMintKp.publicKey,
        space: MINT_SIZE,
        lamports: mintRent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(ppMintKp.publicKey, 0, operator.publicKey, operator.publicKey),
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey, opPpAta, operator.publicKey, ppMintKp.publicKey,
      ),
      createMintToInstruction(ppMintKp.publicKey, opPpAta, operator.publicKey, BigInt(1)),
    ],
    [operator, ppMintKp],
    operator,
    'mint pp',
  );

  // ─── Step 2: createRealm ─────────────────────────────────────────────────
  console.log('\n[2] createRealm');
  const realmName = `crank-rehearsal-${Date.now() % 10_000_000}`;
  const realmPda = sdk.pda.realmAccount({ name: realmName }).publicKey;
  console.log(`  realm: ${realmPda.toBase58()} (name="${realmName}")`);

  await send(
    [
      await sdk.createRealmInstruction(
        realmName,
        ppMintKp.publicKey,
        new BN(1),                                // minCommunityWeightToCreateGovernance
        operator.publicKey,                        // payer
        { type: 'absolute', amount: new BN(1) },  // communityMintMaxVoterWeightSource (1-token cap)
        undefined,                                 // councilTokenMint — community-only
        'membership',                              // communityTokenType
        'liquid',                                  // councilTokenType (unused)
        ADDIN_PROGRAM_ID,                          // communityVoterWeightAddinProgramId — gated from t=0
      ),
    ],
    [operator],
    operator,
    'createRealm',
  );

  // ─── Step 3: deposit proposal-perm token → operator's TOR ────────────────
  console.log('\n[3] depositGoverningTokens');
  const operatorTor = sdk.pda.tokenOwnerRecordAccount({
    realmAccount: realmPda,
    governingTokenMintAccount: ppMintKp.publicKey,
    governingTokenOwner: operator.publicKey,
  }).publicKey;
  console.log(`  operator TOR: ${operatorTor.toBase58()}`);

  await send(
    [
      await sdk.depositGoverningTokensInstruction(
        realmPda,
        ppMintKp.publicKey,
        opPpAta,
        operator.publicKey,
        operator.publicKey,
        operator.publicKey,
        new BN(1),
      ),
    ],
    [operator],
    operator,
    'deposit',
  );

  // ─── Step 4: createGovernance + nativeTreasury ────────────────────────────
  console.log('\n[4] createGovernance + nativeTreasury');
  const govSeed = Keypair.generate().publicKey;
  const governance = sdk.pda.governanceAccount({ realmAccount: realmPda, seed: govSeed }).publicKey;
  const nativeTreasury = sdk.pda.nativeTreasuryAccount({ governanceAccount: governance }).publicKey;
  console.log(`  governance: ${governance.toBase58()}`);
  console.log(`  ntp: ${nativeTreasury.toBase58()}`);

  const govConfig = {
    communityVoteThreshold: { yesVotePercentage: [1] } as never,
    minCommunityWeightToCreateProposal: new BN(1),
    minTransactionHoldUpTime: 0,
    votingBaseTime: 60,
    communityVoteTipping: { early: {} } as never,
    councilVoteThreshold: { disabled: {} } as never,
    councilVetoVoteThreshold: { disabled: {} } as never,
    minCouncilWeightToCreateProposal: new BN(1),
    councilVoteTipping: { disabled: {} } as never,
    communityVetoVoteThreshold: { disabled: {} } as never,
    votingCoolOffTime: 0,
    depositExemptProposalCount: 10,
  };

  await send(
    [
      await sdk.createGovernanceInstruction(
        govConfig as never,
        realmPda,
        operator.publicKey,
        operatorTor,
        operator.publicKey,
        govSeed,
      ),
      await sdk.createNativeTreasuryInstruction(governance, operator.publicKey),
    ],
    [operator],
    operator,
    'createGovernance + ntp',
  );

  // ─── Step 5: addin.create_registrar + whitelist (memo only) ──────────────
  console.log('\n[5] addin: create_registrar + whitelist');
  const [registrar] = Addin.getRegistrarPDA(ADDIN_PROGRAM_ID, realmPda, ppMintKp.publicKey);
  console.log(`  registrar: ${registrar.toBase58()}`);

  await send(
    [
      Addin.buildCreateRegistrarIx({
        addinProgramId: ADDIN_PROGRAM_ID,
        realm: realmPda,
        governingTokenMint: ppMintKp.publicKey,
        authority: operator.publicKey,
        payer: operator.publicKey,
        governanceProgramId: SPL_GOVERNANCE,
      }),
    ],
    [operator],
    operator,
    'create_registrar',
  );

  // Whitelist: only SPL Memo. Anything else → addin returns 0.
  const whitelist: WhitelistEntry[] = [
    { programId: SPL_MEMO_PROGRAM_ID, discriminator: Buffer.alloc(0), discLen: 0 },
  ];
  await send(
    [
      Addin.buildUpdateRegistrarWhitelistIx({
        addinProgramId: ADDIN_PROGRAM_ID,
        realm: realmPda,
        governingTokenMint: ppMintKp.publicKey,
        authority: operator.publicKey,
        whitelist,
      }),
    ],
    [operator],
    operator,
    'whitelist',
  );

  // (addin already registered at createRealm time — no setRealmConfig needed)

  // ─── Step 6: addin.create_voter_weight_record (idempotent) ───────────────
  console.log('\n[6] create_voter_weight_record');
  const [vwr] = Addin.getVoterWeightRecordPDA(
    ADDIN_PROGRAM_ID, realmPda, ppMintKp.publicKey, operator.publicKey,
  );
  console.log(`  vwr: ${vwr.toBase58()}`);
  await send(
    [
      Addin.buildCreateVoterWeightRecordIx({
        addinProgramId: ADDIN_PROGRAM_ID,
        realm: realmPda,
        governingTokenMint: ppMintKp.publicKey,
        governingTokenOwner: operator.publicKey,
        payer: operator.publicKey,
      }),
    ],
    [operator],
    operator,
    'create_vwr',
  );

  // ─── Step 7: setGovernanceDelegate (operator → bot) ──────────────────────
  console.log('\n[7] setGovernanceDelegate → bot');
  await send(
    [
      await sdk.setGovernanceDelegateInstruction(
        operatorTor,
        operator.publicKey,
        bot.publicKey,
      ),
    ],
    [operator],
    operator,
    'setDelegate',
  );

  // ─── POSITIVE TEST: memo proposal end-to-end ─────────────────────────────
  console.log('\n=== POSITIVE TEST: memo proposal ===');
  const memoText = `rehearsal positive ${Date.now()}`;
  const memoIx = new TransactionInstruction({
    programId: SPL_MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memoText, 'utf8'),
  });

  const validatorContext: WhitelistContext = {
    botPubkey: bot.publicKey,
    nativeTreasuryPda: nativeTreasury,
    treasuryUserVault: nativeTreasury,  // not relevant for memo
    knownPoolAddresses: new Set(),
  };

  // Inline lifecycle (avoids submitTreasuryProposal — easier to debug per-ix)
  const posSeed = Keypair.generate().publicKey;
  const posProposal = sdk.pda.proposalAccount({
    governanceAccount: governance, governingTokenMint: ppMintKp.publicKey, proposalSeed: posSeed,
  }).publicKey;
  const posProposalTx = sdk.pda.proposalTransactionAccount({
    proposal: posProposal, optionIndex: 0, index: 0,
  }).publicKey;
  console.log(`  proposal: ${posProposal.toBase58()}`);
  void validatorContext;

  // Bridge: VWR for CreateProposal action — addin grants weight=1 for non-vote actions
  console.log('  building VWR(CreateProposal)');
  const vwrCreateIx = Addin.buildUpdateVoterWeightRecordIx({
    addinProgramId: ADDIN_PROGRAM_ID,
    realm: realmPda,
    governingTokenMint: ppMintKp.publicKey,
    governingTokenOwner: operator.publicKey,
    voterWeightAction: 3,                 // CreateProposal
    proposal: PublicKey.default,           // unused for non-vote action
    proposalTransactions: [],              // none — proposal doesn't exist yet
  });

  console.log('  building createIx');
  const createIx = await sdk.createProposalInstruction(
    'rehearsal-memo', '',
    { choiceType: 'single', multiChoiceOptions: null },
    ['Approve'], true,                            // useDenyOption=true
    realmPda, governance, operatorTor, ppMintKp.publicKey,
    bot.publicKey, bot.publicKey, posSeed,
    vwr,
  );
  console.log('  ok createIx');

  // Send tx1a alone and inspect state
  await send([vwrCreateIx, createIx], [bot], bot, 'tx1a: vwr+create');
  const stateAfterCreate = (await conn.getAccountInfo(posProposal))?.data[65];
  console.log(`  state after createProposal: ${stateAfterCreate}`);

  console.log('  building insertIx');
  const insertIx = await sdk.insertTransactionInstruction(
    [memoIx], 0, 0, 0, governance, posProposal, operatorTor, bot.publicKey, bot.publicKey,
  );
  console.log('  ok insertIx');

  console.log('  building signOffIx');
  const signOffIx = await sdk.signOffProposalInstruction(
    realmPda, governance, posProposal, bot.publicKey, undefined, operatorTor,
  );
  console.log('  ok signOffIx');

  console.log('  building update_voter_weight_record');
  const updateVwrIx = Addin.buildUpdateVoterWeightRecordIx({
    addinProgramId: ADDIN_PROGRAM_ID,
    realm: realmPda,
    governingTokenMint: ppMintKp.publicKey,
    governingTokenOwner: operator.publicKey,
    voterWeightAction: VWR_ACTION_CAST_VOTE,
    proposal: posProposal,
    proposalTransactions: [posProposalTx],
  });

  console.log('  building castVote');
  const castVoteIx = await sdk.castVoteInstruction(
    { approve: { 0: [{ rank: 0, weightPercentage: 100 }] } } as never,
    realmPda, governance, posProposal,
    operatorTor, operatorTor, bot.publicKey,
    ppMintKp.publicKey, bot.publicKey,
    vwr,                                          // voterWeightRecord
  );
  console.log('  ok castVote');

  console.log('  sending tx1b: insert+signOff+vwr+vote');
  await send([insertIx, signOffIx, updateVwrIx, castVoteIx], [bot], bot, 'tx1b');

  const propInfo = await conn.getAccountInfo(posProposal);
  if (propInfo) {
    console.log(`  proposal state byte: ${propInfo.data[65]} (5=Voting, 4=Succeeded)`);
  }

  console.log('  waiting 2s for hold-up time...');
  await new Promise(r => setTimeout(r, 2000));
  console.log('  sending tx2 (executeTransaction)');
  const remaining = [
    { pubkey: memoIx.programId, isSigner: false, isWritable: false },
  ];
  const executeIx = await sdk.executeTransactionInstruction(
    governance, posProposal, posProposalTx, remaining,
  );
  await send([executeIx], [bot], bot, 'tx2 execute');
  console.log('  ✓ POSITIVE PASS');

  // ─── NEGATIVE TEST: non-whitelisted ix should NOT tip ─────────────────────
  // We bypass the TS validator (which would also block this) by building the
  // proposal lifecycle manually so the addin is the only gate.
  console.log('\n=== NEGATIVE TEST: system transfer (not whitelisted) ===');
  const drainIx = SystemProgram.transfer({
    fromPubkey: nativeTreasury,
    toPubkey: bot.publicKey,    // attacker target
    lamports: 1000,
  });

  const proposalSeed = Keypair.generate().publicKey;
  const negProposal = sdk.pda.proposalAccount({
    governanceAccount: governance,
    governingTokenMint: ppMintKp.publicKey,
    proposalSeed,
  }).publicKey;
  const negProposalTx = sdk.pda.proposalTransactionAccount({
    proposal: negProposal,
    optionIndex: 0,
    index: 0,
  }).publicKey;

  await send(
    [
      Addin.buildUpdateVoterWeightRecordIx({
        addinProgramId: ADDIN_PROGRAM_ID,
        realm: realmPda,
        governingTokenMint: ppMintKp.publicKey,
        governingTokenOwner: operator.publicKey,
        voterWeightAction: 3,
        proposal: PublicKey.default,
        proposalTransactions: [],
      }),
      await sdk.createProposalInstruction(
        'rehearsal-drain', '',
        { choiceType: 'single', multiChoiceOptions: null },
        ['Approve'], true,
        realmPda, governance, operatorTor, ppMintKp.publicKey,
        bot.publicKey, bot.publicKey, proposalSeed,
        vwr,
      ),
      await sdk.insertTransactionInstruction(
        [drainIx], 0, 0, 0, governance, negProposal, operatorTor, bot.publicKey, bot.publicKey,
      ),
      await sdk.signOffProposalInstruction(
        realmPda, governance, negProposal, bot.publicKey, undefined, operatorTor,
      ),
      Addin.buildUpdateVoterWeightRecordIx({
        addinProgramId: ADDIN_PROGRAM_ID,
        realm: realmPda,
        governingTokenMint: ppMintKp.publicKey,
        governingTokenOwner: operator.publicKey,
        voterWeightAction: VWR_ACTION_CAST_VOTE,
        proposal: negProposal,
        proposalTransactions: [negProposalTx],
      }),
      await sdk.castVoteInstruction(
        { approve: { 0: [{ rank: 0, weightPercentage: 100 }] } } as never,
        realmPda, governance, negProposal,
        operatorTor, operatorTor, bot.publicKey,
        ppMintKp.publicKey, bot.publicKey,
        vwr,
      ),
    ],
    [bot],
    bot,
    'NEG: tx1',
  );

  // Read VWR — must be 0
  const vwrInfo = await conn.getAccountInfo(vwr);
  if (!vwrInfo) throw new Error('VWR missing');
  // VoterWeightRecord layout: 8 disc + 32 realm + 32 mint + 32 owner + 8 voter_weight (LE u64)
  const recordedWeight = vwrInfo.data.readBigUInt64LE(8 + 32 + 32 + 32);
  console.log(`  VWR.voter_weight after addin call (NEG): ${recordedWeight}`);
  if (recordedWeight !== 0n) {
    console.error(`  ✗ NEGATIVE FAILED — addin granted weight=${recordedWeight} for non-whitelisted ix`);
    process.exit(1);
  }

  // Try executeTransaction — should fail because vote didn't tip (proposal still in Voting)
  let negExecuteFailed = false;
  try {
    await send(
      [
        await sdk.executeTransactionInstruction(
          governance, negProposal, negProposalTx,
          [
            { pubkey: nativeTreasury, isSigner: false, isWritable: true },
            { pubkey: bot.publicKey, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
        ),
      ],
      [bot],
      bot,
      'NEG: execute (should fail)',
    );
  } catch (e) {
    negExecuteFailed = true;
    const msg = (e as Error).message ?? '';
    console.log(`  ✓ NEGATIVE PASS — executeTransaction rejected: ${msg.slice(0, 120)}`);
  }
  if (!negExecuteFailed) {
    console.error('  ✗ NEGATIVE FAILED — proposal executed despite non-whitelisted ix');
    process.exit(1);
  }

  console.log('\n=== ALL TESTS PASSED ===');
  console.log(`realm:      ${realmPda.toBase58()}`);
  console.log(`governance: ${governance.toBase58()}`);
  console.log(`addin:      ${ADDIN_PROGRAM_ID.toBase58()}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
