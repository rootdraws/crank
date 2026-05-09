/**
 * scripts/expand-config-v2.ts
 *
 * One-shot FFwq-signed call to bin-farm `expand_config_v2`. Reallocs the on-chain
 * Config PDA from the v1 layout (with `[u8; 20]` reserved tail) to the v2 layout
 * (with `tax_bps: u16` + `tax_reserve: Pubkey` fields). Idempotent: if Config is
 * already v2-sized the program returns Ok with no state change.
 *
 * Run AFTER:
 *   - `solana program deploy` of bin-farm v2 (HANDOFF step 1)
 *
 * Run BEFORE:
 *   - set-fee-bps.ts (HANDOFF step 3) — only matters that Config layout matches before reading new fields.
 *   - set-tax-config.ts (HANDOFF step 4) — depends on `tax_bps` + `tax_reserve` fields existing.
 *
 * USAGE
 *   tsx scripts/expand-config-v2.ts
 *
 * ENV (in bot/.env):
 *   RPC_URL              — Solana RPC endpoint
 *   ADMIN_KEYPAIR_PATH   — FFwq cold key (default: ~/.config/solana/id.json)
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

  const before = await conn.getAccountInfo(configPda);
  if (!before) throw new Error(`Config PDA ${configPda.toBase58()} not found — wrong program?`);
  console.log('Admin:           ', admin.publicKey.toBase58());
  console.log('Config PDA:      ', configPda.toBase58());
  console.log('Current size:    ', before.data.length, 'bytes');

  const cfg = await (program.account as any).config.fetch(configPda);
  if (cfg.authority.toBase58() !== admin.publicKey.toBase58()) {
    throw new Error(`Config.authority (${cfg.authority.toBase58()}) != signer (${admin.publicKey.toBase58()}). Wrong keypair.`);
  }

  console.log('Sending expand_config_v2...');
  const sig = await (program.methods as any)
    .expandConfigV2()
    .accounts({
      authority: admin.publicKey,
      config: configPda,
    })
    .rpc({ commitment: 'confirmed' });

  const after = await conn.getAccountInfo(configPda);
  console.log('Tx:              ', sig);
  console.log('New size:        ', after?.data.length, 'bytes');
  console.log('Solscan:         ', `https://solscan.io/tx/${sig}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
