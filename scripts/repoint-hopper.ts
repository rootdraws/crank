/**
 * scripts/repoint-hopper.ts
 *
 * One-shot FFwq-signed call to hopper `update_routing` repointing the three
 * destinations (W-Buy / Treasury / Personal) so 80% of fee sweeps go to the
 * realm's Native Treasury PDA and 20% goes to the bot keypair (for ops gas
 * including Path B governance overhead — see vagbuck/buttfuck design notes).
 *
 * The hopper sweep splits 40/40/20 across the three slots:
 *   W-Buy    (40%) → Native Treasury PDA
 *   Treasury (40%) → Native Treasury PDA
 *   Personal (20%) → BOT keypair
 *
 * Result: 80% of every fee sweep accrues to the realm treasury; 20% funds
 * the bot's gas (Path A's deduct_gas reimburses Path A; Path B governance
 * overhead has no per-ix reimbursement, so it's covered by this stream).
 *
 * Runs AFTER realm bootstrap (scripts/bootstrap-realm.ts).
 *
 * Idempotency: re-running with the same destinations is a no-op.
 *
 * USAGE
 *   tsx scripts/repoint-hopper.ts
 *
 *   Env (in bot/.env):
 *     RPC_URL                 — Solana RPC endpoint
 *     ADMIN_KEYPAIR_PATH      — FFwq cold key (default: ~/.config/solana/id.json)
 *     NATIVE_TREASURY_PDA     — Native Treasury PDA from bootstrap output
 *     BOT_PUBKEY              — bot keypair pubkey (= Config.bot)
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
import { HOPPER_PROGRAM_ID } from '@crankbot/core-sdk';
import { anchorDisc } from '@crankbot/core-sdk';

dotenv.config({ path: 'bot/.env' });

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env: ${k}`);
  return v;
}

/**
 * Anchor `Option<Pubkey>` encoding: 1 byte tag (0 = None, 1 = Some) followed
 * by 32 bytes if Some. Same for `Option<u64>` / `Option<u16>` / `Option<[u16; 3]>`.
 */
function encodeOptionPubkey(p: PublicKey | null): Buffer {
  if (!p) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), p.toBuffer()]);
}
function encodeOptionNone(): Buffer {
  return Buffer.from([0]);
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
  const botPubkey = new PublicKey(must('BOT_PUBKEY'));

  const [routingConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('routing_config')],
    HOPPER_PROGRAM_ID,
  );

  console.log('admin:           ', admin.publicKey.toBase58());
  console.log('routing_config:  ', routingConfig.toBase58());
  console.log('w_buy    (40%) → ', nativeTreasuryPda.toBase58());
  console.log('treasury (40%) → ', nativeTreasuryPda.toBase58());
  console.log('personal (20%) → ', botPubkey.toBase58(), ' [bot ops gas]');

  // update_routing args:
  //   new_w_buy:                  Option<Pubkey>
  //   new_treasury:               Option<Pubkey>
  //   new_personal:               Option<Pubkey>
  //   new_sol_split_bps:          Option<[u16; 3]>
  //   new_sol_threshold_lamports: Option<u64>
  //   new_cranker_tip_bps:        Option<u16>
  const data = Buffer.concat([
    anchorDisc('update_routing'),
    encodeOptionPubkey(nativeTreasuryPda),  // new_w_buy    (40% slot)
    encodeOptionPubkey(nativeTreasuryPda),  // new_treasury (40% slot)
    encodeOptionPubkey(botPubkey),          // new_personal (20% slot — bot)
    encodeOptionNone(),                      // new_sol_split_bps — leave unchanged (40/40/20)
    encodeOptionNone(),                      // new_sol_threshold_lamports — leave unchanged
    encodeOptionNone(),                      // new_cranker_tip_bps — leave unchanged
  ]);

  const ix = new TransactionInstruction({
    programId: HOPPER_PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      { pubkey: routingConfig, isSigner: false, isWritable: true },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
  console.log(`\n✓ hopper update_routing: ${sig}`);
  console.log(`\nNext: tsx scripts/bootstrap-verify.ts`);
}

main().catch((e: unknown) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
