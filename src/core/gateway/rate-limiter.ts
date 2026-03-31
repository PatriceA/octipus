import type { TrustLevel } from './protocol';

// ── Rate Limit Configuration ──────────────────────────────────────

export interface RateLimitConfig {
  /** Max requests per window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
}

/** Default limits per action type and trust level */
const DEFAULT_LIMITS: Record<string, Record<TrustLevel, RateLimitConfig>> = {
  'chat.send': {
    user: { limit: 30, windowMs: 60_000 },
    local: { limit: 60, windowMs: 60_000 },
    system: { limit: 200, windowMs: 60_000 },
    agent: { limit: 100, windowMs: 60_000 },
  },
  command: {
    user: { limit: 60, windowMs: 60_000 },
    local: { limit: 120, windowMs: 60_000 },
    system: { limit: 200, windowMs: 60_000 },
    agent: { limit: 60, windowMs: 60_000 },
  },
  subscribe: {
    user: { limit: 30, windowMs: 60_000 },
    local: { limit: 60, windowMs: 60_000 },
    system: { limit: 100, windowMs: 60_000 },
    agent: { limit: 30, windowMs: 60_000 },
  },
  default: {
    user: { limit: 60, windowMs: 60_000 },
    local: { limit: 120, windowMs: 60_000 },
    system: { limit: 300, windowMs: 60_000 },
    agent: { limit: 60, windowMs: 60_000 },
  },
};

// ── Sliding Window Counter ────────────────────────────────────────

interface WindowEntry {
  timestamps: number[];
}

/**
 * Gateway-level rate limiter using sliding window counters.
 * Tracks per-connection, per-action request rates.
 */
export class GatewayRateLimiter {
  private windows: Map<string, WindowEntry> = new Map();
  private cleanupTimer: Timer | null = null;

  constructor(private customLimits?: Record<string, Record<TrustLevel, RateLimitConfig>>) {
    // Periodic cleanup of stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 300_000);
  }

  /**
   * Check if a request is allowed. Returns true if allowed, false if rate-limited.
   */
  check(connectionId: string, action: string, trustLevel: TrustLevel): { allowed: boolean; retryAfterMs?: number } {
    const config = this.getConfig(action, trustLevel);
    const key = `${connectionId}:${action}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Remove expired timestamps
    entry.timestamps = entry.timestamps.filter(t => t > windowStart);

    if (entry.timestamps.length >= config.limit) {
      // Rate limited — compute when the oldest request in the window expires
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = oldestInWindow + config.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    // Allowed
    entry.timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Get current usage for a connection+action.
   */
  getUsage(connectionId: string, action: string, trustLevel: TrustLevel): { used: number; limit: number; windowMs: number } {
    const config = this.getConfig(action, trustLevel);
    const key = `${connectionId}:${action}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const entry = this.windows.get(key);
    const used = entry ? entry.timestamps.filter(t => t > windowStart).length : 0;

    return { used, limit: config.limit, windowMs: config.windowMs };
  }

  /**
   * Remove all state for a connection (on disconnect).
   */
  removeConnection(connectionId: string): void {
    const prefix = `${connectionId}:`;
    for (const key of this.windows.keys()) {
      if (key.startsWith(prefix)) {
        this.windows.delete(key);
      }
    }
  }

  /**
   * Clean up stale window entries.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      // Remove entries where all timestamps are expired (oldest possible window is 60s)
      entry.timestamps = entry.timestamps.filter(t => t > now - 300_000);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }

  private getConfig(action: string, trustLevel: TrustLevel): RateLimitConfig {
    const limits = this.customLimits || DEFAULT_LIMITS;
    const actionConfig = limits[action] || limits.default;
    return actionConfig[trustLevel] || limits.default[trustLevel];
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.windows.clear();
  }
}
