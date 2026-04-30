// One-shot Hopper init. Sets all three destinations to admin wallet as
// placeholders; admin can update_routing later when real W-Buy / Treasury /
// W-Sell wallets exist.

import { Connection, Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import pkg from '@coral-xyz/anchor';
const { AnchorProvider, Program, Wallet, BN } = pkg;
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: 'bot/.env' });

const HOPPER_ID = new PublicKey('2HqbBkZvEKQkLZ3hjFDCb4voogrMhdDMTAHZbKx8mtDF');
const ADMIN_PATH = process.env.HOME + '/.config/solana/id.json';

const conn = new Connection(process.env.RPC_URL, 'confirmed');
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ADMIN_PATH, 'utf8'))));
const wallet = new Wallet(admin);
const provider = new AnchorProvider(conn, wallet, { commitment: 'confirmed' });

const idl = JSON.parse(readFileSync('bot/idl/hopper.json', 'utf8'));
const program = new Program(idl, provider);

const [routingConfig] = PublicKey.findProgramAddressSync([Buffer.from('routing_config')], HOPPER_ID);
const [hopperVault]   = PublicKey.findProgramAddressSync([Buffer.from('hopper_vault')],   HOPPER_ID);

console.log('Admin:           ', admin.publicKey.toBase58());
console.log('RoutingConfig:   ', routingConfig.toBase58());
console.log('HopperVault:     ', hopperVault.toBase58());

const ADMIN_PK = admin.publicKey;
// All three destinations = admin wallet for now. update_routing later.
const W_BUY    = ADMIN_PK;
const TREASURY = ADMIN_PK;
const PERSONAL = ADMIN_PK;
const SOL_SPLIT_BPS = [4000, 4000, 2000]; // 40/40/20 per pivot.md
const SOL_THRESHOLD_LAMPORTS = new BN(100_000_000); // 0.1 SOL minimum to sweep
const CRANKER_TIP_BPS = 0;

const sig = await program.methods
  .initialize(W_BUY, TREASURY, PERSONAL, SOL_SPLIT_BPS, SOL_THRESHOLD_LAMPORTS, CRANKER_TIP_BPS)
  .accounts({
    admin: admin.publicKey,
    routingConfig,
    hopperVault,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log('Initialized:    ', sig);
console.log('All dests = admin wallet (placeholder). Call update_routing to set real W-Buy/Treasury/W-Sell.');
