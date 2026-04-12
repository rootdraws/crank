import { subscribe, CommitmentLevel } from 'helius-laserstream';
import dotenv from 'dotenv';
dotenv.config({ path: 'bot/.env' });

const url = new URL(process.env.GRPC_ENDPOINT);
const apiKey = url.searchParams.get('api-key');

const config = {
  apiKey,
  endpoint: `${url.protocol}//${url.host}`,
};

console.log('endpoint:', config.endpoint);
console.log('apiKey:', apiKey.slice(0, 8) + '...');

// Subscribe to SOL/USDC pool (high traffic, guaranteed updates)
const SOL_USDC = 'HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR';
const CRANK_SOL = '9R9gcCqPazHZt217aqh3fYDNBGnqENcupWYd97LYiUDp';

const request = {
  accounts: {
    "sol-usdc": { account: [SOL_USDC] },
    "crank-sol": { account: [CRANK_SOL] },
  },
  commitment: CommitmentLevel.CONFIRMED,
  transactions: {},
  slots: {},
  transactionsStatus: {},
  blocks: {},
  blocksMeta: {},
  entry: {},
  accountsDataSlice: [],
};

console.log('subscribing to SOL/USDC + CRANK/SOL...');

let count = 0;
const stream = await subscribe(
  config,
  request,
  async (update) => {
    if (update.account) {
      count++;
      const data = Buffer.from(update.account.account.data);
      if (data.length >= 80) {
        const activeId = data.readInt32LE(76);
        console.log(`update #${count}: activeId=${activeId} (${data.length} bytes) slot=${update.account.slot}`);
      } else {
        console.log(`update #${count}: ${data.length} bytes slot=${update.account.slot}`);
      }
      if (count >= 5) {
        console.log('got 5 updates, done');
        stream.cancel();
        process.exit(0);
      }
    }
  },
  async (err) => {
    console.error('stream error:', err);
  }
);

console.log(`subscribed (id: ${stream.id}), waiting 15s...`);

setTimeout(() => {
  console.log('total updates:', count);
  stream.cancel();
  process.exit(0);
}, 15000);
