/**
 * close-all-positions.ts
 * Close all open positions for a given user. Uses bot-signed user_close (vault architecture).
 * Usage: npx tsx scripts/close-all-positions.ts <discord_user_id>
 *
 * Example: npx tsx scripts/close-all-positions.ts discord:123456789
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getConfigPDA, getPositionPDA, getVaultPDA, getRoverAuthorityPDA } from '../packages/core-sdk/pda';
import { resolveMeteoraCPIAccounts, deriveATA } from '../packages/core-sdk/meteora';
import { buildSetupTx, buildPriorityFeeIxs } from '../packages/core-sdk/transactions';
import { signAndSendLegacy } from '../packages/core-sdk/signer';
import { WalletService } from '../packages/core-sdk/wallet-service';
import { BIN_FARM_PROGRAM_ID } from '../packages/core-sdk/constants';
import dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../bot/.env') });

const SPL_MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const RPC_URL = process.env.RPC_URL!;

async function main() {
  const userId = process.argv[2];
  if (!userId) { console.error('Usage: npx tsx scripts/close-all-positions.ts <discord_user_id>'); process.exit(1); }

  const connection = new Connection(RPC_URL, 'confirmed');
  const walletService = new WalletService(path.join(__dirname, '../data/crankbot.json'));

  const botKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.BOT_KEYPAIR_PATH || '/root/.keys/bot-keypair.json', 'utf-8')))
  );
  const [configPDA] = getConfigPDA();

  const vaultPda = walletService.getVaultPda(userId);
  if (!vaultPda) { console.error(`No vault found for user ${userId}`); process.exit(1); }

  console.log(`User: ${userId}\nVault: ${vaultPda.toBase58()}`);

  const positions = walletService.getOpenPositions(userId);
  console.log(`Open positions: ${positions.length}`);
  if (positions.length === 0) { console.log('Nothing to close.'); return; }

  // Set up Anchor program
  const provider = new AnchorProvider(connection, new Wallet(botKeypair), { commitment: 'confirmed' });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, '../bot/idl/bin_farm.json'), 'utf-8'));
  const coreProgram = new Program(idl, provider);

  for (const pos of positions) {
    const shortId = pos.position_pda.slice(0, 8);
    console.log(`\nClosing ${shortId} (${pos.side}, bins ${pos.min_bin_id}..${pos.max_bin_id})...`);
    try {
      const cpi = await resolveMeteoraCPIAccounts(connection, pos.lb_pair, pos.min_bin_id, pos.max_bin_id);
      const meteoraPosition = new PublicKey(pos.meteora_position);
      const [positionPDA] = getPositionPDA(meteoraPosition);
      const [posVaultPDA] = getVaultPDA(meteoraPosition);
      const [roverAuth] = getRoverAuthorityPDA();

      const vaultTokenX = deriveATA(cpi.tokenXMint, posVaultPDA, cpi.tokenXProgramId, true);
      const vaultTokenY = deriveATA(cpi.tokenYMint, posVaultPDA, cpi.tokenYProgramId, true);
      // user_token_x/y = vault PDA's ATAs (tokens go to vault)
      const userTokenX = deriveATA(cpi.tokenXMint, vaultPda, cpi.tokenXProgramId, true);
      const userTokenY = deriveATA(cpi.tokenYMint, vaultPda, cpi.tokenYProgramId, true);
      const roverFeeTokenX = deriveATA(cpi.tokenXMint, roverAuth, cpi.tokenXProgramId, true);
      const roverFeeTokenY = deriveATA(cpi.tokenYMint, roverAuth, cpi.tokenYProgramId, true);

      const setupTx = await buildSetupTx(connection, botKeypair.publicKey, [
        { ata: userTokenX, owner: vaultPda, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
        { ata: userTokenY, owner: vaultPda, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
        { ata: roverFeeTokenX, owner: roverAuth, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
        { ata: roverFeeTokenY, owner: roverAuth, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
      ]);
      if (setupTx) { console.log('  Setup ATAs...'); await signAndSendLegacy(setupTx, botKeypair, connection); }

      const sig = await coreProgram.methods
        .userClose()
        .accounts({
          caller: botKeypair.publicKey,
          config: configPDA,
          userVault: vaultPda,
          position: positionPDA,
          vault: posVaultPDA,
          meteoraPosition,
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
          vaultTokenX,
          vaultTokenY,
          userTokenX,
          userTokenY,
          roverAuthority: roverAuth,
          roverFeeTokenX,
          roverFeeTokenY,
          tokenXProgram: cpi.tokenXProgramId,
          tokenYProgram: cpi.tokenYProgramId,
          memoProgram: SPL_MEMO_PROGRAM_ID,
          systemProgram: new PublicKey('11111111111111111111111111111111'),
        })
        .signers([botKeypair])
        .rpc();

      console.log(`  Done: https://solscan.io/tx/${sig}`);
      walletService.closePosition(pos.position_pda);
    } catch (e: any) {
      console.error(`  Failed: ${e.message?.slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
