/**
 * reclaim-atas.ts — Show empty token accounts for a vault PDA.
 * PDA vault architecture: vault ATAs are program-owned, so closing them
 * requires an on-chain instruction (not a simple signer-based close).
 * This script lists empty ATAs for diagnostic purposes.
 *
 * Usage: npx tsx scripts/reclaim-atas.ts <discord_user_id>
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { WalletService } from '../packages/core-sdk/wallet-service';
import { TOKEN_2022_PROGRAM_ID } from '../packages/core-sdk/constants';
import dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname2, '../bot/.env') });

async function main() {
  const userId = process.argv[2];
  if (!userId) { console.error('Usage: npx tsx scripts/reclaim-atas.ts <discord_user_id>'); process.exit(1); }

  const conn = new Connection(process.env.RPC_URL!, 'confirmed');
  const ws = new WalletService(path.join(__dirname2, '../data/crankbot.json'));

  const vaultPda = ws.getVaultPda(userId);
  if (!vaultPda) { console.error(`No vault found for user ${userId}`); process.exit(1); }

  console.log(`Vault: ${vaultPda.toBase58()}`);

  for (const programId of [TOKEN_PROGRAM_ID, new PublicKey(TOKEN_2022_PROGRAM_ID)]) {
    const accounts = await conn.getParsedTokenAccountsByOwner(vaultPda, { programId });
    for (const { pubkey, account } of accounts.value) {
      const parsed = account.data.parsed.info;
      const balance = parseFloat(parsed.tokenAmount.uiAmount || '0');
      const mint = parsed.mint;
      const status = balance === 0 ? 'EMPTY (reclaimable)' : `${balance}`;
      console.log(`  ${pubkey.toBase58().slice(0,8)}  mint=${mint.slice(0,8)}  balance=${status}`);
    }
  }
  console.log('\nNOTE: Vault ATAs are program-owned. Reclaiming requires a close_vault_ata on-chain instruction (future).');
}
main().catch(e => { console.error(e); process.exit(1); });
