/**
 * close-rover.ts — Force close a rover position by PDA prefix.
 * Usage: npx tsx scripts/close-rover.ts <pda_prefix>
 */
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import * as fs from 'fs';
import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from '../bot/retry';
import { getDLMM, buildMeteoraCPIAccounts, SPL_MEMO_PROGRAM_ID } from '../bot/meteora-accounts';
import { buildPriorityFeeIxs } from '../packages/core-sdk/transactions';

const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);
dotenv.config({ path: path.join(__dirname2, '../bot/.env') });

async function main() {
  const prefix = process.argv[2];
  if (!prefix) { console.error('Usage: npx tsx scripts/close-rover.ts <pda_prefix>'); process.exit(1); }

  const conn = new Connection(process.env.RPC_URL!, 'confirmed');
  const botKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('/root/.keys/bot-keypair.json', 'utf8'))));
  const provider = new AnchorProvider(conn, new Wallet(botKp), {});
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname2, '../bot/idl/bin_farm.json'), 'utf8'));
  const program = new Program(idl, provider);
  const CORE_ID = program.programId;

  const positions = await program.account.position.all();
  const target = positions.find(p => p.publicKey.toBase58().startsWith(prefix));
  if (!target) { console.error(`No position found matching "${prefix}"`); process.exit(1); }

  const data = target.account as any;
  console.log('PDA:', target.publicKey.toBase58().slice(0, 8));
  console.log('Pool:', (data.lbPair as PublicKey).toBase58().slice(0, 8));
  console.log('Owner:', (data.owner as PublicKey).toBase58().slice(0, 8));
  console.log('Side:', data.side.buy ? 'Buy' : 'Sell');
  console.log('Bins:', data.minBinId, 'to', data.maxBinId);

  const meteoraPosKey = data.meteoraPosition as PublicKey;
  const lbPair = data.lbPair as PublicKey;
  const owner = data.owner as PublicKey;

  const dlmm = await getDLMM(conn, lbPair);
  await dlmm.refetchStates();

  const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('config')], CORE_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), meteoraPosKey.toBuffer()], CORE_ID);
  const [roverAuthority] = PublicKey.findProgramAddressSync([Buffer.from('rover_authority')], CORE_ID);

  // The Meteora position is owned by the vault PDA, not the rover_authority directly
  let meteoraPos: any;
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(vaultPda);
  meteoraPos = userPositions.find((p: any) => p.publicKey.equals(meteoraPosKey));
  if (!meteoraPos) {
    const { userPositions: ownerPositions } = await dlmm.getPositionsByUserAndLbPair(owner);
    meteoraPos = ownerPositions.find((p: any) => p.publicKey.equals(meteoraPosKey));
    if (!meteoraPos) { console.error('Meteora position not found via vault or owner'); process.exit(1); }
  }

  const binData = meteoraPos.positionData.positionBinData;
  console.log('Bin data length:', binData.length);
  let hasBalance = false;
  for (const b of binData) {
    if (BigInt(b.positionXAmount) > 0n || BigInt(b.positionYAmount) > 0n) {
      console.log(`  bin ${b.binId}: X=${b.positionXAmount} Y=${b.positionYAmount}`);
      hasBalance = true;
    }
  }
  if (!hasBalance) console.log('  All bins empty');

  const allBinIds = binData.map((b: any) => b.binId);
  const meteora = buildMeteoraCPIAccounts(dlmm, meteoraPos, allBinIds);

  const vaultTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, vaultPda, true, meteora.tokenXProgram);
  const vaultTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, vaultPda, true, meteora.tokenYProgram);
  const ownerTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, owner, true, meteora.tokenXProgram);
  const ownerTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, owner, true, meteora.tokenYProgram);
  const roverFeeTokenX = getAssociatedTokenAddressSync(meteora.tokenXMint, roverAuthority, true, meteora.tokenXProgram);
  const roverFeeTokenY = getAssociatedTokenAddressSync(meteora.tokenYMint, roverAuthority, true, meteora.tokenYProgram);

  // Ensure ATAs exist
  const createAtaIxs = [
    createAssociatedTokenAccountIdempotentInstruction(botKp.publicKey, ownerTokenX, owner, meteora.tokenXMint, meteora.tokenXProgram),
    createAssociatedTokenAccountIdempotentInstruction(botKp.publicKey, ownerTokenY, owner, meteora.tokenYMint, meteora.tokenYProgram),
    createAssociatedTokenAccountIdempotentInstruction(botKp.publicKey, roverFeeTokenX, roverAuthority, meteora.tokenXMint, meteora.tokenXProgram),
    createAssociatedTokenAccountIdempotentInstruction(botKp.publicKey, roverFeeTokenY, roverAuthority, meteora.tokenYMint, meteora.tokenYProgram),
  ];

  const priorityIxs = await buildPriorityFeeIxs(conn);

  console.log('\nClosing position...');
  const sig = await withRetry(
    () => program.methods
      .closePosition()
      .accounts({
        bot: botKp.publicKey,
        config: configPDA,
        position: target.publicKey,
        vault: vaultPda,
        owner,
        meteoraPosition: meteoraPosKey,
        lbPair: meteora.lbPair,
        binArrayBitmapExt: meteora.binArrayBitmapExt,
        binArrayLower: meteora.binArrayLower,
        binArrayUpper: meteora.binArrayUpper,
        reserveX: meteora.reserveX,
        reserveY: meteora.reserveY,
        tokenXMint: meteora.tokenXMint,
        tokenYMint: meteora.tokenYMint,
        eventAuthority: meteora.eventAuthority,
        dlmmProgram: meteora.dlmmProgram,
        vaultTokenX,
        vaultTokenY,
        ownerTokenX,
        ownerTokenY,
        roverAuthority,
        roverFeeTokenX,
        roverFeeTokenY,
        tokenXProgram: meteora.tokenXProgram,
        tokenYProgram: meteora.tokenYProgram,
        memoProgram: SPL_MEMO_PROGRAM_ID,
        systemProgram: new PublicKey('11111111111111111111111111111111'),
      })
      .preInstructions([...priorityIxs, ...createAtaIxs])
      .signers([botKp])
      .rpc(),
    'close rover'
  );

  console.log(`✓ Closed: https://solscan.io/tx/${sig}`);
}
main().catch(e => { console.error(e.message?.slice(0, 300)); process.exit(1); });
