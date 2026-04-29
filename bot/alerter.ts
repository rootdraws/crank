/**
 * alerter.ts
 *
 * Two destinations:
 *   - Feed channel (public): user-facing events.
 *   - Ops channel (private): bot health alerts — gRPC, balance, keeper failures,
 *     process death. If the ops channel isn't configured the notifier silently
 *     drops the alert (logs still go to pm2).
 *
 * Rate-limited + deduped per key — won't spam.
 */

import { logger } from './logger';

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min between duplicate alerts

const lastSent = new Map<string, number>();

let feedFn: ((text: string) => Promise<void>) | null = null;
let opsFn: ((text: string) => Promise<void>) | null = null;

export interface AlerterTargets {
  postToFeed: (text: string) => Promise<void>;
  postToOps?: (text: string) => Promise<void>;
}

export function initAlerter(targets: AlerterTargets): void {
  feedFn = targets.postToFeed;
  opsFn = targets.postToOps ?? null;
  logger.info(
    opsFn
      ? '[alerter] Alerts wired to feed + ops channels'
      : '[alerter] Alerts wired to feed channel (no ops channel configured)'
  );
}

async function dispatch(
  target: 'feed' | 'ops',
  key: string,
  message: string
): Promise<void> {
  const fn = target === 'feed' ? feedFn : opsFn;
  if (!fn) return;

  const now = Date.now();
  const last = lastSent.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return;
  lastSent.set(key, now);

  try {
    await fn(message);
  } catch (e: any) {
    logger.warn(`[alerter] Failed to send ${target} alert: ${e.message}`);
  }
}

// ─── Ops channel (private) ────────────────────────────────────────────────

export async function alertGrpcDisconnect(): Promise<void> {
  await dispatch('ops', 'grpc_disconnect', '**ALERT:** gRPC disconnected. Harvester is blind until reconnect.');
}

export async function alertGrpcReconnect(): Promise<void> {
  await dispatch('ops', 'grpc_reconnect', 'gRPC reconnected.');
}

export async function alertLowBalance(solBalance: number): Promise<void> {
  await dispatch('ops', 'low_balance', `**ALERT:** Bot wallet low — ${solBalance.toFixed(4)} SOL remaining.`);
}

export async function alertKeeperFailure(step: string, error: string): Promise<void> {
  await dispatch('ops', `keeper_${step}`, `**ALERT:** Keeper \`${step}\` failed: ${error.slice(0, 200)}`);
}

export async function alertProcessDeath(reason: string): Promise<void> {
  await dispatch('ops', 'process_death', `**CRITICAL:** Bot process dying — ${reason.slice(0, 200)}. Check PM2 logs.`);
}

