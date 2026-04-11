/**
 * tools/protocol-lp/deployer.ts
 *
 * Buy-side re-entry: open new 70-bin BidAsk positions below active price.
 */

import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { Keypair, sendAndConfirmTransaction } = _require('@solana/web3.js');
const BN = _require('bn.js');

import { CONFIG } from './config';
import { addDeployment, setPosition } from './state';
import type { PoolState } from './harvester';

async function postDiscord(solAmount: number, binCount: number, txSig: string): Promise<void> {
  if (!CONFIG.discordWebhookUrl) return;
  try {
    await fetch(CONFIG.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `**Protocol LP Redeployed** — ${solAmount.toFixed(2)} SOL deployed as buy support ${binCount} bins below current price.\n\nThank you for your support! Your SOL has contributed toward a deeper floor ${binCount} bins lower than your entry.\n\n[tx](https://solscan.io/tx/${txSig})`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.warn('[discord] Webhook post failed');
  }
}

export async function deployBuyPosition(
  connection: any,
  pool: PoolState,
  solLamports: number,
): Promise<string | null> {
  // Refresh to get latest activeId
  await pool.dlmm.refetchStates();
  const activeId = pool.dlmm.lbPair.activeId;

  const minBinId = activeId - CONFIG.reentryBinCount;
  const maxBinId = activeId - 1;

  console.log(`[deploy] Buy position: ${(solLamports / 1e9).toFixed(2)} SOL across bins ${minBinId}-${maxBinId} (${CONFIG.reentryStrategyName})`);
  console.log(`[deploy] Active bin: ${activeId}, range: ${CONFIG.reentryBinCount} bins below`);

  if (CONFIG.dryRun) {
    console.log(`[DRY_RUN] Would deploy ${(solLamports / 1e9).toFixed(2)} SOL as buy position`);
    return null;
  }

  const positionKeypair = Keypair.generate();

  const tx = await pool.dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount: new BN(0),
    totalYAmount: new BN(solLamports),
    strategy: {
      minBinId,
      maxBinId,
      strategyType: CONFIG.reentryStrategy,
    },
    user: CONFIG.wallet.publicKey,
    slippage: 50,
  });

  const sig = await sendAndConfirmTransaction(
    connection,
    tx,
    [CONFIG.wallet, positionKeypair],
    { commitment: 'confirmed' },
  );

  const pubkey = positionKeypair.publicKey.toBase58();

  await setPosition(pubkey, {
    pubkey,
    side: 'buy',
    minBinId,
    maxBinId,
    status: 'active',
    deployedLamports: solLamports,
    createdAt: Date.now(),
  });

  await addDeployment({
    timestamp: Date.now(),
    positionPubkey: pubkey,
    amountLamports: solLamports,
    minBinId,
    maxBinId,
    activeIdAtDeploy: activeId,
    txSig: sig,
  });

  console.log(`[deploy] Success: ${sig}`);
  console.log(`[deploy] New position: ${pubkey}`);

  await postDiscord(solLamports / 1e9, CONFIG.reentryBinCount, sig);

  return sig;
}
