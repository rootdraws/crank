import { Connection, PublicKey } from '@solana/web3.js';
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
(async () => {
  for (const pk of process.argv.slice(2)) {
    const i = await conn.getAccountInfo(new PublicKey(pk));
    if (!i) { console.log(pk, 'missing'); continue; }
    console.log(pk, 'len:', i.data.length, 'byte0:', i.data[0]);
  }
})();
