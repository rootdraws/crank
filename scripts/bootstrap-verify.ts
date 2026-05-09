/**
 * scripts/bootstrap-verify.ts
 *
 * End-to-end verification of the realm bootstrap. Submits a memo-only proposal
 * via the bot's delegated authority and asserts the full lifecycle works:
 *   - createProposal + insertTransaction + signOffProposal + castVote (tx1)
 *   - executeTransaction (tx2)
 *
 * Memo-only is intentional — proves the bot can drive the lifecycle WITHOUT
 * touching treasury value. If this works, the SPL Governance integration is
 * sound and Path B treasury proposals will work the same way.
 *
 * USAGE
 *   tsx scripts/bootstrap-verify.ts
 *
 *   Env (in bot/.env):
 *     RPC_URL                — Solana RPC endpoint
 *     BOT_KEYPAIR_PATH       — Bot wallet keypair (delegate of operator's TOR)
 *     REALM_NAME             — Realm name from bootstrap
 *     OPERATOR_PUBKEY        — Operator's wallet pubkey (= TokenOwnerRecord owner)
 *     COUNCIL_MINT           — Council mint pubkey (from bootstrap output)
 *     GOVERNANCE_PUBKEY      — Governance account pubkey (from bootstrap output)
 *     NATIVE_TREASURY_PDA    — Native Treasury PDA (from bootstrap output)
 *     TREASURY_USER_VAULT    — bin-farm UserVault PDA owned by NATIVE_TREASURY_PDA
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { SplGovernance } from 'governance-idl-sdk';
import { SPL_MEMO_PROGRAM_ID } from '@crankbot/core-sdk';
import { submitTreasuryProposal, type WhitelistContext } from '@crankbot/core-sdk';

dotenv.config({ path: 'bot/.env' });

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env: ${k}`);
  return v;
}

function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: SPL_MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, 'utf8'),
  });
}

async function main() {
  const conn = new Connection(must('RPC_URL'), 'confirmed');
  const bot = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(must('BOT_KEYPAIR_PATH'), 'utf8'))),
  );
  const realmName = must('REALM_NAME');
  const operator = new PublicKey(must('OPERATOR_PUBKEY'));
  const councilMint = new PublicKey(must('COUNCIL_MINT'));
  const governance = new PublicKey(must('GOVERNANCE_PUBKEY'));
  const nativeTreasuryPda = new PublicKey(must('NATIVE_TREASURY_PDA'));
  const treasuryUserVault = new PublicKey(must('TREASURY_USER_VAULT'));

  const sdk = new SplGovernance(conn);
  const realm = sdk.pda.realmAccount({ name: realmName }).publicKey;
  const operatorTor = sdk.pda.tokenOwnerRecordAccount({
    realmAccount: realm,
    governingTokenMintAccount: councilMint,
    governingTokenOwner: operator,
  }).publicKey;

  console.log('═══ bootstrap-verify ═══');
  console.log('  realm:            ', realm.toBase58());
  console.log('  governance:       ', governance.toBase58());
  console.log('  nativeTreasury:   ', nativeTreasuryPda.toBase58());
  console.log('  bot:              ', bot.publicKey.toBase58());
  console.log('  operator (TOR):   ', operator.toBase58(), `→ TOR ${operatorTor.toBase58()}`);

  // The validator context is permissive for verification: empty ATA / pool sets,
  // bot pubkey set, expectedProposerWallet unset (no proposer-ata constraint
  // exercised because memo ix has no accounts).
  const validatorContext: WhitelistContext = {
    botPubkey: bot.publicKey,
    nativeTreasuryPda,
    treasuryUserVault,
    knownPoolAddresses: new Set(),
  };

  const innerIxs = [memoIx(`bootstrap-verify ${realmName} @ ${new Date().toISOString()}`)];

  console.log('\nSubmitting memo-only proposal end-to-end…');
  const startedAt = Date.now();
  const result = await submitTreasuryProposal(
    {
      innerIxs,
      bot,
      realm,
      governance,
      tokenOwnerRecord: operatorTor,
      governingTokenMint: councilMint,
      name: `verify-${realmName.slice(0, 16)}-${Math.floor(Date.now() / 1000)}`,
      validatorContext,
    },
    conn,
  );
  const wallMs = Date.now() - startedAt;

  console.log(`\n✓ verification PASSED in ${wallMs}ms (lifecycle ${result.durationMs}ms)`);
  console.log(`  proposalPda:    ${result.proposalPda.toBase58()}`);
  console.log(`  insertSig:      ${result.insertSig}`);
  console.log(`  executeSig:     ${result.executeSig}`);
  console.log(`\nThe bot can drive the full SPL Governance lifecycle.`);
  console.log(`Path B treasury proposals will work the same way.`);
}

main().catch((e: unknown) => {
  console.error('\nFATAL:', e instanceof Error ? e.message : e);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
