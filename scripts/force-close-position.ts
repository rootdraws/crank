/**
 * force-close-position.ts — Close a specific position with high CU and simulation debug.
 * Usage: npx tsx scripts/force-close-position.ts <wallet_pubkey>
 */
import { Connection, PublicKey, ComputeBudgetProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { address } from '@solana/kit';
import { getUserCloseInstructionAsync } from '../packages/core-sdk/generated/bin-farm/instructions/userClose';
import { getPositionPDA, getVaultPDA, getRoverAuthorityPDA } from '../packages/core-sdk/pda';
import { resolveMeteoraCPIAccounts, deriveATA } from '../packages/core-sdk/meteora';
import { kitIxToWeb3, asSigner } from '../packages/core-sdk/transactions';
import { WalletService } from '../packages/core-sdk/wallet-service';
import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __filename2 = fileURLToPath(import.meta.url);
const __dirname2 = path.dirname(__filename2);
dotenv.config({ path: path.join(__dirname2, '../bot/.env') });

const SPL_MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

async function main() {
  const walletPubkey = process.argv[2];
  if (!walletPubkey) { console.error('Usage: npx tsx scripts/force-close-position.ts <wallet>'); process.exit(1); }

  const conn = new Connection(process.env.RPC_URL!, 'confirmed');
  const ws = new WalletService(path.join(__dirname2, '../data/crankbot.json'), process.env.WALLET_ENCRYPTION_KEY!);
  const userId = ws.getUserIdForOwner(walletPubkey)!;
  const kp = ws.getOrCreate(userId);
  const user = kp.publicKey;

  const positions = ws.getOpenPositions(userId);
  if (positions.length === 0) { console.log('No open positions.'); return; }

  for (const pos of positions) {
    console.log(`\nClosing ${pos.position_pda.slice(0,8)} (${pos.side}, bins ${pos.min_bin_id}..${pos.max_bin_id})...`);
    try {
      const cpi = await resolveMeteoraCPIAccounts(conn, pos.lb_pair, pos.min_bin_id, pos.max_bin_id);
      console.log('  binArrayLower:', cpi.binArrayLower.toBase58().slice(0,8));
      console.log('  binArrayUpper:', cpi.binArrayUpper.toBase58().slice(0,8));

      const met = new PublicKey(pos.meteora_position);
      const [posPDA] = getPositionPDA(met);
      const [vaultPDA] = getVaultPDA(met);
      const [roverAuth] = getRoverAuthorityPDA();
      const vTx = deriveATA(cpi.tokenXMint, vaultPDA, cpi.tokenXProgramId, true);
      const vTy = deriveATA(cpi.tokenYMint, vaultPDA, cpi.tokenYProgramId, true);
      const uTx = deriveATA(cpi.tokenXMint, user, cpi.tokenXProgramId, false);
      const uTy = deriveATA(cpi.tokenYMint, user, cpi.tokenYProgramId, false);
      const rFx = deriveATA(cpi.tokenXMint, roverAuth, cpi.tokenXProgramId, true);
      const rFy = deriveATA(cpi.tokenYMint, roverAuth, cpi.tokenYProgramId, true);

      const closeIx = await getUserCloseInstructionAsync({
        user: asSigner(user), position: address(posPDA.toBase58()), vault: address(vaultPDA.toBase58()),
        meteoraPosition: address(met.toBase58()), lbPair: address(cpi.lbPair.toBase58()),
        binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
        binArrayLower: address(cpi.binArrayLower.toBase58()), binArrayUpper: address(cpi.binArrayUpper.toBase58()),
        reserveX: address(cpi.reserveX.toBase58()), reserveY: address(cpi.reserveY.toBase58()),
        tokenXMint: address(cpi.tokenXMint.toBase58()), tokenYMint: address(cpi.tokenYMint.toBase58()),
        eventAuthority: address(cpi.eventAuthority.toBase58()), dlmmProgram: address(cpi.dlmmProgram.toBase58()),
        vaultTokenX: address(vTx.toBase58()), vaultTokenY: address(vTy.toBase58()),
        userTokenX: address(uTx.toBase58()), userTokenY: address(uTy.toBase58()),
        roverFeeTokenX: address(rFx.toBase58()), roverFeeTokenY: address(rFy.toBase58()),
        tokenXProgram: address(cpi.tokenXProgramId.toBase58()), tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
        memoProgram: address(SPL_MEMO.toBase58()),
      });

      const ix = kitIxToWeb3(closeIx);
      if (!cpi.binArrayBitmapExt.equals(cpi.dlmmProgram)) {
        const i = ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
        if (i >= 0) ix.keys[i].isWritable = true;
      }

      const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
      const feeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 });
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      const msg = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: [cuIx, feeIx, ix] }).compileToV0Message();
      const vtx = new VersionedTransaction(msg);
      vtx.sign([kp]);

      const sim = await conn.simulateTransaction(vtx);
      console.log('  CU used:', sim.value.unitsConsumed);
      if (sim.value.err) {
        console.log('  Error:', JSON.stringify(sim.value.err));
        for (const log of (sim.value.logs ?? [])) console.log('  ', log);
      } else {
        const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: true });
        console.log(`  ✓ Sent: https://solscan.io/tx/${sig}`);
        ws.closePosition(pos.position_pda);
      }
    } catch (e: any) {
      console.error(`  ✗ Failed: ${e.message?.slice(0, 300)}`);
    }
  }
  console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
