/**
 * One turn at a time per session. All entry points into AgentService share
 * this queue, including monitor wake-ups and hook runs.
 *
 * Waiters run in arrival order, except `front` waiters (a `restart` send,
 * docs/plans/orchestration-gaps-2026-11.md §3), which go ahead of every
 * ordinary waiter, in their own arrival order. A caller that must hold its
 * place before doing something else (a restart stops the running turn only
 * once its place is taken) reserves it with `reserveSessionTurn` and hands
 * the reservation to `withSessionTurn`.
 *
 * `cancelQueuedTurns` drops waiters (never the running turn): each rejects
 * with `SessionTurnCancelledError` and its `run` never starts. Only
 * `message` waiters are dropped — a user's message or a hook run — and, given
 * an owner, only that user's. `background` waiters (monitor and companion
 * wake-ups, room turns) stay: they have their own delivery and cancel paths.
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

/** `message`: a user's message or a hook run (`/stop` drops it); `background`: a durable wake-up or room turn (never dropped here). */
export type SessionTurnKind = 'message' | 'background';

interface Waiter { start: () => void; cancel: (err: Error) => void; front: boolean; owner?: string; kind: SessionTurnKind }
interface Lane { running: boolean; waiters: Waiter[] }

const lanes = new Map<string, Lane>();

export interface SessionTurnOptions {
  /** Run before every ordinary turn already waiting (after earlier front turns, and the running one). */
  front?: boolean;
  /** The user the turn is for: a cancel by owner drops only their turns. */
  owner?: string;
  /** Default `message`. */
  kind?: SessionTurnKind;
}

/** A place in a session's queue, held from `reserveSessionTurn` until `release`. */
export interface SessionTurnReservation {
  readonly sessionId: string;
  /** Resolves when the turn may run; rejects with `SessionTurnCancelledError` if dropped first. */
  readonly ready: Promise<void>;
  /** Give the place up: the lock if held, the waiting slot otherwise. Idempotent. */
  release(): void;
}

/** Take a place in the session's queue now, synchronously. */
export function reserveSessionTurn(sessionId: string, options: SessionTurnOptions = {}): SessionTurnReservation {
  let lane = lanes.get(sessionId);
  if (!lane) { lane = { running: false, waiters: [] }; lanes.set(sessionId, lane); }
  let state: 'waiting' | 'running' | 'done';
  let ready: Promise<void>;
  let waiter: Waiter | undefined;
  if (!lane.running && !lane.waiters.length) {
    lane.running = true;
    state = 'running';
    ready = Promise.resolve();
  } else {
    state = 'waiting';
    const waiting = lane;
    ready = new Promise<void>((resolve, reject) => {
      // The releasing turn hands `running` straight to this waiter, so nothing
      // arriving in between can slip ahead of it.
      waiter = {
        start: () => { state = 'running'; resolve(); },
        cancel: (err) => { state = 'done'; reject(err); },
        front: options.front === true,
        ...(options.owner ? { owner: options.owner } : {}),
        kind: options.kind ?? 'message',
      };
      if (waiter.front) {
        const at = waiting.waiters.findIndex(w => !w.front);
        waiting.waiters.splice(at === -1 ? waiting.waiters.length : at, 0, waiter);
      } else waiting.waiters.push(waiter);
    });
    // A dropped reservation nobody awaits yet must not be an unhandled rejection.
    ready.catch(() => {});
  }
  return {
    sessionId,
    ready,
    release: () => {
      if (state === 'running') { state = 'done'; releaseLane(sessionId); return; }
      if (state !== 'waiting') return;
      state = 'done';
      const current = lanes.get(sessionId);
      const index = current && waiter ? current.waiters.indexOf(waiter) : -1;
      if (current && index !== -1) current.waiters.splice(index, 1);
    },
  };
}

export async function withSessionTurn<T>(
  sessionId: string,
  run: () => Promise<T>,
  options: SessionTurnOptions & { reservation?: SessionTurnReservation } = {},
): Promise<T> {
  const reservation = options.reservation ?? reserveSessionTurn(sessionId, options);
  try { await reservation.ready; }
  catch (err) { reservation.release(); throw err; }
  try { return await run(); }
  finally { reservation.release(); }
}

function releaseLane(sessionId: string): void {
  const lane = lanes.get(sessionId);
  if (!lane) return;
  const next = lane.waiters.shift();
  if (next) { next.start(); return; }
  lane.running = false;
  lanes.delete(sessionId);
}

/**
 * Drop the `message` turns waiting behind the running one — given `owner`,
 * only that user's. Returns how many were dropped; each rejects with
 * `SessionTurnCancelledError`. The running turn is untouched (stop its agents
 * for that).
 */
export function cancelQueuedTurns(sessionId: string, options: { owner?: string; reason?: string } = {}): number {
  const lane = lanes.get(sessionId);
  if (!lane?.waiters.length) return 0;
  const dropped = lane.waiters.filter(w => w.kind === 'message' && (!options.owner || w.owner === options.owner));
  if (!dropped.length) return 0;
  lane.waiters = lane.waiters.filter(w => !dropped.includes(w));
  for (const waiter of dropped) waiter.cancel(new SessionTurnCancelledError(sessionId, options.reason));
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
