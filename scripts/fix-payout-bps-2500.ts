/**
 * scripts/fix-payout-bps-2500.ts
 *
 * One-shot correction: bumps `Config.payout_bps` from 2000 to 2500 so the
 * Path B settle math lands at HANDOFF's 25% proposer / 25% tax / 50% treasury
 * split. Three ixs in one FFwq-signed tx:
 *   1. set_payout_admin(FFwq)       — admin-gated, temporarily reclaims payout admin
 *   2. update_payout_config(2500, 10000) — payout-admin-gated, FFwq signs (now)
 *   3. set_payout_admin(NTP)        — restore governance ownership
 *
 * Atomic — if any ix fails the whole tx reverts and admin stays NTP.
 */

import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: 'bot/.env' });

const BIN_FARM = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');

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
  const ntp = new PublicKey(must('NATIVE_TREASURY_PDA'));
  const provider = new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' });
  const idl = JSON.parse(readFileSync('target/idl/bin_farm.json', 'utf8'));
  const program = new Program(idl, provider);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], BIN_FARM);

  const cfg: any = await (program.account as any).config.fetch(configPda);
  console.log('admin:                  ', admin.publicKey.toBase58());
  console.log('config.authority:       ', cfg.authority.toBase58());
  console.log('config.payout_admin:    ', cfg.payoutAdmin.toBase58());
  console.log('config.payout_bps:      ', cfg.payoutBps);
  console.log('config.match_ratio_bps: ', cfg.matchRatioBps);
  console.log('config.tax_bps:         ', cfg.taxBps);
  if (cfg.payoutBps === 2500) {
    console.log('payout_bps already 2500 — nothing to do.');
    return;
  }

  const ix1 = await (program.methods as any)
    .setPayoutAdmin(admin.publicKey)
    .accounts({ authority: admin.publicKey, config: configPda })
    .instruction();

  const ix2 = await (program.methods as any)
    .updatePayoutConfig(2500, 10000)
    .accounts({ payoutAdmin: admin.publicKey, config: configPda })
    .instruction();

  const ix3 = await (program.methods as any)
    .setPayoutAdmin(ntp)
    .accounts({ authority: admin.publicKey, config: configPda })
    .instruction();

  const tx = new Transaction().add(ix1, ix2, ix3);
  const sig = await provider.sendAndConfirm(tx, [admin], { commitment: 'confirmed' });
  console.log('Tx:', sig);
  console.log('Solscan: https://solscan.io/tx/' + sig);
}

main().catch((e) => { console.error(e); process.exit(1); });
