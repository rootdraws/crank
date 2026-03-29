/**
 * core-sdk/signer.ts
 *
 * Custodial transaction signing (keypair-based).
 */

import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { confirmAndCheck } from './transactions';

export async function signAndSend(
  vtx: VersionedTransaction,
  keypair: Keypair,
  connection: Connection,
  blockhash: string,
  lastValidBlockHeight: number
): Promise<string> {
  vtx.sign([keypair]);
  const sig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmAndCheck(connection, sig, blockhash, lastValidBlockHeight);
  return sig;
}

export async function signAndSendLegacy(
  tx: Transaction,
  keypair: Keypair,
  connection: Connection
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmAndCheck(connection, sig, blockhash, lastValidBlockHeight);
  return sig;
}
