/**
 * force-close-position.ts — Close a specific user's positions with high CU and simulation debug.
 * Uses bot-signed user_close (vault architecture).
 * Usage: npx tsx scripts/force-close-position.ts <discord_user_id>
 */
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getConfigPDA, getPositionPDA, getVaultPDA } from '../packages/core-sdk/pda';
import { resolveMeteoraCPIAccounts, deriveATA } from '../packages/core-sdk/meteora';
import { WalletService } from '../packages/core-sdk/wallet-service';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);
dotenv.config({ path: path.join(__dirname2, '../bot/.env') });

const SPL_MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

async function main() {
  const userId = process.argv[2];
  if (!userId) { console.error('Usage: npx tsx scripts/force-close-position.ts <discord_user_id>'); process.exit(1); }

  const conn = new Connection(process.env.RPC_URL!, 'confirmed');
  const ws = new WalletService(path.join(__dirname2, '../data/crankbot.json'));

  const botKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.BOT_KEYPAIR_PATH || '/root/.keys/bot-keypair.json', 'utf-8')))
  );
  const [configPDA] = getConfigPDA();

  const vaultPda = ws.getVaultPda(userId);
  if (!vaultPda) { console.error(`No vault found for user ${userId}`); process.exit(1); }

  const positions = ws.getOpenPositions(userId);
  if (positions.length === 0) { console.log('No open positions.'); return; }

  const provider = new AnchorProvider(conn, new Wallet(botKeypair), { commitment: 'confirmed' });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname2, '../bot/idl/bin_farm.json'), 'utf-8'));
  const coreProgram = new Program(idl, provider);

  for (const pos of positions) {
    console.log(`\nClosing ${pos.position_pda.slice(0,8)} (${pos.side}, bins ${pos.min_bin_id}..${pos.max_bin_id})...`);
    try {
      const cpi = await resolveMeteoraCPIAccounts(conn, pos.lb_pair, pos.min_bin_id, pos.max_bin_id);
      console.log('  binArrayLower:', cpi.binArrayLower.toBase58().slice(0,8));
      console.log('  binArrayUpper:', cpi.binArrayUpper.toBase58().slice(0,8));

      const met = new PublicKey(pos.meteora_position);
      const [posPDA] = getPositionPDA(met);
      const [posVaultPDA] = getVaultPDA(met);
      // Post-cleanup: fee_dest = bot keypair (Config.fee_dest falls back to Config.bot when default)
      const feeDest = botKeypair.publicKey;
      const vTx = deriveATA(cpi.tokenXMint, posVaultPDA, cpi.tokenXProgramId, true);
      const vTy = deriveATA(cpi.tokenYMint, posVaultPDA, cpi.tokenYProgramId, true);
      const uTx = deriveATA(cpi.tokenXMint, vaultPda, cpi.tokenXProgramId, true);
      const uTy = deriveATA(cpi.tokenYMint, vaultPda, cpi.tokenYProgramId, true);
      const feeDestTokenX = deriveATA(cpi.tokenXMint, feeDest, cpi.tokenXProgramId, true);
      const feeDestTokenY = deriveATA(cpi.tokenYMint, feeDest, cpi.tokenYProgramId, true);

      // Build user_close instruction via Anchor methods (bot as caller)
      const ix = await coreProgram.methods
        .userClose()
        .accounts({
          caller: botKeypair.publicKey,
          config: configPDA,
          userVault: vaultPda,
          position: posPDA,
          vault: posVaultPDA,
          meteoraPosition: met,
          lbPair: cpi.lbPair,
          binArrayBitmapExt: cpi.binArrayBitmapExt,
          binArrayLower: cpi.binArrayLower,
          binArrayUpper: cpi.binArrayUpper,
          reserveX: cpi.reserveX,
          reserveY: cpi.reserveY,
          tokenXMint: cpi.tokenXMint,
          tokenYMint: cpi.tokenYMint,
          eventAuthority: cpi.eventAuthority,
          dlmmProgram: cpi.dlmmProgram,
          vaultTokenX: vTx,
          vaultTokenY: vTy,
          userTokenX: uTx,
          userTokenY: uTy,
          feeDest,
          feeDestTokenX,
          feeDestTokenY,
          tokenXProgram: cpi.tokenXProgramId,
          tokenYProgram: cpi.tokenYProgramId,
          memoProgram: SPL_MEMO,
          systemProgram: new PublicKey('11111111111111111111111111111111'),
        })
        .instruction();

      // Fix bitmap extension writable flag for Meteora CPI (before simulation)
      const DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
      if (!cpi.binArrayBitmapExt.equals(DLMM_PROGRAM)) {
        for (const key of ix.keys) {
          if (key.pubkey.equals(cpi.binArrayBitmapExt)) key.isWritable = true;
        }
      }

      const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
      const feeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 });
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      const msg = new TransactionMessage({
        payerKey: botKeypair.publicKey, recentBlockhash: blockhash, instructions: [cuIx, feeIx, ix]
      }).compileToV0Message();
      const vtx = new VersionedTransaction(msg);
      vtx.sign([botKeypair]);

      const sim = await conn.simulateTransaction(vtx);
      console.log('  CU used:', sim.value.unitsConsumed);
      if (sim.value.err) {
        console.log('  Error:', JSON.stringify(sim.value.err));
        for (const log of (sim.value.logs ?? [])) console.log('  ', log);
      } else {
        const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
        console.log(`  Done: https://solscan.io/tx/${sig}`);
        ws.closePosition(pos.position_pda);
      }
    } catch (e: any) {
      console.error(`  Failed: ${e.message?.slice(0, 300)}`);
    }
  }
  console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
