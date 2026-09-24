import { describe, expect, it } from 'vitest';

import { ApiError } from '../../src/api.js';
import { isRetryable, retryDelayMs } from '../../src/retry.js';

describe('isRetryable', () => {
  it('retries what waiting can fix: offline, throttled, server failures', () => {
    expect(isRetryable(new ApiError(0, 'network_error', 'offline'))).toBe(true);
    expect(isRetryable(new ApiError(429, 'rate_limited', 'slow down'))).toBe(true);
    expect(isRetryable(new ApiError(503, 'unavailable', 'down'))).toBe(true);
  });

  it('does not retry answers that will not change', () => {
    expect(isRetryable(new ApiError(404, 'not_found', 'no'))).toBe(false);
    expect(isRetryable(new ApiError(403, 'origin_not_allowed', 'no'))).toBe(false);
    expect(isRetryable(new Error('not an API error'))).toBe(false);
  });
});

describe('retryDelayMs', () => {
  const throttled = (retryAfter?: number) =>
    new ApiError(429, 'rate_limited', 'slow down', retryAfter);

  it('waits as long as the server asked, within 0.5 to 10 s', () => {
    expect(retryDelayMs(throttled(3), 0)).toBe(3000);
    expect(retryDelayMs(throttled(0), 0)).toBe(500);
    expect(retryDelayMs(throttled(60), 0)).toBe(10_000);
  });

  it('otherwise backs off 1 s, 2 s, 4 s with jitter', () => {
    const middle = () => 0.5;
    expect([0, 1, 2].map((attempt) => retryDelayMs(throttled(), attempt, middle))).toEqual([
      1000, 2000, 4000,
    ]);
    expect(retryDelayMs(throttled(), 0, () => 0)).toBe(800);
    expect(retryDelayMs(throttled(), 0, () => 1)).toBe(1200);
  });
});
