/**
 * core-sdk/signer.ts
 *
 * Bot-only transaction signing. No user keypairs.
 * The bot keypair signs all transactions as the authorized operator.
 */

import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { confirmAndCheck } from './transactions';

/**
 * Sign a versioned transaction with the bot keypair and send.
 * Optionally accepts additional signers (e.g. newly generated keypairs).
 */
export async function signAndSend(
  vtx: VersionedTransaction,
  keypair: Keypair,
  connection: Connection,
  blockhash: string,
  lastValidBlockHeight: number,
  extraSigners?: Keypair[]
): Promise<string> {
  const signers = [keypair, ...(extraSigners ?? [])];
  vtx.sign(signers);
  const sig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmAndCheck(connection, sig, blockhash, lastValidBlockHeight);
  return sig;
}

/**
 * Sign a legacy transaction with the bot keypair and send.
 * Fee payer is always the bot keypair.
 */
export async function signAndSendLegacy(
  tx: Transaction,
  keypair: Keypair,
  connection: Connection,
  extraSigners?: Keypair[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = keypair.publicKey;

  const signers = [keypair, ...(extraSigners ?? [])];
  tx.sign(...signers);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmAndCheck(connection, sig, blockhash, lastValidBlockHeight);
  return sig;
}
