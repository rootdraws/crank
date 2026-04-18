/**
 * apply-emergency-close.ts — Execute pending emergency close after timelock.
 * Usage: npx tsx scripts/apply-emergency-close.ts
 */
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as fs from 'fs';
import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);
dotenv.config({ path: path.join(__dirname2, '../bot/.env') });

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

async function main() {
  const conn = new Connection(process.env.RPC_URL!, 'confirmed');
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('/root/.keys/bot-keypair.json', 'utf8'))));
  const provider = new AnchorProvider(conn, new Wallet(kp), {});
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname2, '../bot/idl/bin_farm.json'), 'utf8'));
  const program = new Program(idl, provider);
  const CORE_ID = program.programId;

  // Read config to get pending emergency close
  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], CORE_ID);
  const config = await program.account.config.fetch(configPDA);
  const pendingKey = (config as any).pendingEmergencyClose as PublicKey;
  const closeAt = (config as any).emergencyCloseAt as number;

  if (!pendingKey || pendingKey.equals(PublicKey.default)) {
    console.log('No pending emergency close.');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  console.log('Pending position:', pendingKey.toBase58().slice(0, 8));
  console.log('Executable at:', new Date(closeAt * 1000).toISOString());
  console.log('Now:', new Date(now * 1000).toISOString());

  if (now < closeAt) {
    console.log(`Timelock not expired yet. ${Math.ceil((closeAt - now) / 60)} minutes remaining.`);
    return;
  }

  // Fetch position data
  const position = await program.account.position.fetch(pendingKey);
  const data = position as any;
  const meteoraPosKey = data.meteoraPosition as PublicKey;
  // Post-PDA-vault migration: tokens flow back to the UserVault PDA, not a raw wallet.
  const userVault = data.userVault as PublicKey;

  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), meteoraPosKey.toBuffer()], CORE_ID);

  // Read token mints from the pool
  const poolInfo = await conn.getAccountInfo(data.lbPair);
  if (!poolInfo) { console.error('Pool not found'); return; }
  const tokenXMint = new PublicKey(poolInfo.data.slice(88, 120));
  const tokenYMint = new PublicKey(poolInfo.data.slice(120, 152));

  // Determine token programs
  const tokenXInfo = await conn.getAccountInfo(tokenXMint);
  const tokenYInfo = await conn.getAccountInfo(tokenYMint);
  const tokenXProgram = tokenXInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const tokenYProgram = tokenYInfo?.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const vaultTokenX = getAssociatedTokenAddressSync(tokenXMint, vaultPda, true, tokenXProgram);
  const vaultTokenY = getAssociatedTokenAddressSync(tokenYMint, vaultPda, true, tokenYProgram);
  const ownerTokenX = getAssociatedTokenAddressSync(tokenXMint, userVault, true, tokenXProgram);
  const ownerTokenY = getAssociatedTokenAddressSync(tokenYMint, userVault, true, tokenYProgram);

  // Ensure UserVault ATAs exist (bot pays rent; vault PDA owns the ATA).
  const createAtaIxs = [
    createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ownerTokenX, userVault, tokenXMint, tokenXProgram),
    createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ownerTokenY, userVault, tokenYMint, tokenYProgram),
  ];

  console.log('Executing emergency close...');
  const sig = await program.methods
    .applyEmergencyClose()
    .accounts({
      caller: kp.publicKey,
      config: configPDA,
      position: pendingKey,
      vault: vaultPda,
      owner: userVault,
      vaultTokenX,
      vaultTokenY,
      ownerTokenX,
      ownerTokenY,
      tokenXMint,
      tokenYMint,
      tokenXProgram,
      tokenYProgram,
      memoProgram: MEMO_PROGRAM_ID,
      systemProgram: new PublicKey('11111111111111111111111111111111'),
    })
    .preInstructions(createAtaIxs)
    .signers([kp])
    .rpc();

  console.log(`✓ Emergency close executed: https://solscan.io/tx/${sig}`);
}

main().catch(e => { console.error('Failed:', e.message?.slice(0, 300)); process.exit(1); });
