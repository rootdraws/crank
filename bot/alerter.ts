/**
 * alerter.ts
 *
 * Two destinations:
 *   - Feed channel (public): user-facing events like epoch success
 *   - Ops channel (private): bot health alerts — gRPC, balance, keeper failures,
 *     divergence, process death, epoch miss. If the ops channel isn't configured
 *     the notifier silently drops the alert (logs still go to pm2).
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

export async function alertEpochMiss(
  tree: 'SOL' | 'BANK',
  hoursSince: number,
  eligible: string,
): Promise<void> {
  const age = Number.isFinite(hoursSince) ? `${hoursSince.toFixed(1)}h` : 'ever';
  await dispatch(
    'ops',
    `epoch_miss_${tree.toLowerCase()}`,
    `**ALERT:** ${tree} epoch overdue — ${eligible} eligible sitting undistributed (last epoch ${age} ago).`,
  );
}

/**
 * Fires when pre-publish reconciliation finds a wallet's local cumulative
 * entitlement below its on-chain `claim_status.cumulative_claimed`. Indicates
 * a wallet-DB rollback or progress-file drift — the tree was auto-bumped to
 * max(local, onChain) so no user is locked out, but the drift needs
 * investigation (see runbooks/droplet-recovery.md).
 */
export async function alertEntitlementDrift(
  tree: 'SOL' | 'BANK',
  bumpCount: number,
  sample: string,
): Promise<void> {
  await dispatch(
    'ops',
    `entitlement_drift_${tree.toLowerCase()}`,
    `**ALERT:** ${tree} epoch — ${bumpCount} wallet(s) had local entitlement < on-chain claimed. Auto-reconciled. Sample: ${sample.slice(0, 200)}`,
  );
}

// ─── Feed channel (public) ────────────────────────────────────────────────

export async function alertEpochSuccess(epoch: number, amountSol: number, userCount: number): Promise<void> {
  await dispatch('feed', 'epoch_success', `Epoch ${epoch} complete — ${amountSol.toFixed(4)} SOL distributed to ${userCount} users.`);
}
