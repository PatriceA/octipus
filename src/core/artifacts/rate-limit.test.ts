import { afterEach, describe, expect, test } from 'vitest';
import { _resetRateLimits, checkRateLimit } from './rate-limit';

afterEach(() => _resetRateLimits());

describe('checkRateLimit', () => {
  test('allows up to capacity then blocks', () => {
    const opts = { capacity: 3, refillPerSecond: 0.1 };
    expect(checkRateLimit('ip', opts).allowed).toBe(true);
    expect(checkRateLimit('ip', opts).allowed).toBe(true);
    expect(checkRateLimit('ip', opts).allowed).toBe(true);
    const blocked = checkRateLimit('ip', opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('different keys independent', () => {
    const opts = { capacity: 1, refillPerSecond: 0.01 };
    expect(checkRateLimit('a', opts).allowed).toBe(true);
    expect(checkRateLimit('a', opts).allowed).toBe(false);
    expect(checkRateLimit('b', opts).allowed).toBe(true);
  });
});
