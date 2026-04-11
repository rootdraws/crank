/**
 * recycle-fee-rover.ts
 *
 * Opens a fee rover position from accumulated token fees in rover_authority ATAs.
 * Recycles Token X fees into a BidAskImBalanced DLMM position (sell-side above price)
 * so they convert to SOL via natural trading instead of market dumping.
 *
 * Usage: npx tsx scripts/recycle-fee-rover.ts [pool_address]
 *        Default pool: ABdAmqgz3CNvU9kjn5fAtnFurvBvgs6PP7ksTb3VfzQM
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  Connection,
  PublicKey,
  Keypair,
  ComputeBudgetProgram,
  Transaction,
} from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

dotenv.config({ path: path.join(__dirname, '..', 'bot', '.env') });

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
const CORE = new PublicKey(process.env.CORE_PROGRAM_ID!);

const DEFAULT_LB_PAIR = 'ABdAmqgz3CNvU9kjn5fAtnFurvBvgs6PP7ksTb3VfzQM';

// LbPair byte offsets (verified against geyser-subscriber.ts)
const OFFSET_ACTIVE_ID = 76;
const OFFSET_BIN_STEP = 80;
const OFFSET_TOKEN_X_MINT = 88;
const OFFSET_TOKEN_Y_MINT = 120;
const OFFSET_RESERVE_X = 152;
const OFFSET_RESERVE_Y = 184;
const OFFSET_TOKEN_X_PROG_FLAG = 880;
const OFFSET_TOKEN_Y_PROG_FLAG = 881;

const keypairJson = JSON.parse(readFileSync(process.env.BOT_KEYPAIR_PATH!, 'utf-8'));
const botKeypair = Keypair.fromSecretKey(Uint8Array.from(keypairJson));
const connection = new Connection(process.env.RPC_URL!, 'confirmed');
const provider = new AnchorProvider(connection, new Wallet(botKeypair), { commitment: 'confirmed' });
const idl = JSON.parse(readFileSync(path.join(__dirname, '..', 'bot', 'idl', 'bin_farm.json'), 'utf-8'));
const program = new Program(idl, provider);

async function main() {
  const lbPairArg = process.argv[2] || DEFAULT_LB_PAIR;
  const lbPairKey = new PublicKey(lbPairArg);

  console.log('=== Recycle Fee Rover ===\n');

  // 1. Read LbPair raw bytes
  const lbPairInfo = await connection.getAccountInfo(lbPairKey);
  if (!lbPairInfo) throw new Error('LbPair not found');
  const lbData = lbPairInfo.data;

  const activeId = lbData.readInt32LE(OFFSET_ACTIVE_ID);
  const binStep = lbData.readUInt16LE(OFFSET_BIN_STEP);
  const tokenXMint = new PublicKey(lbData.slice(OFFSET_TOKEN_X_MINT, OFFSET_TOKEN_X_MINT + 32));
  const tokenYMint = new PublicKey(lbData.slice(OFFSET_TOKEN_Y_MINT, OFFSET_TOKEN_Y_MINT + 32));
  const reserveX = new PublicKey(lbData.slice(OFFSET_RESERVE_X, OFFSET_RESERVE_X + 32));
  const reserveY = new PublicKey(lbData.slice(OFFSET_RESERVE_Y, OFFSET_RESERVE_Y + 32));
  const tokenXProgFlag = lbData.readUInt8(OFFSET_TOKEN_X_PROG_FLAG);
  const tokenYProgFlag = lbData.readUInt8(OFFSET_TOKEN_Y_PROG_FLAG);
  const tokenXProg = tokenXProgFlag === 1 ? TOKEN_2022 : TOKEN_PROGRAM_ID;
  const tokenYProg = tokenYProgFlag === 1 ? TOKEN_2022 : TOKEN_PROGRAM_ID;

  console.log('Pool:', lbPairKey.toBase58());
  console.log('ActiveId:', activeId, '| BinStep:', binStep);
  console.log('TokenX mint:', tokenXMint.toBase58(), tokenXProgFlag === 1 ? '(Token-2022)' : '(SPL Token)');
  console.log('TokenY mint:', tokenYMint.toBase58(), tokenYProgFlag === 1 ? '(Token-2022)' : '(SPL Token)');

  // 2. PDAs
  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], CORE);
  const [roverAuth] = PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], CORE);
  const [eventAuth] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], DLMM_PROGRAM);

  // Bitmap extension — use DLMM program ID as placeholder if not found
  const [bitmapExtPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('bitmap'), lbPairKey.toBuffer()],
    DLMM_PROGRAM
  );
  const bitmapExtInfo = await connection.getAccountInfo(bitmapExtPDA);
  const bitmapExt = bitmapExtInfo ? bitmapExtPDA : DLMM_PROGRAM;

  // 3. Check rover_authority ATA balance for Token X
  const roverTokenX = getAssociatedTokenAddressSync(tokenXMint, roverAuth, true, tokenXProg);
  const roverTokenXInfo = await connection.getAccountInfo(roverTokenX);
  if (!roverTokenXInfo) {
    console.log('\nRover authority has no ATA for Token X — nothing to recycle.');
    return;
  }
  // Parse balance from raw token account data (offset 64, u64 LE)
  const balance = roverTokenXInfo.data.readBigUInt64LE(64);
  console.log(`\nRover fee balance (Token X): ${balance} raw units`);
  if (balance === 0n) {
    console.log('Balance is zero — nothing to recycle.');
    return;
  }

  // 4. Compute bin range (same formula as on-chain)
  const width = Math.min(70, Math.max(1, Math.floor(6931 / binStep)));
  const minBinId = activeId + 1;
  const maxBinId = minBinId + width - 1;
  console.log(`Bin range: [${minBinId}, ${maxBinId}] (${width} bins)`);

  // 5. Derive bin array PDAs
  const deriveBinArray = (idx: number) => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(idx), 0);
    return PublicKey.findProgramAddressSync(
      [Buffer.from('bin_array'), lbPairKey.toBuffer(), buf],
      DLMM_PROGRAM
    )[0];
  };
  const binIds = Array.from({ length: width }, (_, i) => minBinId + i);
  const arrayIndices = [...new Set(binIds.map(id => Math.floor(id / 70)))].sort((a, b) => a - b);
  const binArrayLower = deriveBinArray(arrayIndices[0] ?? 0);
  const binArrayUpper = deriveBinArray(arrayIndices[arrayIndices.length - 1] ?? 0);

  // 6. Generate new Meteora position keypair
  const meteoraPosition = Keypair.generate();

  // 7. Derive position + vault PDAs
  const [positionPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), meteoraPosition.publicKey.toBuffer()],
    CORE
  );
  const [vaultPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), meteoraPosition.publicKey.toBuffer()],
    CORE
  );

  // 8. Vault ATAs
  const vaultTokenX = getAssociatedTokenAddressSync(tokenXMint, vaultPDA, true, tokenXProg);
  const vaultTokenY = getAssociatedTokenAddressSync(tokenYMint, vaultPDA, true, tokenYProg);

  console.log('\n--- Accounts ---');
  console.log('Rover ATA (source):', roverTokenX.toBase58());
  console.log('Meteora position:', meteoraPosition.publicKey.toBase58());
  console.log('Position PDA:', positionPDA.toBase58());
  console.log('Vault PDA:', vaultPDA.toBase58());

  // 9. Build pre-instructions: create vault ATAs + compute budget
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(botKeypair.publicKey, vaultTokenX, vaultPDA, tokenXMint, tokenXProg),
    createAssociatedTokenAccountIdempotentInstruction(botKeypair.publicKey, vaultTokenY, vaultPDA, tokenYMint, tokenYProg),
  ];

  // 10. Send open_fee_rover
  console.log(`\n[SEND] open_fee_rover — amount=${balance}, binStep=${binStep}`);
  try {
    const ix = await program.methods
      .openFeeRover(new BN(balance.toString()), binStep)
      .accounts({
        bot: botKeypair.publicKey,
        config: configPDA,
        roverAuthority: roverAuth,
        lbPair: lbPairKey,
        meteoraPosition: meteoraPosition.publicKey,
        binArrayBitmapExt: bitmapExt,
        reserveX,
        reserveY,
        binArrayLower,
        binArrayUpper,
        position: positionPDA,
        vault: vaultPDA,
        roverTokenAccount: roverTokenX,
        vaultTokenX,
        vaultTokenY,
        tokenXMint,
        tokenYMint,
        tokenXProgram: tokenXProg,
        tokenYProgram: tokenYProg,
        systemProgram: new PublicKey('11111111111111111111111111111111'),
      })
      .remainingAccounts([
        { pubkey: eventAuth, isWritable: false, isSigner: false },
        { pubkey: DLMM_PROGRAM, isWritable: false, isSigner: false },
      ])
      .instruction();

    // Fix bitmap extension writable flag for Meteora CPI
    if (!bitmapExt.equals(DLMM_PROGRAM)) {
      for (const key of ix.keys) {
        if (key.pubkey.equals(bitmapExt)) key.isWritable = true;
      }
    }

    const tx = new Transaction();
    tx.add(...preIxs, ix);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = botKeypair.publicKey;
    tx.sign(botKeypair, meteoraPosition);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

    console.log('\n=== SUCCESS ===');
    console.log('Signature:', sig);
    console.log(`Fee rover opened: ${balance} Token X → ${width} bins [${minBinId},${maxBinId}]`);
    console.log('As price rises through these bins, tokens convert to SOL → sweep_rover → 40/40/20 split → $PEGGED → Merkle claims.');
  } catch (err: any) {
    console.error('\n=== FAILED ===');
    console.error('Error:', err.message);
    if (err.logs) {
      console.error('\nProgram Logs:');
      for (const log of err.logs) console.error(' ', log);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
