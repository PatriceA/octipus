import { Cache } from '@/db/cache';
import { apiLogger } from '@/utils/logger';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
}

interface LoginAttemptData {
  count: number;
  lockoutLevel: number; // 0 = no lockout history, 1 = 15min, 2 = 30min, 3 = 60min
  lockedUntil?: number; // epoch ms
}

const LOGIN_MAX_ATTEMPTS = 5;
const LOCKOUT_DURATIONS_SECS = [15 * 60, 30 * 60, 60 * 60]; // 15min, 30min, 60min

export class RateLimiter {
  private cache: Cache;

  constructor() {
    this.cache = new Cache(0);
  }

  /**
   * Fixed-window rate limit check: a key's window opens on its first hit and
   * lasts `windowSecs`. Returns whether the request is allowed, how many
   * remain, and when to retry if blocked.
   *
   * One atomic increment per request (plus the expiry on a window's first
   * hit). The read-then-write this replaces cost two storage round trips per
   * layer per request, and two concurrent requests could read the same count
   * and both pass. A refused request still counts; it does not extend the
   * window. The key prefix differs from the old JSON `{count, windowStart}`
   * entries so a counter never increments one of those.
   */
  async check(key: string, limit: number, windowSecs: number): Promise<RateLimitResult> {
    const windowKey = `ratecount:${key}`;
    const count = await this.cache.increment(windowKey);
    if (count === 1) await this.cache.expire(windowKey, windowSecs);
    if (count <= limit) return { allowed: true, remaining: limit - count };

    // A counter left without an expiry (the process stopped between the
    // increment and the expire) would refuse the key for good: give it one.
    let ttl = await this.cache.ttl(windowKey);
    if (ttl === -1) {
      apiLogger.warn({ key }, 'Rate-limit counter had no expiry; restarting its window');
      await this.cache.expire(windowKey, windowSecs);
      ttl = windowSecs;
    }
    return { allowed: false, remaining: 0, retryAfter: Math.max(1, ttl) };
  }

  /**
   * Check if a user account is locked out due to failed login attempts.
   * Returns { allowed, retryAfter } — if not allowed, retryAfter is seconds until unlock.
   */
  async checkLoginAttempts(username: string): Promise<RateLimitResult> {
    const key = `login_attempts:${username}`;
    const data = await this.cache.get<LoginAttemptData>(key);

    if (!data) {
      return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS };
    }

    // Check if currently locked out
    if (data.lockedUntil) {
      const now = Date.now();
      if (now < data.lockedUntil) {
        const retryAfter = Math.ceil((data.lockedUntil - now) / 1000);
        return { allowed: false, remaining: 0, retryAfter };
      }

      // Lockout expired — reset count but keep lockout level for escalation
      data.count = 0;
      delete data.lockedUntil;
      await this.cache.set(key, data, 3600); // keep data for 1 hour
    }

    const remaining = LOGIN_MAX_ATTEMPTS - data.count;
    return { allowed: true, remaining: Math.max(0, remaining) };
  }

  /**
   * Record a failed login attempt. If threshold reached, lock the account.
   */
  async recordFailedLogin(username: string): Promise<void> {
    const key = `login_attempts:${username}`;
    let data = await this.cache.get<LoginAttemptData>(key);

    if (!data) {
      data = { count: 0, lockoutLevel: 0 };
    }

    data.count += 1;

    if (data.count >= LOGIN_MAX_ATTEMPTS) {
      // Escalate lockout level (cap at max)
      const level = Math.min(data.lockoutLevel, LOCKOUT_DURATIONS_SECS.length - 1);
      const lockoutSecs = LOCKOUT_DURATIONS_SECS[level];
      data.lockedUntil = Date.now() + lockoutSecs * 1000;
      data.lockoutLevel = Math.min(data.lockoutLevel + 1, LOCKOUT_DURATIONS_SECS.length);

      apiLogger.warn(
        { username, lockoutLevel: data.lockoutLevel, lockoutSecs },
        'Account locked due to too many failed login attempts'
      );

      // TTL = lockout duration + 1 hour buffer
      await this.cache.set(key, data, lockoutSecs + 3600);
    } else {
      // Keep data for 1 hour
      await this.cache.set(key, data, 3600);
    }
  }

  /**
   * Clear failed login attempts on successful login.
   */
  async clearLoginAttempts(username: string): Promise<void> {
    const key = `login_attempts:${username}`;
    await this.cache.delete(key);
  }

  /**
   * Swarm per-user fan-out budget (Phase 3).
   *
   * Caps the number of `spawn_child` invocations a single user may trigger
   * per minute across all of their sessions. Enforced inside
   * `SwarmSpawner.spawnChild` before anything else — when the bucket is
   * exhausted the spawner returns `ChildResult{status:'concurrency_limit',
   * reason:'user_rate_limit'}` without charging the node's own fan-out cap.
   *
   * @param userId   The owning user whose bucket is checked + incremented.
   * @param limit    Max spawns per window (from `config.swarm.perUserSpawnsPerMinute`).
   * @returns `{ allowed, remaining, retryAfter? }` — caller decides how to
   *          translate the denial into a `ChildResult`.
   */
  async checkSwarmFanOutBudget(
    userId: string,
    limit: number,
  ): Promise<RateLimitResult> {
    if (!userId) {
      // Defensive: never rate-limit when we can't identify the user.
      return { allowed: true, remaining: limit };
    }
    return this.check(`swarmFanOutBudget:${userId}`, limit, 60);
  }
}

// Singleton
let rateLimiter: RateLimiter | null = null;

export function getRateLimiter(): RateLimiter {
  if (!rateLimiter) {
    rateLimiter = new RateLimiter();
  }
  return rateLimiter;
}
