/**
 * alerter.ts
 *
 * Bot health alerts posted to the Discord feed channel via the notifier.
 * Rate-limited + deduped — won't spam.
 */

import { logger } from './logger';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min between duplicate alerts
const lastSent = new Map<string, number>();

let postFn: ((text: string) => Promise<void>) | null = null;

export function initAlerter(postToFeed: (text: string) => Promise<void>): void {
  postFn = postToFeed;
  logger.info('[alerter] Alerts wired to feed channel');
}

async function send(key: string, message: string): Promise<void> {
  if (!postFn) return;

  const now = Date.now();
  const last = lastSent.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;
  lastSent.set(key, now);

  try {
    await postFn(message);
  } catch (e: any) {
    logger.warn(`[alerter] Failed to send alert: ${e.message}`);
  }
}

export async function alertGrpcDisconnect(): Promise<void> {
  await send('grpc_disconnect', '**ALERT:** gRPC disconnected. Harvester is blind until reconnect.');
}

export async function alertGrpcReconnect(): Promise<void> {
  await send('grpc_reconnect', 'gRPC reconnected.');
}

export async function alertLowBalance(solBalance: number): Promise<void> {
  await send('low_balance', `**ALERT:** Bot wallet low — ${solBalance.toFixed(4)} SOL remaining.`);
}

export async function alertKeeperFailure(step: string, error: string): Promise<void> {
  await send(`keeper_${step}`, `**ALERT:** Keeper \`${step}\` failed: ${error.slice(0, 200)}`);
}

export async function alertSyncFailure(pool: string, error: string): Promise<void> {
  await send(`sync_failure_${pool}`, `**ALERT:** Price sync failed on \`${pool}\`: ${error.slice(0, 200)}`);
}

export async function alertLargeDivergence(pool: string, divergencePct: number): Promise<void> {
  await send(`large_divergence_${pool}`, `**ALERT:** Large price divergence on \`${pool}\`: ${divergencePct.toFixed(2)}% — sync may be needed.`);
}
