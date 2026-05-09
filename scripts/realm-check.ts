import { Connection, PublicKey } from '@solana/web3.js';
const SPL_GOV = new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw');
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const realm = new PublicKey(process.argv[2]);
(async () => {
  const realmInfo = await conn.getAccountInfo(realm);
  console.log('realm bytes 0-1:', Array.from(realmInfo!.data.subarray(0, 2)), '(16 = RealmV2)');
  // realm_config PDA: ["realm-config", realm]
  const [rc] = PublicKey.findProgramAddressSync(
    [Buffer.from('realm-config'), realm.toBuffer()],
    SPL_GOV,
  );
  console.log('realm_config:', rc.toBase58());
  const rcInfo = await conn.getAccountInfo(rc);
  if (!rcInfo) { console.log('realm_config: NOT FOUND'); return; }
  console.log('realm_config len:', rcInfo.data.length);
  console.log('realm_config bytes 0:', rcInfo.data[0], '(11 = RealmConfig)');
  // RealmConfig layout: account_type(1) + realm(32) + community_voter_weight_addin: Option<Pubkey>(1+32) + ...
  console.log('realm_config bytes 33 (community_voter_weight_addin Option tag):', rcInfo.data[33]);
  if (rcInfo.data[33] === 1) {
    console.log('community_voter_weight_addin =', new PublicKey(rcInfo.data.subarray(34, 66)).toBase58());
  }
})();
