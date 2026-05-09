/**
 * scripts/update-routing.ts
 *
 * FFwq-signed admin tx: hopper `update_routing(...)`. After
 * `expand_routing_config_v2`, the dest_* fields contain v1 carry-over (w_buy
 * → dest_treasury, treasury → dest_admin, personal → dest_ops) and the
 * sol_split_bps[4] / threshold / cranker_tip are zero. This script overwrites
 * with the desired 4-way layout per HANDOFF defaults.
 *
 * Defaults:
 *   dest_treasury = admin (placeholder; update to NTP after bootstrap-realm.ts)
 *   dest_admin    = HW pubkey (DPr9NDe...)
 *   dest_ops      = admin (placeholder; update to a dedicated ops wallet later)
 *   dest_tax      = TAX_RESERVE (77QfJ6GLuFGWd9fYYUVcrjS5RH7aNgJjwDnZWuxcwtj4)
 *   sol_split_bps = [2500, 2500, 2500, 2500]
 *   threshold     = 100_000_000 (0.1 SOL)
 *   cranker_tip   = 0
 *
 * Override any default via env (DEST_TREASURY, DEST_ADMIN, DEST_OPS, DEST_TAX,
 * SOL_SPLIT_BPS, SOL_THRESHOLD, CRANKER_TIP).
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: 'bot/.env' });

const HOPPER = new PublicKey('2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF');
const HW_DEFAULT = 'DPr9NDewhqDMY58fpAZSBqjTfDYm9N8NKjP2o2RZLU9A';
const TAX_DEFAULT = '77QfJ6GLuFGWd9fYYUVcrjS5RH7aNgJjwDnZWuxcwtj4';

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
  const provider = new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync('target/idl/hopper.json', 'utf8'));
  const program = new Program(idl, provider);

  const [routingPda] = PublicKey.findProgramAddressSync([Buffer.from('routing_config')], HOPPER);

  const destTreasury = new PublicKey(process.env.DEST_TREASURY ?? admin.publicKey.toBase58());
  const destAdmin    = new PublicKey(process.env.DEST_ADMIN    ?? HW_DEFAULT);
  const destOps      = new PublicKey(process.env.DEST_OPS      ?? admin.publicKey.toBase58());
  const destTax      = new PublicKey(process.env.DEST_TAX      ?? TAX_DEFAULT);

  const splits = (process.env.SOL_SPLIT_BPS ?? '2500,2500,2500,2500').split(',').map((s) => Number(s.trim()));
  if (splits.length !== 4 || splits.reduce((a, b) => a + b, 0) !== 10000) {
    throw new Error(`SOL_SPLIT_BPS must be 4 ints summing to 10000`);
  }
  const threshold = new BN(process.env.SOL_THRESHOLD ?? '100000000');
  const tip = Number(process.env.CRANKER_TIP ?? 0);

  console.log('Admin:           ', admin.publicKey.toBase58());
  console.log('RoutingConfig:   ', routingPda.toBase58());
  console.log('New dest_treasury:', destTreasury.toBase58(), destTreasury.equals(admin.publicKey) ? '  (placeholder = admin)' : '');
  console.log('New dest_admin:  ', destAdmin.toBase58());
  console.log('New dest_ops:    ', destOps.toBase58(), destOps.equals(admin.publicKey) ? '  (placeholder = admin)' : '');
  console.log('New dest_tax:    ', destTax.toBase58());
  console.log('Splits:          ', splits.join('/'), 'bps');
  console.log('Threshold:       ', threshold.toString(), 'lamports');
  console.log('Cranker tip:     ', tip, 'bps');

  const sig = await (program.methods as any)
    .updateRouting(destTreasury, destAdmin, destOps, destTax, splits, threshold, tip)
    .accounts({ admin: admin.publicKey, routingConfig: routingPda })
    .rpc({ commitment: 'confirmed' });

  console.log('Tx:              ', sig);
  console.log('Solscan:         ', `https://solscan.io/tx/${sig}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
