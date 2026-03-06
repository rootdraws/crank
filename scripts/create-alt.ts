import {
  Connection, Keypair, PublicKey,
  AddressLookupTableProgram, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../bot/.env", import.meta.url).pathname });

const rpc = process.env.HELIUS_RPC_URL ?? process.env.RPC_URL;
if (!rpc) throw new Error("Set HELIUS_RPC_URL or RPC_URL in bot/.env");
const keypairPath = process.env.BOT_KEYPAIR_PATH;
if (!keypairPath) throw new Error("Set BOT_KEYPAIR_PATH in bot/.env");

const conn = new Connection(rpc, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));

const STATIC_ACCOUNTS = [
  new PublicKey("MeTGCG86PTWhnN52yV9ie8oJkgfSLGyuRCFxhDd97i2"),  // config PDA
  new PublicKey("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y"),  // lbPair (SOL/USDC)
  new PublicKey("BzQsUBAbd21nrNDgc7D55EwnABC16uZJ41mgxxqYydHJ"),  // binArrayBitmapExt
  new PublicKey("DwZz4S1Z1LBXomzmncQRVKCYhjCqSAMQ6RPKbUAadr7H"),  // reserveX
  new PublicKey("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6"),  // eventAuthority
  new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),  // dlmmProgram
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),   // tokenProgram
  new PublicKey("So11111111111111111111111111111111111111112"),     // SOL mint
  new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC mint
  new PublicKey("11111111111111111111111111111111"),                // system program
  new PublicKey("82YTu9oKBfNy7V6eWVNwa43zhJedDXF8wm8dSqsFCcrr"),  // binArray (common)
];

async function main() {
  console.log("Payer:", payer.publicKey.toBase58());
  const balance = await conn.getBalance(payer.publicKey);
  console.log("Balance:", balance / 1e9, "SOL");

  const slot = await conn.getSlot();

  // Step 1: Create the ALT
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot - 1,
  });

  console.log("Creating ALT:", altAddress.toBase58());

  const { blockhash: bh1 } = await conn.getLatestBlockhash();
  const createMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: bh1,
    instructions: [createIx],
  }).compileToV0Message();

  const createTx = new VersionedTransaction(createMsg);
  createTx.sign([payer]);
  const createSig = await conn.sendRawTransaction(createTx.serialize());
  await conn.confirmTransaction(createSig, "confirmed");
  console.log("ALT created:", createSig);

  // Step 2: Extend with static accounts
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: altAddress,
    addresses: STATIC_ACCOUNTS,
  });

  const { blockhash: bh2 } = await conn.getLatestBlockhash();
  const extendMsg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: bh2,
    instructions: [extendIx],
  }).compileToV0Message();

  const extendTx = new VersionedTransaction(extendMsg);
  extendTx.sign([payer]);
  const extendSig = await conn.sendRawTransaction(extendTx.serialize());
  await conn.confirmTransaction(extendSig, "confirmed");
  console.log("ALT extended:", extendSig);

  // Verify
  const altAccount = await conn.getAddressLookupTable(altAddress);
  console.log("\nALT address (add to config.json as POOL_ALT):");
  console.log(altAddress.toBase58());
  console.log("\nStored addresses:", altAccount.value?.state.addresses.length);
  altAccount.value?.state.addresses.forEach((addr, i) => {
    console.log(`  [${i}] ${addr.toBase58()}`);
  });
}

main().catch(console.error);
