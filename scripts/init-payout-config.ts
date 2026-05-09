/**
 * scripts/init-payout-config.ts
 *
 * One-shot FFwq-signed call to bin-farm `init_payout_config`. Runs AFTER:
 *   1. bin-farm program upgrade (with cranksettle additions) is deployed
 *   2. realm bootstrap (scripts/bootstrap-realm.ts) has populated nativeTreasury
 *
 * Idempotency: bin-farm enforces this is a one-shot. Re-running fails with
 * `PayoutAdminAlreadyInitialized` (error 6014). Use `set-payout-admin.ts` for
 * later admin migration.
 *
 * USAGE
 *   tsx scripts/init-payout-config.ts
 *
 *   Env (in bot/.env):
 *     RPC_URL                 — Solana RPC endpoint
 *     ADMIN_KEYPAIR_PATH      — FFwq cold key (default: ~/.config/solana/id.json)
 *     NATIVE_TREASURY_PDA     — Native Treasury PDA from bootstrap output (= payout_admin)
 *     PAYOUT_BPS              — Default 2000 (= 20% to proposer)
 *     MATCH_RATIO_BPS         — Default 10000 (= 1.0x match ratio)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { BIN_FARM_PROGRAM_ID } from '@crankbot/core-sdk';
import { anchorDisc } from '@crankbot/core-sdk';

dotenv.config({ path: 'bot/.env' });

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env: ${k}`);
  return v;
}

async function main() {
  const conn = new Connection(must('RPC_URL'), 'confirmed');
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(
      process.env.ADMIN_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`,
      'utf8',
    ))),
  );
  const nativeTreasuryPda = new PublicKey(must('NATIVE_TREASURY_PDA'));
  const payoutBps = Number(process.env.PAYOUT_BPS ?? 2000);
  const matchRatioBps = Number(process.env.MATCH_RATIO_BPS ?? 10000);

  if (payoutBps > 5000) throw new Error(`payout_bps must be ≤ 5000 (50%)`);
  if (matchRatioBps > 50000) throw new Error(`match_ratio_bps must be ≤ 50000 (5x)`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    BIN_FARM_PROGRAM_ID,
  );

  console.log('admin:           ', admin.publicKey.toBase58());
  console.log('config:          ', configPda.toBase58());
  console.log('payout_bps:      ', payoutBps);
  console.log('match_ratio_bps: ', matchRatioBps);
  console.log('payout_admin:    ', nativeTreasuryPda.toBase58());

  // Hand-rolled Anchor ix:
  //   discriminator (8) | payout_bps (u16 LE) | match_ratio_bps (u16 LE) | payout_admin (32)
  const data = Buffer.alloc(8 + 2 + 2 + 32);
  anchorDisc('init_payout_config').copy(data, 0);
  data.writeUInt16LE(payoutBps, 8);
  data.writeUInt16LE(matchRatioBps, 10);
  nativeTreasuryPda.toBuffer().copy(data, 12);

  const ix = new TransactionInstruction({
    programId: BIN_FARM_PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
  console.log(`\n✓ init_payout_config: ${sig}`);
  console.log(`\nNext: tsx scripts/repoint-hopper.ts`);
}

main().catch((e: unknown) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
