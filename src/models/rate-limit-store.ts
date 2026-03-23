import { RedisCache } from '@/db/redis';
import { modelLogger } from '@/utils/logger';

const KEY_PREFIX = 'rate:';
const CONCURRENCY_TTL = 300; // 5 min TTL for concurrency keys (auto-cleanup on crash)
const RPM_TTL = 120; // 2 min TTL for RPM counters
const BACKOFF_TTL = 120; // 2 min TTL for backoff state

// ── Types ──

interface BackoffState {
  until: number; // Unix timestamp ms
  consecutiveErrors: number;
  provider: string;
  updatedAt: string;
}

interface ConcurrencyState {
  count: number;
  instanceId: string;
  updatedAt: string;
}

/**
 * Redis-backed state store for rate limiting.
 * Enables rate limiting across multiple backend instances.
 * Falls back gracefully to in-memory (via the RedisCache wrapper) if Redis is unavailable.
 */
export class RateLimitStore {
  private cache = new RedisCache(0); // No default TTL, managed per key
  private instanceId: string;

  constructor() {
    // Unique ID for this backend instance
    this.instanceId = `inst_${process.pid}_${Date.now().toString(36)}`;
  }

  // ── Concurrency tracking ──

  /**
   * Increment concurrent request count for a provider.
   * Returns the new count.
   */
  async incrementConcurrency(provider: string): Promise<number> {
    const key = `${KEY_PREFIX}${provider}:concurrent`;
    try {
      const newVal = await this.cache.increment(key);
      await this.cache.expire(key, CONCURRENCY_TTL);
      return newVal;
    } catch (error) {
      modelLogger.debug({ error, provider }, 'Rate limit store: increment concurrency failed, using local');
      return -1; // Caller should fall back to in-memory tracking
    }
  }

  /**
   * Decrement concurrent request count for a provider.
   * Returns the new count.
   */
  async decrementConcurrency(provider: string): Promise<number> {
    const key = `${KEY_PREFIX}${provider}:concurrent`;
    try {
      const newVal = await this.cache.increment(key, -1);
      return Math.max(0, newVal);
    } catch (error) {
      modelLogger.debug({ error, provider }, 'Rate limit store: decrement concurrency failed');
      return -1;
    }
  }

  /** Get current concurrent request count */
  async getConcurrency(provider: string): Promise<number> {
    const key = `${KEY_PREFIX}${provider}:concurrent`;
    try {
      const val = await this.cache.get<number>(key);
      return val ?? 0;
    } catch {
      return 0;
    }
  }

  // ── RPM tracking ──

  /**
   * Increment request count for the current minute window.
   * Returns the count for the current window.
   */
  async incrementRpm(provider: string): Promise<number> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${KEY_PREFIX}${provider}:rpm:${minute}`;
    try {
      const count = await this.cache.increment(key);
      await this.cache.expire(key, RPM_TTL);
      return count;
    } catch {
      return -1;
    }
  }

  /** Get current RPM count */
  async getRpm(provider: string): Promise<number> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = `${KEY_PREFIX}${provider}:rpm:${minute}`;
    try {
      const val = await this.cache.get<number>(key);
      return val ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Backoff state ──

  /** Store backoff state for a provider */
  async setBackoff(provider: string, until: number, consecutiveErrors: number): Promise<void> {
    const key = `${KEY_PREFIX}${provider}:backoff`;
    const state: BackoffState = {
      until,
      consecutiveErrors,
      provider,
      updatedAt: new Date().toISOString(),
    };
    try {
      const ttl = Math.max(1, Math.ceil((until - Date.now()) / 1000));
      await this.cache.set(key, state, Math.min(ttl, BACKOFF_TTL));
    } catch (error) {
      modelLogger.debug({ error, provider }, 'Rate limit store: set backoff failed');
    }
  }

  /** Get backoff state for a provider */
  async getBackoff(provider: string): Promise<BackoffState | null> {
    const key = `${KEY_PREFIX}${provider}:backoff`;
    try {
      const state = await this.cache.get<BackoffState>(key);
      if (state && state.until > Date.now()) {
        return state;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Clear backoff for a provider */
  async clearBackoff(provider: string): Promise<void> {
    const key = `${KEY_PREFIX}${provider}:backoff`;
    try {
      await this.cache.delete(key);
    } catch {
      // Ignore
    }
  }

  // ── Aggregate stats ──

  /** Get a snapshot of all rate-limit related state for a provider */
  async getProviderSnapshot(provider: string): Promise<{
    concurrency: number;
    rpm: number;
    backoff: BackoffState | null;
  }> {
    const [concurrency, rpm, backoff] = await Promise.all([
      this.getConcurrency(provider),
      this.getRpm(provider),
      this.getBackoff(provider),
    ]);
    return { concurrency, rpm, backoff };
  }
}

// ── Singleton ──

let storeInstance: RateLimitStore | null = null;

export function getRateLimitStore(): RateLimitStore {
  if (!storeInstance) {
    storeInstance = new RateLimitStore();
  }
  return storeInstance;
}

export function resetRateLimitStore(): void {
  storeInstance = null;
}
