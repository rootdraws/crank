/**
 * scripts/transfer-authority.ts
 *
 * FFwq-signed admin tx: starts the two-step authority rotation on both bin-farm
 * and hopper toward the HW wallet. Single tx with two ixs:
 *   - bin-farm.transfer_authority(HW)  → sets Config.pending_authority = HW
 *   - hopper.transfer_admin(HW)        → sets RoutingConfig.pending_admin = HW
 *
 * After this script: HW must sign `accept_authority` (bin-farm) +
 * `accept_admin` (hopper) — done via the sign-with-keystone dApp.
 *
 * Run AFTER:
 *   - HW first-use no-op test passed (HANDOFF gate).
 *
 * USAGE
 *   tsx scripts/transfer-authority.ts            # uses HW_PUBKEY env or HANDOFF default
 *   HW_PUBKEY=<other> tsx scripts/transfer-authority.ts
 *
 * ENV (in bot/.env):
 *   RPC_URL              — Solana RPC endpoint
 *   ADMIN_KEYPAIR_PATH   — FFwq cold key (default: ~/.config/solana/id.json)
 *   HW_PUBKEY            — incoming admin (default: DPr9NDe…)
 */

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: 'bot/.env' });

const BIN_FARM   = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
const HOPPER     = new PublicKey('2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF');
const HW_DEFAULT = 'DPr9NDewhqDMY58fpAZSBqjTfDYm9N8NKjP2o2RZLU9A';

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

  const newAuthority = new PublicKey(process.env.HW_PUBKEY ?? HW_DEFAULT);

  const binFarmIdl = JSON.parse(readFileSync('target/idl/bin_farm.json', 'utf8'));
  const hopperIdl  = JSON.parse(readFileSync('target/idl/hopper.json',   'utf8'));
  const binFarm = new Program(binFarmIdl, provider);
  const hopper  = new Program(hopperIdl,  provider);

  const [binFarmConfig] = PublicKey.findProgramAddressSync([Buffer.from('config')],         BIN_FARM);
  const [routingConfig] = PublicKey.findProgramAddressSync([Buffer.from('routing_config')], HOPPER);

  const cfg: any = await (binFarm.account as any).config.fetch(binFarmConfig);
  const routing: any = await (hopper.account as any).routingConfig.fetch(routingConfig);

  console.log('FFwq (signer):                 ', admin.publicKey.toBase58());
  console.log('Incoming HW authority:         ', newAuthority.toBase58());
  console.log('---');
  console.log('bin-farm Config.authority:     ', cfg.authority.toBase58());
  console.log('bin-farm pending_authority:    ', cfg.pendingAuthority?.toBase58?.() ?? '(default)');
  console.log('hopper RoutingConfig.admin:    ', routing.admin.toBase58());
  console.log('hopper pending_admin:          ', routing.pendingAdmin?.toBase58?.() ?? '(default)');
  console.log('---');

  if (cfg.authority.toBase58() !== admin.publicKey.toBase58()) {
    throw new Error(`bin-farm Config.authority (${cfg.authority.toBase58()}) != FFwq signer.`);
  }
  if (routing.admin.toBase58() !== admin.publicKey.toBase58()) {
    throw new Error(`hopper RoutingConfig.admin (${routing.admin.toBase58()}) != FFwq signer.`);
  }

  const ix1 = await (binFarm.methods as any)
    .transferAuthority(newAuthority)
    .accounts({ authority: admin.publicKey, config: binFarmConfig })
    .instruction();

  const ix2 = await (hopper.methods as any)
    .transferAdmin(newAuthority)
    .accounts({ admin: admin.publicKey, routingConfig })
    .instruction();

  const tx = new Transaction().add(ix1, ix2);
  const sig = await provider.sendAndConfirm(tx, [admin], { commitment: 'confirmed' });
  console.log('Tx:                            ', sig);
  console.log('Solscan:                       ', `https://solscan.io/tx/${sig}`);
  console.log('');
  console.log('NEXT: HW signs `accept_authority` (bin-farm) + `accept_admin` (hopper) via sign-with-keystone dApp.');
}

main().catch((e) => { console.error(e); process.exit(1); });
