import { logger } from './logger';

const MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

/**
 * Retry an async fn with exponential backoff. `baseDelayMs` defaults to 1000;
 * keeper passes 2000 for slower external calls. Label is emitted in retry
 * warnings — choose something callers can grep for.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  baseDelayMs: number = DEFAULT_BASE_DELAY_MS,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let i = 0; i <= MAX_RETRIES; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      if (i < MAX_RETRIES) {
        const delay = baseDelayMs * Math.pow(2, i);
        logger.warn(`  [retry] ${label} #${i + 1}, ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
