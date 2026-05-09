import { Connection, PublicKey } from '@solana/web3.js';

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const SPL_GOV = new PublicKey('GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw');

async function main() {
  // Filter: byte 0 == 13 (ProposalTransactionV2). base58 of single byte 0x0D = 'E'.
  const accs = await conn.getProgramAccounts(SPL_GOV, {
    filters: [{ memcmp: { offset: 0, bytes: 'E' } }],
  });
  console.log('PT-V2 candidates:', accs.length);
  if (accs.length === 0) return;

  // Pick a meaty one
  let chosen = accs[0];
  for (const a of accs) {
    const d = a.account.data as Buffer;
    if (d.length > 200) { chosen = a; break; }
  }
  const d = chosen.account.data as Buffer;
  console.log('chosen:', chosen.pubkey.toBase58(), 'len', d.length);

  console.log('  byte0:', d[0]);
  const proposal = new PublicKey(d.subarray(1, 33)).toBase58();
  console.log('  proposal:', proposal);
  console.log('  option_index:', d[33]);
  console.log('  transaction_index:', d.readUInt16LE(34));
  console.log('  hold_up_time:', d.readUInt32LE(36));
  const ixCount = d.readUInt32LE(40);
  console.log('  ix_count:', ixCount);

  let cur = 44;
  for (let i = 0; i < ixCount && cur < d.length; i++) {
    const pid = new PublicKey(d.subarray(cur, cur + 32)).toBase58();
    cur += 32;
    const acctCount = d.readUInt32LE(cur);
    cur += 4;
    cur += acctCount * 34;
    const dataLen = d.readUInt32LE(cur);
    cur += 4;
    const ixData = d.subarray(cur, cur + dataLen);
    cur += dataLen;
    console.log(`  ix[${i}] program=${pid} accounts=${acctCount} data_len=${dataLen} disc=${ixData.subarray(0, Math.min(8, dataLen)).toString('hex')}`);
  }
  console.log('  remaining bytes after ixs:', d.length - cur);

  const propInfo = await conn.getAccountInfo(new PublicKey(proposal));
  if (!propInfo) { console.log('proposal not found'); return; }
  const pd = propInfo.data as Buffer;
  console.log('---');
  console.log('Proposal len:', pd.length, 'byte0:', pd[0], '(expect 14)');
  if (pd[0] !== 14) { console.log('UNEXPECTED account_type for Proposal'); return; }
  console.log('  governance:', new PublicKey(pd.subarray(1, 33)).toBase58());
  console.log('  governing_token_mint:', new PublicKey(pd.subarray(33, 65)).toBase58());
  console.log('  state:', pd[65]);
  console.log('  token_owner_record:', new PublicKey(pd.subarray(66, 98)).toBase58());
  console.log('  signatories_count:', pd[98]);
  console.log('  signed_off_count:', pd[99]);
  const vt = pd[100];
  console.log('  vote_type:', vt, vt === 0 ? '(SingleChoice)' : '(MultiChoice)');
  let optStart = vt === 1 ? 105 : 101;
  const optCount = pd.readUInt32LE(optStart);
  console.log('  options.len:', optCount);
  optStart += 4;
  for (let i = 0; i < optCount; i++) {
    const labelLen = pd.readUInt32LE(optStart);
    optStart += 4 + labelLen;
    optStart += 8;
    optStart += 1;
    optStart += 2;
    const txCount = pd.readUInt16LE(optStart);
    optStart += 2;
    optStart += 2;
    console.log(`  options[${i}] transactions_count = ${txCount}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
