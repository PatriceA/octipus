import { coreLogger } from '@/utils/logger';
import type { GatewayEvent, } from './protocol';
import { matchesPattern } from './protocol';

type EventHandler = (event: GatewayEvent) => void;

/**
 * Event-type patterns that get an **additional** dedicated replay buffer
 * on top of the per-session buffer. Useful for subsystems whose UI needs
 * to rehydrate on reconnect without replaying the full chat transcript.
 *
 * The buffer is still keyed by `sessionId`, but only events whose type
 * matches one of these patterns are retained — so a WS client that just
 * lost its swarm tree can resubscribe + ask for `swarm.*` replay without
 * re-receiving every `agent.event` / `chat.message` from the full buffer.
 *
 * Phase 3: `swarm.*` is wired so the web live tree survives reconnects.
 */
const RECORDED_TYPE_PATTERNS = ['swarm.*'] as const;

/**
 * Central typed event bus for the gateway.
 * Replaces scattered EventEmitter patterns with a single pub/sub system.
 */
export class GatewayEventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private replayBuffer: Map<string, GatewayEvent[]> = new Map();
  /**
   * Dedicated per-pattern replay buffer. Shape: `pattern -> sessionId -> events[]`.
   * Populated alongside the main session buffer on `publish()`. Read via
   * `getReplayByPattern(pattern, sessionId)`.
   */
  private patternReplayBuffer: Map<string, Map<string, GatewayEvent[]>> = new Map();
  private maxReplayPerSession = 200;
  private eventCounter = 0;

  /**
   * Subscribe to events matching a pattern.
   * Returns an unsubscribe function.
   */
  subscribe(pattern: string, handler: EventHandler): () => void {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)!.add(handler);

    return () => {
      this.handlers.get(pattern)?.delete(handler);
      if (this.handlers.get(pattern)?.size === 0) {
        this.handlers.delete(pattern);
      }
    };
  }

  /**
   * Publish an event to all matching subscribers.
   */
  publish(event: GatewayEvent): void {
    // Store in replay buffer by session
    if (event.sessionId) {
      if (!this.replayBuffer.has(event.sessionId)) {
        this.replayBuffer.set(event.sessionId, []);
      }
      const buffer = this.replayBuffer.get(event.sessionId)!;
      buffer.push(event);
      if (buffer.length > this.maxReplayPerSession) {
        buffer.shift();
      }

      // Mirror into dedicated per-pattern replay buffers for any pattern
      // this event matches (e.g. `swarm.*`). Same session-keyed structure
      // so clients reconnect + pull just the swarm tree without replaying
      // the full chat transcript.
      for (const pattern of RECORDED_TYPE_PATTERNS) {
        if (!matchesPattern(event.type, pattern)) continue;
        let patternMap = this.patternReplayBuffer.get(pattern);
        if (!patternMap) {
          patternMap = new Map();
          this.patternReplayBuffer.set(pattern, patternMap);
        }
        let patBuf = patternMap.get(event.sessionId);
        if (!patBuf) {
          patBuf = [];
          patternMap.set(event.sessionId, patBuf);
        }
        patBuf.push(event);
        if (patBuf.length > this.maxReplayPerSession) {
          patBuf.shift();
        }
      }
    }

    this.eventCounter++;

    // Deliver to all matching subscribers
    for (const [pattern, handlers] of this.handlers) {
      if (matchesPattern(event.type, pattern)) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (err) {
            coreLogger.error({ err, eventType: event.type, pattern }, 'Event handler error');
          }
        }
      }
    }
  }

  /**
   * Get replay buffer for a session (for reconnection).
   */
  getReplay(sessionId: string, afterEventId?: string): GatewayEvent[] {
    const buffer = this.replayBuffer.get(sessionId);
    if (!buffer) return [];

    if (afterEventId) {
      const idx = buffer.findIndex(e => e.id === afterEventId);
      if (idx >= 0) return buffer.slice(idx + 1);
    }
    return [...buffer];
  }

  /**
   * Get replay buffer scoped to a specific recorded pattern (e.g. `swarm.*`)
   * for a single session. Returns `[]` if the pattern isn't recorded or the
   * session never emitted a matching event.
   *
   * Used by the web live swarm tree to rehydrate without pulling the full
   * chat transcript.
   */
  getReplayByPattern(pattern: string, sessionId: string, afterEventId?: string): GatewayEvent[] {
    const patternMap = this.patternReplayBuffer.get(pattern);
    if (!patternMap) return [];
    const buffer = patternMap.get(sessionId);
    if (!buffer) return [];
    if (afterEventId) {
      const idx = buffer.findIndex(e => e.id === afterEventId);
      if (idx >= 0) return buffer.slice(idx + 1);
    }
    return [...buffer];
  }

  /** Patterns currently mirrored into the dedicated per-pattern buffer. */
  getRecordedPatterns(): readonly string[] {
    return RECORDED_TYPE_PATTERNS;
  }

  /**
   * Clear replay buffer for a session.
   */
  clearReplay(sessionId: string): void {
    this.replayBuffer.delete(sessionId);
    for (const patternMap of this.patternReplayBuffer.values()) {
      patternMap.delete(sessionId);
    }
  }

  /**
   * Get total events published.
   */
  getStats(): { totalPublished: number; activeSubscriptions: number; replayBufferSessions: number } {
    let activeSubscriptions = 0;
    for (const handlers of this.handlers.values()) {
      activeSubscriptions += handlers.size;
    }
    return {
      totalPublished: this.eventCounter,
      activeSubscriptions,
      replayBufferSessions: this.replayBuffer.size,
    };
  }

  /**
   * Remove all subscriptions and buffers.
   */
  destroy(): void {
    this.handlers.clear();
    this.replayBuffer.clear();
    this.patternReplayBuffer.clear();
  }
}
