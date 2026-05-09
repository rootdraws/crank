import { Connection, PublicKey } from '@solana/web3.js';
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const VWR_PUBKEY = process.argv[2];
if (!VWR_PUBKEY) { console.error('usage: tsx scripts/vwr-check.ts <vwr-pubkey>'); process.exit(1); }
(async () => {
  const info = await conn.getAccountInfo(new PublicKey(VWR_PUBKEY));
  if (!info) return console.log('no acct');
  console.log('first 16 bytes:', Array.from(info.data.subarray(0, 16)));
  console.log('expected disc :', [46, 249, 155, 75, 153, 248, 116, 9]);
  console.log('len:', info.data.length, 'owner:', info.owner.toBase58());
})();
