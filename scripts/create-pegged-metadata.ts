import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) throw new Error("Set BOT_KEYPAIR_PATH in bot/.env");

const conn = new Connection(rpc, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

const SANCTUM_PROGRAM = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
const STAKE_POOL = new PublicKey("9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg");
const PEGGED_MINT = new PublicKey("GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1");
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const [withdrawAuthority] = PublicKey.findProgramAddressSync(
  [STAKE_POOL.toBuffer(), Buffer.from("withdraw")],
  SANCTUM_PROGRAM,
);

const [metadataPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), PEGGED_MINT.toBuffer()],
  METADATA_PROGRAM,
);

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf-8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function buildCreateTokenMetadataIx(
  name: string,
  symbol: string,
  uri: string,
): TransactionInstruction {
  // SPL Stake Pool CreateTokenMetadata = variant 17
  const data = Buffer.concat([
    Buffer.from([17]),
    borshString(name),
    borshString(symbol),
    borshString(uri),
  ]);

  return new TransactionInstruction({
    programId: SANCTUM_PROGRAM,
    keys: [
      { pubkey: STAKE_POOL,        isSigner: false, isWritable: false },
      { pubkey: kp.publicKey,      isSigner: true,  isWritable: false }, // manager
      { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: PEGGED_MINT,       isSigner: false, isWritable: false },
      { pubkey: kp.publicKey,      isSigner: true,  isWritable: true  }, // payer
      { pubkey: metadataPDA,       isSigner: false, isWritable: true  },
      { pubkey: METADATA_PROGRAM,  isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function main() {
  console.log("=== Create $PEGGED (crankSOL) Token Metadata ===\n");
  console.log("Manager:            ", kp.publicKey.toBase58());
  console.log("Stake pool:         ", STAKE_POOL.toBase58());
  console.log("Withdraw authority: ", withdrawAuthority.toBase58());
  console.log("Pool mint ($PEGGED):", PEGGED_MINT.toBase58());
  console.log("Metadata PDA:       ", metadataPDA.toBase58());
  console.log();

  const existing = await conn.getAccountInfo(metadataPDA);
  if (existing) {
    console.log("Metadata account already exists! Use UpdateTokenMetadata (variant 18) instead.");
    process.exit(1);
  }

  const NAME = "crankSOL";
  const SYMBOL = "PEGGED";
  const URI = "";

  console.log(`Setting: name="${NAME}", symbol="${SYMBOL}", uri="${URI || "(empty)"}"`);

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx.add(buildCreateTokenMetadataIx(NAME, SYMBOL, URI));

  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
  console.log("\nToken metadata created! TX:", sig);
  console.log("Verify: https://solscan.io/account/" + PEGGED_MINT.toBase58());
}

main().catch(e => { console.error(e); process.exit(1); });
