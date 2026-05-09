/**
 * scripts/set-tax-config.ts
 *
 * FFwq-signed admin tx: bin-farm `set_tax_config(tax_bps, tax_reserve)`. Enables
 * the second transfer leg in `settle_proposer` — `output × tax_bps / 10000` flows
 * to `tax_reserve`'s output ATA on every settle. On-chain combined cap:
 *   payout_bps + tax_bps ≤ 5000  (50%)
 *
 * HANDOFF step 4: tax_bps=2500, tax_reserve=`77QfJ6GLuFGWd9fYYUVcrjS5RH7aNgJjwDnZWuxcwtj4`.
 *
 * Run AFTER expand-config-v2.ts (the `tax_bps` + `tax_reserve` fields are zero-init
 * after the realloc, then this ix populates them).
 *
 * USAGE
 *   tsx scripts/set-tax-config.ts
 *   TAX_BPS=2500 TAX_RESERVE=77Qf... tsx scripts/set-tax-config.ts
 *
 * ENV (in bot/.env):
 *   RPC_URL              — Solana RPC endpoint
 *   ADMIN_KEYPAIR_PATH   — FFwq cold key (default: ~/.config/solana/id.json)
 *   TAX_BPS              — bps to skim to tax_reserve (default: 2500)
 *   TAX_RESERVE          — base58 pubkey (default: HANDOFF value)
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: 'bot/.env' });

const BIN_FARM = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
const DEFAULT_TAX_RESERVE = '77QfJ6GLuFGWd9fYYUVcrjS5RH7aNgJjwDnZWuxcwtj4';

function must(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env: ${k}`);
  return v;
}

async function main() {
  const taxBps = Number(process.env.TAX_BPS ?? 2500);
  const taxReserve = new PublicKey(process.env.TAX_RESERVE ?? DEFAULT_TAX_RESERVE);

  if (!Number.isInteger(taxBps) || taxBps < 0 || taxBps > 5000) {
    throw new Error(`TAX_BPS must be 0..5000 (got ${taxBps})`);
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

  console.log('Admin:                ', admin.publicKey.toBase58());
  console.log('Config PDA:           ', configPda.toBase58());
  console.log('Current tax_bps:      ', cfg.taxBps ?? '(field absent — run expand_config_v2 first)');
  console.log('Current tax_reserve:  ', cfg.taxReserve?.toBase58() ?? '(field absent)');
  console.log('payout_bps:           ', cfg.payoutBps);
  console.log('Combined cap check:    payout_bps + tax_bps =', (cfg.payoutBps ?? 0) + taxBps, '(must ≤ 5000)');
  console.log('New tax_bps:          ', taxBps);
  console.log('New tax_reserve:      ', taxReserve.toBase58());

  if (cfg.authority.toBase58() !== admin.publicKey.toBase58()) {
    throw new Error(`Config.authority (${cfg.authority.toBase58()}) != signer. Wrong keypair.`);
  }
  if (cfg.taxBps === undefined) {
    throw new Error('Config layout still v1 — run expand-config-v2.ts first.');
  }
  if ((cfg.payoutBps ?? 0) + taxBps > 5000) {
    throw new Error(`Combined cap exceeded: ${cfg.payoutBps} + ${taxBps} > 5000`);
  }

  const sig = await (program.methods as any)
    .setTaxConfig(taxBps, taxReserve)
    .accounts({ authority: admin.publicKey, config: configPda })
    .rpc({ commitment: 'confirmed' });

  console.log('Tx:                   ', sig);
  console.log('Solscan:              ', `https://solscan.io/tx/${sig}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
