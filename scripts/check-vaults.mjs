import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const conn = new Connection(rpc, 'confirmed');

const MERKLE_DIST = new PublicKey('DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV');
const BANK_DIST   = new PublicKey('9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M');
const EPOCH_VAULT = new PublicKey('7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const BANK = new PublicKey('BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA');

const [solDistPda]  = PublicKey.findProgramAddressSync([Buffer.from('distributor')],  MERKLE_DIST);
const [bankDistPda] = PublicKey.findProgramAddressSync([Buffer.from('distributor')],  BANK_DIST);
const [bridgeVault] = PublicKey.findProgramAddressSync([Buffer.from('bridge_vault')], EPOCH_VAULT);

const solDistWsolAta = getAssociatedTokenAddressSync(WSOL, solDistPda, true);
const bankDistAta    = getAssociatedTokenAddressSync(BANK, bankDistPda, true);

const parseAmt = (info, off=64) => info && info.data.length >= off+8 ? Number(info.data.readBigUInt64LE(off)) : 0;

const [bvSol, sdSol, bdSol, sdWsol, bdBank] = await Promise.all([
  conn.getBalance(bridgeVault),
  conn.getBalance(solDistPda),
  conn.getBalance(bankDistPda),
  conn.getAccountInfo(solDistWsolAta),
  conn.getAccountInfo(bankDistAta),
]);

const fmt = (lamports) => `${(lamports/1e9).toFixed(6)} SOL`;
const fmtTok = (raw, dec=6) => `${(raw/Math.pow(10,dec)).toFixed(dec)}`;

console.log('=== Drain candidates ===');
console.log(`epoch-vault bridge_vault     (${bridgeVault.toBase58()})`);
console.log(`  native SOL: ${fmt(bvSol)}`);
console.log(``);
console.log(`merkle-distributor PDA       (${solDistPda.toBase58()})`);
console.log(`  PDA rent SOL: ${fmt(sdSol)}`);
console.log(`  WSOL ATA: ${solDistWsolAta.toBase58()}`);
console.log(`  WSOL: ${parseAmt(sdWsol) ? fmt(parseAmt(sdWsol)) : 'empty / not initialized'}`);
console.log(``);
console.log(`bank-distributor PDA         (${bankDistPda.toBase58()})`);
console.log(`  PDA rent SOL: ${fmt(bdSol)}`);
console.log(`  BANK ATA: ${bankDistAta.toBase58()}`);
console.log(`  BANK: ${parseAmt(bdBank) ? fmtTok(parseAmt(bdBank)) : 'empty / not initialized'}`);
