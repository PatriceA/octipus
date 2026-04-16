import { coreLogger } from '@/utils/logger';
import type { GatewayEvent, } from './protocol';
import { matchesPattern } from './protocol';

type EventHandler = (event: GatewayEvent) => void;

/**
 * Central typed event bus for the gateway.
 * Replaces scattered EventEmitter patterns with a single pub/sub system.
 */
export class GatewayEventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private replayBuffer: Map<string, GatewayEvent[]> = new Map();
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
   * Clear replay buffer for a session.
   */
  clearReplay(sessionId: string): void {
    this.replayBuffer.delete(sessionId);
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
  }
}
