import { coreLogger } from '@/utils/logger';
import type { ClientType, ConnectionContext, TrustLevel } from './protocol';

// ── Types ─────────────────────────────────────────────────────────

export interface PresenceEntry {
  connectionId: string;
  userId: string;
  clientType: ClientType;
  trustLevel: TrustLevel;
  ip: string;
  connectedAt: number;
  lastActivityAt: number;
  metadata: Record<string, unknown>;
}

export interface PresenceStats {
  totalConnections: number;
  uniqueUsers: number;
  byClientType: Record<string, number>;
  byTrustLevel: Record<string, number>;
}

// ── Idle Timeouts ─────────────────────────────────────────────────

const IDLE_TIMEOUTS: Record<ClientType, number> = {
  webchat: 30 * 60_000,   // 30 minutes
  mobile: 30 * 60_000,    // 30 minutes
  acp: 60 * 60_000,       // 1 hour
  tui: 0,                 // No timeout (local)
  channel: 0,             // No timeout (system adapter)
  agent: 5 * 60_000,      // 5 minutes
};

// ── Presence Tracker ──────────────────────────────────────────────

/**
 * Tracks who's connected, from where, and for how long.
 * Handles idle timeout detection.
 */
export class PresenceTracker {
  private entries: Map<string, PresenceEntry> = new Map();
  private checkTimer: NodeJS.Timeout | null = null;
  private onIdleTimeout?: (connectionId: string, entry: PresenceEntry) => void;

  constructor(options?: { onIdleTimeout?: (connectionId: string, entry: PresenceEntry) => void }) {
    this.onIdleTimeout = options?.onIdleTimeout;
    // Check for idle connections every 60 seconds
    this.checkTimer = setInterval(() => this.checkIdleConnections(), 60_000);
  }

  /**
   * Register a connection as present.
   */
  track(context: ConnectionContext): void {
    this.entries.set(context.connectionId, {
      connectionId: context.connectionId,
      userId: context.userId,
      clientType: context.clientType,
      trustLevel: context.trustLevel,
      ip: context.ip,
      connectedAt: context.connectedAt,
      lastActivityAt: context.lastActivityAt,
      metadata: context.metadata,
    });
  }

  /**
   * Update last activity timestamp.
   */
  touch(connectionId: string): void {
    const entry = this.entries.get(connectionId);
    if (entry) {
      entry.lastActivityAt = Date.now();
    }
  }

  /**
   * Remove a connection from presence tracking.
   */
  remove(connectionId: string): void {
    this.entries.delete(connectionId);
  }

  /**
   * Get presence entry for a connection.
   */
  get(connectionId: string): PresenceEntry | undefined {
    return this.entries.get(connectionId);
  }

  /**
   * Get all connections for a user.
   */
  getByUser(userId: string): PresenceEntry[] {
    return [...this.entries.values()].filter(e => e.userId === userId);
  }

  /**
   * Get all active connections.
   */
  getAll(): PresenceEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Get presence stats.
   */
  getStats(): PresenceStats {
    const byClientType: Record<string, number> = {};
    const byTrustLevel: Record<string, number> = {};
    const users = new Set<string>();

    for (const entry of this.entries.values()) {
      users.add(entry.userId);
      byClientType[entry.clientType] = (byClientType[entry.clientType] || 0) + 1;
      byTrustLevel[entry.trustLevel] = (byTrustLevel[entry.trustLevel] || 0) + 1;
    }

    return {
      totalConnections: this.entries.size,
      uniqueUsers: users.size,
      byClientType,
      byTrustLevel,
    };
  }

  /**
   * Check for idle connections and fire timeout callbacks.
   */
  private checkIdleConnections(): void {
    const now = Date.now();
    for (const [connectionId, entry] of this.entries) {
      const timeout = IDLE_TIMEOUTS[entry.clientType];
      if (timeout === 0) continue; // No timeout

      const idle = now - entry.lastActivityAt;
      if (idle > timeout) {
        coreLogger.info({ connectionId, userId: entry.userId, clientType: entry.clientType, idleMs: idle }, 'Idle connection detected');
        this.onIdleTimeout?.(connectionId, entry);
      }
    }
  }

  /**
   * Destroy the presence tracker and stop periodic checks.
   */
  destroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.entries.clear();
  }
}
