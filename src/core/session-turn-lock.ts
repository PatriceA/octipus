/**
 * One turn at a time per session. All entry points into AgentService share
 * this queue, including monitor wake-ups and hook runs.
 *
 * Waiters run in arrival order, except a `front` waiter (a `restart` send,
 * docs/plans/orchestration-gaps-2026-11.md §3), which goes ahead of every
 * waiter already queued. `cancelQueuedTurns` drops every waiter (not the
 * running turn): each one rejects with `SessionTurnCancelledError` and its
 * `run` never starts.
 */

/** A queued turn was dropped before it ran (`/stop`, `agent.stop` on a root). */
export class SessionTurnCancelledError extends Error {
  readonly code = 'SESSION_TURN_CANCELLED';
  constructor(readonly sessionId: string, reason = 'Dropped by /stop before it ran') {
    super(reason);
    this.name = 'SessionTurnCancelledError';
  }
}

export function isSessionTurnCancelled(err: unknown): err is SessionTurnCancelledError {
  return err instanceof SessionTurnCancelledError
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'SESSION_TURN_CANCELLED');
}

interface Waiter { start: () => void; cancel: (err: Error) => void }
interface Lane { running: boolean; waiters: Waiter[] }

const lanes = new Map<string, Lane>();

export interface SessionTurnOptions {
  /** Run before every turn already waiting (still after the running one). */
  front?: boolean;
}

export async function withSessionTurn<T>(sessionId: string, run: () => Promise<T>, options: SessionTurnOptions = {}): Promise<T> {
  let lane = lanes.get(sessionId);
  if (!lane) { lane = { running: false, waiters: [] }; lanes.set(sessionId, lane); }
  if (lane.running || lane.waiters.length) {
    const waiting = lane;
    // The releasing turn hands `running` straight to this waiter, so nothing
    // arriving in between can slip ahead of it.
    await new Promise<void>((start, cancel) => {
      const waiter = { start, cancel };
      if (options.front) waiting.waiters.unshift(waiter); else waiting.waiters.push(waiter);
    });
  } else {
    lane.running = true;
    await Promise.resolve();
  }
  try { return await run(); }
  finally { release(sessionId); }
}

function release(sessionId: string): void {
  const lane = lanes.get(sessionId);
  if (!lane) return;
  const next = lane.waiters.shift();
  if (next) { next.start(); return; }
  lane.running = false;
  lanes.delete(sessionId);
}

/**
 * Drop every turn waiting behind the running one. Returns how many were
 * dropped; each rejects with `SessionTurnCancelledError`. The running turn is
 * untouched (stop its agents for that).
 */
export function cancelQueuedTurns(sessionId: string, reason?: string): number {
  const lane = lanes.get(sessionId);
  if (!lane?.waiters.length) return 0;
  const dropped = lane.waiters.splice(0);
  for (const waiter of dropped) waiter.cancel(new SessionTurnCancelledError(sessionId, reason));
  if (!lane.running) lanes.delete(sessionId);
  return dropped.length;
}

/** Is a turn of this session running (holding the lock)? */
export function isSessionTurnRunning(sessionId: string): boolean {
  return lanes.get(sessionId)?.running === true;
}

/** How many turns wait behind the running one. */
export function queuedTurnCount(sessionId: string): number {
  return lanes.get(sessionId)?.waiters.length ?? 0;
}
