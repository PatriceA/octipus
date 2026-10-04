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
 * Event types never kept for replay: a spoken line replayed after a
 * reconnect would be read aloud again, out of time.
 */
const UNRECORDED_TYPES: ReadonlySet<string> = new Set(['voice.speak']);

/** Default `gateway.replayMaxSessions`. */
const DEFAULT_MAX_SESSIONS = 500;

export interface GatewayEventBusOptions {
  /**
   * How many sessions keep a replay buffer; the least recently published-to
   * session is evicted first. A function so a config change applies to the
   * next publish.
   */
  maxSessions?: number | (() => number);
}

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
  private readonly maxSessions: () => number;

  constructor(options: GatewayEventBusOptions = {}) {
    const max = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxSessions = typeof max === 'function' ? max : () => max;
  }

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
    // Store in replay buffer by session. The Map is kept in recency order
    // (re-inserted on every publish), so its first key is the least recently
    // active session — the one evicted when the cap is reached.
    if (event.sessionId && !UNRECORDED_TYPES.has(event.type)) {
      let buffer = this.replayBuffer.get(event.sessionId);
      if (buffer) {
        this.replayBuffer.delete(event.sessionId);
      } else {
        buffer = [];
      }
      this.replayBuffer.set(event.sessionId, buffer);
      this.evictOverCap();
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
   * The events of `sessionId` after `afterEventId`, for a reconnecting
   * client. `gap` is true when `afterEventId` is not in the buffer (evicted,
   * or rolled out of it): the events cannot bridge what the client missed.
   * The caller checks that the session is the requester's own.
   */
  replaySince(sessionId: string, afterEventId?: string): { events: GatewayEvent[]; gap: boolean } {
    const buffer = this.replayBuffer.get(sessionId) ?? [];
    if (!afterEventId) return { events: [...buffer], gap: false };
    const idx = buffer.findIndex(e => e.id === afterEventId);
    if (idx < 0) return { events: [...buffer], gap: true };
    return { events: buffer.slice(idx + 1), gap: false };
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

  /** Drop the least recently active sessions beyond `maxSessions`. */
  private evictOverCap(): void {
    const cap = Math.max(1, this.maxSessions());
    while (this.replayBuffer.size > cap) {
      const oldest = this.replayBuffer.keys().next().value;
      if (oldest === undefined) return;
      this.clearReplay(oldest);
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
