import { ApiError } from './api.js';

/** Further attempts after the first, for loads only; clicks are never retried. */
export const MAX_RETRIES = 3;

const MIN_WAIT_MS = 500;
const MAX_WAIT_MS = 10_000;

/**
 * Worth trying again: the server could not be reached (status 0, which is
 * also what a cross-origin failure looks like), was throttling us, or failed
 * on its side. Anything else, such as an unknown key or a refused origin, will
 * not change by waiting.
 */
export function isRetryable(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500)
  );
}

/**
 * How long to wait before attempt `attempt + 1`: what the server asked for
 * when it said, otherwise 1 s, 2 s, 4 s with ±20% jitter so the buttons on one
 * page do not all retry in the same instant.
 */
export function retryDelayMs(error: unknown, attempt: number, random = Math.random): number {
  const asked = error instanceof ApiError ? error.retryAfter : undefined;
  const wait = asked !== undefined ? asked * 1000 : 1000 * 2 ** attempt * (0.8 + 0.4 * random());
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(wait)));
}

/**
 * Runs `load`, trying again on retryable failures. Gives up early, rethrowing
 * the last error, once `abandoned()` says the result is no longer wanted.
 */
export async function withRetry<T>(load: () => Promise<T>, abandoned: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (attempt >= MAX_RETRIES || !isRetryable(error) || abandoned()) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error, attempt)));
      if (abandoned()) throw error;
    }
  }
}
