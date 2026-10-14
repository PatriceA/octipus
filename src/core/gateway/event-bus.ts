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
 * reconnect would be read aloud again, out of time; streamed text is
 * superseded by the `chat.response` that ends the turn, and one long answer
 * would otherwise push every meaningful event out of the buffer.
 */
const UNRECORDED_TYPES: ReadonlySet<string> = new Set(['voice.speak', 'chat.delta']);

/** Default `gateway.replayMaxSessions`. */
const DEFAULT_MAX_SESSIONS = 500;

/** A session nothing was published to for this long loses its replay buffer. */
export const REPLAY_IDLE_TTL_MS = 30 * 60_000;

/**
 * Largest payload (approximate characters) kept for replay. A bigger one is
 * not stored, and the session's buffer is dropped with it: a client resuming
 * from before it gets `gap: true` and reloads from REST, rather than a replay
 * silently missing an event.
 */
export const MAX_REPLAY_PAYLOAD_CHARS = 64_000;

/**
 * Whether `value` serializes to more than `limit` characters, roughly
 * (strings and keys counted, punctuation not). Stops walking as soon as the
 * limit is passed, so a large payload costs no more than the limit.
 */
function exceedsChars(value: unknown, limit: number): boolean {
  let remaining = limit;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') remaining -= item.length;
    else if (Array.isArray(item)) { remaining -= item.length; stack.push(...item); }
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        remaining -= key.length + 1;
        stack.push(child);
      }
    } else remaining -= 8;
    if (remaining < 0) return true;
  }
  return false;
}

interface SessionReplay {
  events: GatewayEvent[];
  /** When an event was last published to the session (idle eviction). */
  lastAt: number;
}

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
  private replayBuffer: Map<string, SessionReplay> = new Map();
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
      const now = Date.now();
      let entry = this.replayBuffer.get(event.sessionId);
      if (entry) {
        this.replayBuffer.delete(event.sessionId);
      } else {
        entry = { events: [], lastAt: now };
      }
      entry.lastAt = now;
      this.replayBuffer.set(event.sessionId, entry);
      this.evictOverCap();
      this.evictIdle(now);
      const oversized = exceedsChars(event.payload, MAX_REPLAY_PAYLOAD_CHARS);
      const buffer = entry.events;
      if (oversized) {
        // Not stored, and nothing before it can be replayed across it.
        buffer.length = 0;
      } else {
        buffer.push(event);
        if (buffer.length > this.maxReplayPerSession) {
          buffer.shift();
        }
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
        if (oversized) {
          patBuf.length = 0;
          continue;
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
    const buffer = this.replayBuffer.get(sessionId)?.events ?? [];
    if (!afterEventId) return { events: [...buffer], gap: false };
    const idx = buffer.findIndex(e => e.id === afterEventId);
    if (idx < 0) return { events: [...buffer], gap: true };
    return { events: buffer.slice(idx + 1), gap: false };
  }

  /**
   * Get replay buffer for a session (for reconnection).
   */
  getReplay(sessionId: string, afterEventId?: string): GatewayEvent[] {
    const buffer = this.replayBuffer.get(sessionId)?.events;
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
   * Drop the sessions nothing was published to for `REPLAY_IDLE_TTL_MS`. The
   * map is in recency order, so the walk stops at the first live session.
   */
  private evictIdle(now: number): void {
    for (const [sessionId, entry] of this.replayBuffer) {
      if (now - entry.lastAt <= REPLAY_IDLE_TTL_MS) return;
      this.clearReplay(sessionId);
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
