/**
 * scripts/drain-treasury-native.ts
 *
 * One-shot recovery: governance proposal calling
 * `drain_treasury_native_to_ntp` to sweep operational SOL stranded on the
 * treasury user_vault PDA back to the NTP. Used to reclaim float left over
 * from the pre-Path-B-rework gas/rent passthrough design.
 *
 * Reads user_vault native lamport balance, leaves rent-exempt minimum behind.
 */

import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { submitTreasuryProposal } from '@crankbot/core-sdk';
import 'dotenv/config';

const BIN_FARM_PROGRAM_ID = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');

function disc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function buildDrainNativeIx(args: {
  caller: PublicKey;       // NTP (= user_vault.owner)
  userVault: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: BIN_FARM_PROGRAM_ID,
    keys: [
      { pubkey: args.caller,    isSigner: true,  isWritable: true },
      { pubkey: args.userVault, isSigner: false, isWritable: true },
    ],
    data: disc('drain_treasury_native_to_ntp'),
  });
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error('missing RPC_URL');
  const conn = new Connection(rpcUrl, 'confirmed');

  const must = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`missing env: ${k}`);
    return v;
  };

  const bot = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(must('BOT_KEYPAIR_PATH'), 'utf8'))),
  );

  const realm                 = new PublicKey(must('GOVERNANCE_REALM_ADDRESS'));
  const governance            = new PublicKey(must('GOVERNANCE_ADDRESS'));
  const governingTokenMint    = new PublicKey(must('GOVERNANCE_PROPOSAL_PERM_MINT'));
  const addinProgramId        = new PublicKey(must('GOVERNANCE_ADDIN_PROGRAM_ID'));
  const nativeTreasuryPda     = new PublicKey(must('NATIVE_TREASURY_PDA'));
  const operatorWallet        = bot.publicKey;

  // Treasury user_vault is the bin-farm UserVault PDA seeded by NTP.
  const [treasuryUserVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_vault'), nativeTreasuryPda.toBuffer()],
    BIN_FARM_PROGRAM_ID,
  );

  // Re-derive operator's TOR PDA the canonical way.
  const SPL_GOV = new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw');
  const [torPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('governance'),
      realm.toBuffer(),
      governingTokenMint.toBuffer(),
      operatorWallet.toBuffer(),
    ],
    SPL_GOV,
  );

  const before = await conn.getBalance(treasuryUserVault);
  const ntpBefore = await conn.getBalance(nativeTreasuryPda);
  console.log(`Treasury user_vault: ${treasuryUserVault.toBase58()}`);
  console.log(`  before:  ${before} lamports (${(before / 1e9).toFixed(6)} SOL)`);
  console.log(`NTP: ${nativeTreasuryPda.toBase58()}`);
  console.log(`  before:  ${ntpBefore} lamports (${(ntpBefore / 1e9).toFixed(6)} SOL)`);
  console.log(`TOR (operator): ${torPda.toBase58()}`);

  const ix = buildDrainNativeIx({
    caller: nativeTreasuryPda,
    userVault: treasuryUserVault,
  });

  console.log(`\nSubmitting drain proposal (1 inner ix)...`);
  const result = await submitTreasuryProposal({
    innerIxs: [ix],
    bot,
    realm,
    governance,
    tokenOwnerRecord: torPda,
    governingTokenMint,
    addinProgramId,
    governingTokenOwner: operatorWallet,
    name: `drain-native-${Date.now()}`,
    validatorContext: {
      botPubkey: bot.publicKey,
      nativeTreasuryPda,
      treasuryUserVault,
      knownPoolAddresses: new Set(),
    },
  }, conn);

  console.log(`\n✓ drain executed`);
  console.log(`  proposal:   ${result.proposalPda.toBase58()}`);
  console.log(`  insertSig:  ${result.insertSigs[0]}`);
  console.log(`  executeSig: ${result.executeSigs[0]}`);
  console.log(`  durationMs: ${result.durationMs}`);

  const after = await conn.getBalance(treasuryUserVault);
  const ntpAfter = await conn.getBalance(nativeTreasuryPda);
  console.log(`\nuser_vault after: ${after} lamports (${(after / 1e9).toFixed(6)} SOL)`);
  console.log(`NTP after:        ${ntpAfter} lamports (${(ntpAfter / 1e9).toFixed(6)} SOL)`);
  console.log(`Δ user_vault:     ${after - before} lamports`);
  console.log(`Δ NTP:            ${ntpAfter - ntpBefore} lamports`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
