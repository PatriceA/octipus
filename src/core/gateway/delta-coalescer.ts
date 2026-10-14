import type { UserGatewayEvent } from './protocol';

type DeltaEvent = Omit<UserGatewayEvent, 'id' | 'timestamp'>;

/** How long streamed text waits for more before it goes out. */
export const DELTA_FLUSH_MS = 40;
/** Buffered text at which a delta goes out without waiting. */
export const DELTA_FLUSH_CHARS = 512;

interface PendingDelta {
  event: DeltaEvent;
  iteration: number;
  text: string;
}

/**
 * Merges the `chat.delta` events of one agent's stream into fewer, larger
 * ones. A model streams a token at a time; publishing each one costs an id,
 * a fan-out and a frame per tab, and buys nothing a 40 ms batch does not.
 * Clients append deltas, so a merged one renders the same text.
 *
 * Text is held per user, session, agent and iteration — a new iteration
 * flushes the previous one first, since clients start a new block on it. The
 * owner (`GatewayHub`) flushes a user's pending text before publishing any
 * other event of theirs, so nothing overtakes the text that preceded it.
 */
export class DeltaCoalescer {
  private pending = new Map<string, PendingDelta>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly emit: (event: DeltaEvent) => void,
    private readonly flushMs = DELTA_FLUSH_MS,
    private readonly maxChars = DELTA_FLUSH_CHARS,
  ) {}

  push(event: DeltaEvent): void {
    const payload = (event.payload ?? {}) as { agentId?: unknown; delta?: unknown; iteration?: unknown };
    if (typeof payload.delta !== 'string') {
      // Not a text slice this can merge: keep its place in the stream.
      this.flushUser(event.userId);
      this.emit(event);
      return;
    }
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
    const iteration = typeof payload.iteration === 'number' ? payload.iteration : 0;
    const key = `${event.userId}\0${event.sessionId ?? ''}\0${agentId}`;
    let entry = this.pending.get(key);
    if (entry && entry.iteration !== iteration) {
      this.pending.delete(key);
      this.emitPending(entry);
      entry = undefined;
    }
    if (entry) {
      entry.text += payload.delta;
    } else {
      entry = { event, iteration, text: payload.delta };
      this.pending.set(key, entry);
    }
    if (entry.text.length >= this.maxChars) {
      this.pending.delete(key);
      this.emitPending(entry);
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushAll();
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  /** Send `userId`'s held text now. */
  flushUser(userId: string): void {
    if (this.pending.size === 0) return;
    for (const [key, entry] of this.pending) {
      if (entry.event.userId !== userId) continue;
      this.pending.delete(key);
      this.emitPending(entry);
    }
  }

  /** Send all held text now. */
  flushAll(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) this.emitPending(entry);
  }

  private emitPending(entry: PendingDelta): void {
    const payload = entry.event.payload as Record<string, unknown>;
    this.emit({ ...entry.event, payload: { ...payload, delta: entry.text } });
  }
}
