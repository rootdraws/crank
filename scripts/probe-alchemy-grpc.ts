/**
 * Throwaway probe — DO NOT COMMIT.
 *
 * Validates the @triton-one/yellowstone-grpc client against Alchemy:
 *   - connect with x-token from GRPC_TOKEN
 *   - subscribe to one busy LbPair (CRANK/SOL) + one busier one (SOL/USDC 1bps)
 *   - confirm at least one account update parses
 *   - confirm Ping → reply works (server drops us if not)
 *
 * Run:
 *   GRPC_ENDPOINT=solana-mainnet.g.alchemy.com:443 \
 *   GRPC_TOKEN=<rotated-key> \
 *   npx tsx scripts/probe-alchemy-grpc.ts
 *
 * Exits after 5 account updates or 60s, whichever first.
 */

import 'dotenv/config';

const POOLS = [
  '9R9gcCqPazHZt217aqh3fYDNBGnqENcupWYd97LYiUDp', // CRANK/SOL
  'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR', // SOL/USDC 1bps
];

async function main() {
  const endpoint = process.env.GRPC_ENDPOINT;
  const token = process.env.GRPC_TOKEN;
  if (!endpoint || !token) {
    console.error('Missing GRPC_ENDPOINT or GRPC_TOKEN');
    process.exit(1);
  }
  console.log(`[probe] connect ${endpoint}, token len ${token.length}`);

  // Dynamic import: tsx fails on static named imports from dual CJS/ESM packages.
  const { default: Client, CommitmentLevel } = await import('@triton-one/yellowstone-grpc');
  const client = new Client(endpoint, token, undefined);
  await client.connect();
  const stream = await client.subscribe();

  let accountUpdates = 0;
  let pingsReceived = 0;
  const t0 = Date.now();

  stream.on('data', (update: any) => {
    if (update.ping) {
      pingsReceived++;
      stream.write({
        accounts: {}, slots: {}, transactions: {}, transactionsStatus: {},
        blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
        ping: { id: 1 },
      });
      console.log(`[probe] ping → pong (count=${pingsReceived})`);
      return;
    }
    if (update.account?.account) {
      accountUpdates++;
      const a = update.account.account;
      const pk = Buffer.from(a.pubkey).toString('hex').slice(0, 16);
      const dlen = a.data?.length ?? 0;
      const slot = update.account.slot;
      const dt = Date.now() - t0;
      console.log(`[probe] account #${accountUpdates} pk=${pk}… len=${dlen} slot=${slot} +${dt}ms`);
      if (accountUpdates >= 5) {
        console.log(`[probe] OK — got 5 updates, ${pingsReceived} pings, exiting`);
        stream.end();
        process.exit(0);
      }
    }
  });

  stream.on('error', (e: any) => { console.error(`[probe] stream error: ${e.message}`); process.exit(2); });
  stream.on('end',   () => { console.log('[probe] stream ended'); process.exit(0); });

  const accounts: Record<string, any> = {};
  for (const p of POOLS) accounts[`pool_${p.slice(0, 8)}`] = { account: [p], owner: [], filters: [] };

  const request = {
    accounts,
    slots: {}, transactions: {}, transactionsStatus: {},
    blocks: {}, blocksMeta: {}, entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
  };

  await new Promise<void>((resolve, reject) =>
    stream.write(request, (err: any) => err ? reject(err) : resolve())
  );
  console.log(`[probe] subscribed to ${POOLS.length} pools — waiting for updates...`);

  setTimeout(() => {
    console.error(`[probe] timeout — got ${accountUpdates} updates, ${pingsReceived} pings in 60s`);
    process.exit(accountUpdates > 0 ? 0 : 3);
  }, 60_000);
}

main().catch(e => { console.error(e); process.exit(1); });
