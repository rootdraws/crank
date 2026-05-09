/**
 * scripts/set-fee-bps.ts
 *
 * FFwq-signed admin tx: bin-farm `set_fee_bps(new_fee_bps)`. Updates the exec-fee
 * cut taken on `harvest_bins` output flowing into `Config.fee_dest`.
 *
 * HANDOFF step 3: bump 50 bps → 100 bps (1%).
 *
 * USAGE
 *   tsx scripts/set-fee-bps.ts            # uses NEW_FEE_BPS env (default 100)
 *   NEW_FEE_BPS=50 tsx scripts/set-fee-bps.ts
 *
 * ENV (in bot/.env):
 *   RPC_URL              — Solana RPC endpoint
 *   ADMIN_KEYPAIR_PATH   — FFwq cold key (default: ~/.config/solana/id.json)
 *   NEW_FEE_BPS          — desired bps (default: 100, max: 1000 = 10%)
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
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
  const newFeeBps = Number(process.env.NEW_FEE_BPS ?? 100);
  if (!Number.isInteger(newFeeBps) || newFeeBps < 0 || newFeeBps > 1000) {
    throw new Error(`NEW_FEE_BPS must be 0..1000 (got ${newFeeBps})`);
  }

  const conn = new Connection(must('RPC_URL'), 'confirmed');
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(
      process.env.ADMIN_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`,
      'utf8',
    ))),
  );
  const provider = new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' });

  const idl = JSON.parse(readFileSync('target/idl/bin_farm.json', 'utf8'));
  const program = new Program(idl, provider);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], BIN_FARM);
  const cfg: any = await (program.account as any).config.fetch(configPda);

  console.log('Admin:           ', admin.publicKey.toBase58());
  console.log('Config PDA:      ', configPda.toBase58());
  console.log('Current fee_bps: ', cfg.feeBps);
  console.log('New fee_bps:     ', newFeeBps);

  if (cfg.authority.toBase58() !== admin.publicKey.toBase58()) {
    throw new Error(`Config.authority (${cfg.authority.toBase58()}) != signer. Wrong keypair.`);
  }
  if (cfg.feeBps === newFeeBps) {
    console.log('No change — already at target. Exiting.');
    return;
  }

  const sig = await (program.methods as any)
    .setFeeBps(newFeeBps)
    .accounts({ authority: admin.publicKey, config: configPda })
    .rpc({ commitment: 'confirmed' });

  console.log('Tx:              ', sig);
  console.log('Solscan:         ', `https://solscan.io/tx/${sig}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
