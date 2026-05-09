// One-shot Hopper v2 (4-way) init.
//
// HANDOFF step 6. Run AFTER `solana program deploy` of hopper v2 against the
// hopper program ID (or a fresh keypair-rotated ID — see HANDOFF step 5).
//
// Init order vs realm bootstrap:
//   The 4-way layout wants `dest_treasury = NativeTreasuryPDA`, but NTP doesn't
//   exist until bootstrap-realm.ts (HANDOFF step 9). This script initializes
//   `dest_treasury` to the admin pubkey as a placeholder when DEST_TREASURY
//   isn't passed, so hopper can be live + funds-receiving immediately. After
//   bootstrap-realm.ts produces NTP, retarget via:
//     DEST_TREASURY=<NTP> node scripts/update-routing.mjs        # not yet written
//   or manually via Anchor.
//
// USAGE
//   node scripts/init-hopper.mjs
//
//   Override any default via env:
//     DEST_TREASURY  base58 (default = admin pubkey)
//     DEST_ADMIN     base58 (default = HW: DPr9NDewhqDMY58fpAZSBqjTfDYm9N8NKjP2o2RZLU9A)
//     DEST_OPS       base58 (default = bin-farm Config.bot)
//     DEST_TAX       base58 (default = 77QfJ6GLuFGWd9fYYUVcrjS5RH7aNgJjwDnZWuxcwtj4)
//     SOL_SPLIT_BPS  csv 4 ints (default = "2500,2500,2500,2500")
//     SOL_THRESHOLD  lamports (default = 100000000 = 0.1 SOL)
//     CRANKER_TIP    bps (default = 0)

import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import pkg from '@coral-xyz/anchor';
const { AnchorProvider, Program, Wallet, BN } = pkg;
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: 'bot/.env' });

const HOPPER_ID    = new PublicKey('2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF');
const BIN_FARM_ID  = new PublicKey('8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia');
const HW_DEFAULT   = 'DPr9NDewhqDMY58fpAZSBqjTfDYm9N8NKjP2o2RZLU9A';
const TAX_DEFAULT  = '77QfJ6GLuFGWd9fYYUVcrjS5RH7aNgJjwDnZWuxcwtj4';
const ADMIN_PATH   = process.env.ADMIN_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`;

if (!process.env.RPC_URL) throw new Error('missing env RPC_URL');

const conn = new Connection(process.env.RPC_URL, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ADMIN_PATH, 'utf8'))));
const provider = new AnchorProvider(conn, new Wallet(admin), { commitment: 'confirmed' });

// Hopper v2 IDL (target/, not bot/, since bot/idl is still v1).
const hopperIdl = JSON.parse(readFileSync('target/idl/hopper.json', 'utf8'));
const hopper = new Program(hopperIdl, provider);

const binFarmIdl = JSON.parse(readFileSync('target/idl/bin_farm.json', 'utf8'));
const binFarm = new Program(binFarmIdl, provider);

const [routingConfig] = PublicKey.findProgramAddressSync([Buffer.from('routing_config')], HOPPER_ID);
const [hopperVault]   = PublicKey.findProgramAddressSync([Buffer.from('hopper_vault')],   HOPPER_ID);
const [binFarmConfig] = PublicKey.findProgramAddressSync([Buffer.from('config')],          BIN_FARM_ID);

// Resolve OPS = bin-farm Config.bot (so settles route exec fees → ops dest = the bot).
const cfg = await binFarm.account.config.fetch(binFarmConfig);
const BOT_PK = cfg.bot;

const DEST_TREASURY = new PublicKey(process.env.DEST_TREASURY ?? admin.publicKey.toBase58());
const DEST_ADMIN    = new PublicKey(process.env.DEST_ADMIN    ?? HW_DEFAULT);
const DEST_OPS      = new PublicKey(process.env.DEST_OPS      ?? BOT_PK.toBase58());
const DEST_TAX      = new PublicKey(process.env.DEST_TAX      ?? TAX_DEFAULT);

const SOL_SPLIT_BPS = (process.env.SOL_SPLIT_BPS ?? '2500,2500,2500,2500').split(',').map((s) => Number(s.trim()));
if (SOL_SPLIT_BPS.length !== 4 || SOL_SPLIT_BPS.reduce((a, b) => a + b, 0) !== 10000) {
  throw new Error(`SOL_SPLIT_BPS must be 4 ints summing to 10000 (got ${SOL_SPLIT_BPS.join(',')})`);
}

const SOL_THRESHOLD = new BN(process.env.SOL_THRESHOLD ?? '100000000');
const CRANKER_TIP   = Number(process.env.CRANKER_TIP ?? 0);

console.log('Admin:           ', admin.publicKey.toBase58());
console.log('Hopper program:  ', HOPPER_ID.toBase58());
console.log('RoutingConfig:   ', routingConfig.toBase58());
console.log('HopperVault:     ', hopperVault.toBase58());
console.log('Destinations:');
console.log('  treasury (NTP after bootstrap):', DEST_TREASURY.toBase58(), DEST_TREASURY.equals(admin.publicKey) ? '  ← placeholder, retarget after bootstrap-realm.ts' : '');
console.log('  admin (HW):                    ', DEST_ADMIN.toBase58());
console.log('  ops (bin-farm Config.bot):     ', DEST_OPS.toBase58());
console.log('  tax (TAX_RESERVE):             ', DEST_TAX.toBase58());
console.log('Splits:           ', SOL_SPLIT_BPS.join('/'), 'bps');
console.log('Threshold:        ', SOL_THRESHOLD.toString(), 'lamports');
console.log('Cranker tip:      ', CRANKER_TIP, 'bps');

// Idempotency: if RoutingConfig already exists, bail.
const existing = await conn.getAccountInfo(routingConfig);
if (existing) {
  throw new Error(`RoutingConfig ${routingConfig.toBase58()} already exists (${existing.data.length} bytes). To retarget, use update_routing — not initialize.`);
}

const sig = await hopper.methods
  .initialize(
    DEST_TREASURY, DEST_ADMIN, DEST_OPS, DEST_TAX,
    SOL_SPLIT_BPS,
    SOL_THRESHOLD,
    CRANKER_TIP,
  )
  .accounts({
    admin: admin.publicKey,
    routingConfig,
    hopperVault,
    systemProgram: SystemProgram.programId,
  })
  .rpc({ commitment: 'confirmed' });

console.log('Initialized:    ', sig);
console.log('Solscan:        ', `https://solscan.io/tx/${sig}`);
console.log('');
if (DEST_TREASURY.equals(admin.publicKey)) {
  console.log('NEXT: after bootstrap-realm.ts produces the Native Treasury PDA, retarget dest_treasury via update_routing.');
}
