import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

/**
 * Updates the keeper oracle with a new price from an off-chain source (e.g. Pumpswap).
 *
 * This posts the price as a WrappedI80F48 to the on-chain KeeperOracleState account.
 */
export async function updateKeeperOracle(
  connection: Connection,
  keeper: Keypair,
  programId: PublicKey,
  keeperOracleAccount: PublicKey,
  priceUsd: number,
  confidenceUsd: number
): Promise<string | null> {
  try {
    const priceBn = priceToWrappedI80F48(priceUsd);
    const confBn = priceToWrappedI80F48(confidenceUsd);

    // Build the update_keeper_oracle instruction
    // Discriminator: sha256("global:update_keeper_oracle")[..8]
    const discriminator = Buffer.from(
      anchor.utils.sha256.hash("global:update_keeper_oracle"),
      "hex"
    ).subarray(0, 8);

    const data = Buffer.alloc(8 + 16 + 16);
    discriminator.copy(data, 0);
    priceBn.copy(data, 8);
    confBn.copy(data, 24);

    const ix = {
      programId,
      keys: [
        { pubkey: keeperOracleAccount, isSigner: false, isWritable: true },
        { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    };

    const { blockhash } = await connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: keeper.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.sign([keeper]);

    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
    });

    console.log(`[KeeperOracle] Updated price=$${priceUsd}, conf=$${confidenceUsd}, sig=${sig}`);
    return sig;
  } catch (err) {
    console.error("[KeeperOracle] Failed to update:", err);
    return null;
  }
}

/**
 * Convert a floating-point price to a 16-byte WrappedI80F48 (little-endian i128).
 * I80F48 has 48 fractional bits: value = raw / 2^48
 */
function priceToWrappedI80F48(price: number): Buffer {
  const FRAC_BITS = 48n;
  const scale = 1n << FRAC_BITS;
  const raw = BigInt(Math.round(price * Number(scale)));
  const buf = Buffer.alloc(16);
  let val = raw;
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}
