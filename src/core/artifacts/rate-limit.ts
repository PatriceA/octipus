/**
 * Per-IP token-bucket for public artifact viewers. Process-local; replace
 * with Redis-backed counter when running multi-instance. Defaults: 60
 * requests / minute / IP, burst 10.
 */

const buckets = new Map<string, { tokens: number; updatedAt: number }>();

export interface RateLimitOpts {
  capacity?: number; // bucket size
  refillPerSecond?: number; // tokens added per second
}

export function checkRateLimit(key: string, opts: RateLimitOpts = {}): { allowed: boolean; retryAfterSeconds?: number } {
  const capacity = opts.capacity ?? 10;
  const refill = opts.refillPerSecond ?? 1; // 60/min
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  const elapsed = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refill);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    const wait = Math.ceil((1 - bucket.tokens) / refill);
    return { allowed: false, retryAfterSeconds: wait };
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { allowed: true };
}

/** Test-only — clear all buckets. */
export function _resetRateLimits(): void {
  buckets.clear();
}
