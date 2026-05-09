/**
 * scripts/expand-routing-config-v2.ts
 *
 * One-shot FFwq-signed call to hopper `expand_routing_config_v2`. Reallocs the
 * on-chain RoutingConfig PDA from v1 (3-way: w_buy/treasury/personal, [u16;3])
 * to v2 (4-way: dest_treasury/dest_admin/dest_ops/dest_tax, [u16;4]). Idempotent.
 *
 * After migration the dest_* fields contain v1's (w_buy, treasury, personal)
 * pubkey bytes plus zeros for dest_tax. MUST follow with `update_routing` to
 * overwrite with the desired 4-way destinations + sol_split_bps.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: 'bot/.env' });

const HOPPER = new PublicKey('2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF');

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
  const before = await conn.getAccountInfo(routingPda);
  if (!before) throw new Error(`RoutingConfig ${routingPda.toBase58()} not found`);

  console.log('Admin:           ', admin.publicKey.toBase58());
  console.log('RoutingConfig:   ', routingPda.toBase58());
  console.log('Current size:    ', before.data.length, 'bytes');

  const sig = await (program.methods as any)
    .expandRoutingConfigV2()
    .accounts({ admin: admin.publicKey, routingConfig: routingPda })
    .rpc({ commitment: 'confirmed' });

  const after = await conn.getAccountInfo(routingPda);
  console.log('Tx:              ', sig);
  console.log('New size:        ', after?.data.length, 'bytes');
  console.log('Solscan:         ', `https://solscan.io/tx/${sig}`);
  console.log('');
  console.log('NEXT: run update-routing.ts to overwrite the carry-over dest fields with proper v2 destinations.');
}

main().catch((e) => { console.error(e); process.exit(1); });
