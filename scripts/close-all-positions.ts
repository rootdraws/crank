/**
 * close-all-positions.ts
 * Close all open positions for a given wallet. Uses user_close (owner-signed).
 * Usage: npx tsx scripts/close-all-positions.ts <wallet_pubkey>
 */
import { Connection, PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { address } from '@solana/kit';
import { getUserCloseInstructionAsync } from '../packages/core-sdk/generated/bin-farm/instructions/userClose';
import { getConfigPDA, getPositionPDA, getVaultPDA, getRoverAuthorityPDA } from '../packages/core-sdk/pda';
import { resolveMeteoraCPIAccounts, deriveATA } from '../packages/core-sdk/meteora';
import { buildSetupTx, buildPriorityFeeIxs, kitIxToWeb3, asSigner } from '../packages/core-sdk/transactions';
import { signAndSend, signAndSendLegacy } from '../packages/core-sdk/signer';
import { WalletService } from '../packages/core-sdk/wallet-service';
import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../bot/.env') });

const SPL_MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RPC_URL = process.env.RPC_URL!;
const ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY!;

async function main() {
  const walletPubkey = process.argv[2];
  if (!walletPubkey) { console.error('Usage: npx tsx scripts/close-all-positions.ts <wallet_pubkey>'); process.exit(1); }

  const connection = new Connection(RPC_URL, 'confirmed');
  const walletService = new WalletService(path.join(__dirname, '../data/crankbot.json'), ENCRYPTION_KEY);

  const userId = walletService.getUserIdForOwner(walletPubkey);
  if (!userId) { console.error(`No user found for wallet ${walletPubkey}`); process.exit(1); }

  const keypair = walletService.getOrCreate(userId);
  const user = keypair.publicKey;
  console.log(`User: ${userId}\nWallet: ${user.toBase58()}`);

  const positions = walletService.getOpenPositions(userId);
  console.log(`Open positions: ${positions.length}`);
  if (positions.length === 0) { console.log('Nothing to close.'); return; }

  for (const pos of positions) {
    const shortId = pos.position_pda.slice(0, 8);
    console.log(`\nClosing ${shortId} (${pos.side}, bins ${pos.min_bin_id}..${pos.max_bin_id})...`);
    try {
      const cpi = await resolveMeteoraCPIAccounts(connection, pos.lb_pair, pos.min_bin_id, pos.max_bin_id);
      const meteoraPosition = new PublicKey(pos.meteora_position);
      const [positionPDA] = getPositionPDA(meteoraPosition);
      const [vaultPDA] = getVaultPDA(meteoraPosition);
      const [roverAuth] = getRoverAuthorityPDA();

      const vaultTokenX = deriveATA(cpi.tokenXMint, vaultPDA, cpi.tokenXProgramId, true);
      const vaultTokenY = deriveATA(cpi.tokenYMint, vaultPDA, cpi.tokenYProgramId, true);
      const userTokenX = deriveATA(cpi.tokenXMint, user, cpi.tokenXProgramId, false);
      const userTokenY = deriveATA(cpi.tokenYMint, user, cpi.tokenYProgramId, false);
      const roverFeeTokenX = deriveATA(cpi.tokenXMint, roverAuth, cpi.tokenXProgramId, true);
      const roverFeeTokenY = deriveATA(cpi.tokenYMint, roverAuth, cpi.tokenYProgramId, true);

      const setupTx = await buildSetupTx(connection, user, [
        { ata: userTokenX, owner: user, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
        { ata: userTokenY, owner: user, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
        { ata: roverFeeTokenX, owner: roverAuth, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
        { ata: roverFeeTokenY, owner: roverAuth, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
      ]);
      if (setupTx) { console.log('  Setup ATAs...'); await signAndSendLegacy(setupTx, keypair, connection); }

      const closeIx = await getUserCloseInstructionAsync({
        user: asSigner(user),
        position: address(positionPDA.toBase58()),
        vault: address(vaultPDA.toBase58()),
        meteoraPosition: address(meteoraPosition.toBase58()),
        lbPair: address(cpi.lbPair.toBase58()),
        binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
        binArrayLower: address(cpi.binArrayLower.toBase58()),
        binArrayUpper: address(cpi.binArrayUpper.toBase58()),
        reserveX: address(cpi.reserveX.toBase58()),
        reserveY: address(cpi.reserveY.toBase58()),
        tokenXMint: address(cpi.tokenXMint.toBase58()),
        tokenYMint: address(cpi.tokenYMint.toBase58()),
        eventAuthority: address(cpi.eventAuthority.toBase58()),
        dlmmProgram: address(cpi.dlmmProgram.toBase58()),
        vaultTokenX: address(vaultTokenX.toBase58()),
        vaultTokenY: address(vaultTokenY.toBase58()),
        userTokenX: address(userTokenX.toBase58()),
        userTokenY: address(userTokenY.toBase58()),
        roverFeeTokenX: address(roverFeeTokenX.toBase58()),
        roverFeeTokenY: address(roverFeeTokenY.toBase58()),
        tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
        tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
        memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
      });

      const closeWeb3Ix = kitIxToWeb3(closeIx);
      if (!cpi.binArrayBitmapExt.equals(cpi.dlmmProgram)) {
        const bmIdx = closeWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
        if (bmIdx >= 0) closeWeb3Ix.keys[bmIdx].isWritable = true;
      }

      const priorityIxs = await buildPriorityFeeIxs(connection);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const msg = new TransactionMessage({
        payerKey: user, recentBlockhash: blockhash,
        instructions: [...priorityIxs, closeWeb3Ix],
      }).compileToV0Message();
      const vtx = new VersionedTransaction(msg);
      const sig = await signAndSend(vtx, keypair, connection, blockhash, lastValidBlockHeight);
      console.log(`  ✓ Closed: https://solscan.io/tx/${sig}`);
      walletService.closePosition(pos.position_pda);
    } catch (e: any) {
      console.error(`  ✗ Failed: ${e.message?.slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
