// Admin tx: bin-farm.set_fee_dest(hopperVaultPDA).
// Redirects all harvest_bins protocol fees into the Hopper program.

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import pkg from '@coral-xyz/anchor';
const { } = pkg;
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: 'bot/.env' });

const BIN_FARM = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
const HOPPER_ID = new PublicKey('2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF');

const conn = new Connection(process.env.RPC_URL, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.HOME + '/.config/solana/id.json', 'utf8'))));
const provider = new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' });

const idl = JSON.parse(readFileSync('bot/idl/bin_farm.json', 'utf8'));
const program = new Program(idl, provider);

const [configPDA]       = PublicKey.findProgramAddressSync([Buffer.from('config')],        BIN_FARM);
const [hopperVaultPDA]  = PublicKey.findProgramAddressSync([Buffer.from('hopper_vault')],  HOPPER_ID);

console.log('Admin:        ', admin.publicKey.toBase58());
console.log('Config:       ', configPDA.toBase58());
console.log('HopperVault:  ', hopperVaultPDA.toBase58());

// Confirm current fee_dest before flipping
const cfg = await program.account.config.fetch(configPDA);
const DEFAULT = new PublicKey('11111111111111111111111111111111');
const current = cfg.feeDest && !cfg.feeDest.equals(DEFAULT) ? cfg.feeDest.toBase58() : `(default → fallback to bot ${cfg.bot.toBase58()})`;
console.log('Current fee_dest:', current);

const sig = await program.methods
  .setFeeDest(hopperVaultPDA)
  .accounts({
    authority: admin.publicKey,
    config: configPDA,
  })
  .rpc();

console.log('Set:          ', sig);
console.log('New fee_dest:  hopperVaultPDA =', hopperVaultPDA.toBase58());
