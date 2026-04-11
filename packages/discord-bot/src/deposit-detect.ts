/**
 * deposit-detect.ts
 *
 * PDA vault architecture: withdraw address is the vault owner (baked into PDA seed).
 * No deposit detection needed for address locking — it's immutable at creation.
 *
 * This module now just returns the owner wallet for compatibility with callers
 * that used to call tryLockDepositor().
 */

import { Connection } from '@solana/web3.js';
import { WalletService } from '@crankbot/core-sdk';

/**
 * Returns the withdraw address (= owner wallet). Always available after registration.
 * No RPC calls needed — PDA seed enforcement replaces deposit-based locking.
 */
export async function tryLockDepositor(
  _connection: Connection,
  walletService: WalletService,
  userId: string,
): Promise<string | undefined> {
  return walletService.getWithdrawAddress(userId);
}
