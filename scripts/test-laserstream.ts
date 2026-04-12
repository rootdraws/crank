/**
 * test-laserstream.ts
 *
 * Diagnostic: tests which subscription filter variant delivers
 * Meteora DLMM LbPair account updates via helius-laserstream.
 *
 * Usage: npx tsx scripts/test-laserstream.ts [A|B|C]
 *   A = one named filter per pool (current bot approach)
 *   B = single named filter, multiple addresses
 *   C = owner filter on Meteora DLMM program
 *
 * Trigger a trade on the pool while this runs. Messages received are logged.
 */

import { subscribe, CommitmentLevel } from 'helius-laserstream';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PublicKey } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../bot/.env') });

const POOL = '9R9gcCqPazHZt217aqh3fYDNBGnqENcupWYd97LYiUDp';
const METEORA_DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

const variant = (process.argv[2] || 'A').toUpperCase();

async function main() {
  const endpointRaw = process.env.GRPC_ENDPOINT;
  if (!endpointRaw) throw new Error('GRPC_ENDPOINT missing from bot/.env');
  const url = new URL(endpointRaw);
  const apiKey = url.searchParams.get('api-key')
    || url.searchParams.get('x-token')
    || process.env.GRPC_TOKEN
    || '';
  const endpoint = `${url.protocol}//${url.host}${url.pathname}`;

  if (!apiKey) throw new Error('API key missing from GRPC_ENDPOINT or GRPC_TOKEN');

  let request: any;
  switch (variant) {
    case 'A':
      request = {
        accounts: {
          [`lb_${POOL}`]: { account: [POOL] },
        },
        commitment: CommitmentLevel.CONFIRMED,
      };
      break;
    case 'B':
      request = {
        accounts: {
          pools: { account: [POOL] },
        },
        commitment: CommitmentLevel.CONFIRMED,
      };
      break;
    case 'C':
      request = {
        accounts: {
          meteora: { owner: [METEORA_DLMM] },
        },
        commitment: CommitmentLevel.CONFIRMED,
      };
      break;
    case 'D':
      // Combined: LbPair specific-account + bin-farm owner (what the bot does)
      request = {
        accounts: {
          [`lb_${POOL}`]: { account: [POOL] },
          positions: { owner: ['8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia'] },
        },
        commitment: CommitmentLevel.CONFIRMED,
      };
      break;
    default:
      throw new Error(`Unknown variant: ${variant}`);
  }

  console.log(`\n=== Variant ${variant} ===`);
  console.log('Endpoint:', endpoint);
  console.log('Subscription request:', JSON.stringify(request, null, 2));
  console.log('\nListening for 90 seconds. Trigger a trade now...\n');

  const start = Date.now();
  let msgCount = 0;
  let lbPairCount = 0;

  await subscribe(
    { apiKey, endpoint },
    request,
    (msg: any) => {
      msgCount++;
      const info = msg.account?.account;
      if (!info?.pubkey) {
        console.log(`[${msgCount}] (non-account message, keys=${Object.keys(msg).join(',')})`);
        return;
      }
      const pubkey = new PublicKey(info.pubkey).toBase58();
      const isLbPair = pubkey === POOL;
      if (isLbPair) {
        lbPairCount++;
        const activeId = info.data?.length >= 80 ? Buffer.from(info.data).readInt32LE(76) : '?';
        console.log(`[${msgCount}] LBPAIR ${pubkey.slice(0, 12)}... activeId=${activeId} (+${(Date.now() - start) / 1000}s)`);
      } else {
        console.log(`[${msgCount}] other ${pubkey.slice(0, 12)}... len=${info.data?.length ?? 0}`);
      }
    },
    (err: any) => {
      console.error('[error]', err.message || err);
    },
  );

  setTimeout(() => {
    console.log(`\n=== Variant ${variant} done ===`);
    console.log(`Total messages: ${msgCount}`);
    console.log(`LbPair updates: ${lbPairCount}`);
    process.exit(0);
  }, 90_000);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
