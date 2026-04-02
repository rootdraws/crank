/**
 * deposit-detect.ts
 *
 * Auto-detect who deposited SOL to a custody wallet.
 * First external depositor gets locked as the withdraw address (write-once).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { WalletService } from '@crankbot/core-sdk';

/**
 * Returns the withdraw address — existing or newly detected from tx history.
 * Locks the first external SOL sender as the withdraw address (cannot be changed).
 */
export async function tryLockDepositor(
  connection: Connection,
  walletService: WalletService,
  userId: string,
): Promise<string | undefined> {
  const existing = walletService.getWithdrawAddress(userId);
  if (existing) return existing;

  const userPubkey = walletService.getUserPublicKey(userId);
  if (!userPubkey) return undefined;

  try {
    const balance = await connection.getBalance(userPubkey);
    if (balance === 0) return undefined;

    const sigs = await connection.getSignaturesForAddress(userPubkey, { limit: 50 });
    if (sigs.length === 0) return undefined;

    // Oldest first — lock the first external depositor
    const sorted = [...sigs].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

    for (const sig of sorted) {
      if (sig.err) continue;
      const tx = await connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;

      const msg = tx.transaction.message as any;
      const keys: PublicKey[] = msg.staticAccountKeys ?? msg.accountKeys ?? [];
      const custodyAddr = userPubkey.toBase58();

      let custodyIdx = -1;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].toBase58() === custodyAddr) {
          custodyIdx = i;
          break;
        }
      }
      if (custodyIdx === -1) continue;

      const pre = tx.meta.preBalances[custodyIdx];
      const post = tx.meta.postBalances[custodyIdx];

      // Received >0.001 SOL from an external wallet
      if (post > pre && post - pre > 1_000_000) {
        const sender = keys[0].toBase58();
        if (sender !== custodyAddr) {
          walletService.setWithdrawAddress(userId, sender);
          return sender;
        }
      }
    }
  } catch {
    // RPC error — don't block the command
  }

  return undefined;
}
