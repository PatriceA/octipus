/**
 * The room queue (docs/plans/coworking-spec.md §6.4) — in memory, one
 * process (D16).
 *
 * A room runs one turn at a time. Addressed posts wait here as
 * `{ requesterId, messageId, enqueuedAt }`; the queue is the room's only
 * waiter, and hands the next request to its runner (which runs the turn
 * inside `withSessionTurn`) only after the previous turn finished. So:
 *
 * - cancelling a queued request just removes it here (`withSessionTurn` has
 *   no way to drop a waiter);
 * - a member has at most `rooms.maxQueuedPerMember` requests waiting;
 * - the runner re-checks the requester's access when the request is handed
 *   over (it may have been removed meanwhile);
 * - `/stop` stops the running turn (the requester's own turn, or anyone's
 *   for an editor+, who may also clear the queue): its abort signal fires —
 *   the runner checks it at handover, before the root agent spawns and
 *   before the answer is stored — and its agents are stopped. A stop names
 *   the turn it means (`expectedMessageId`), so a stop decided while one
 *   turn ran never ends the next one;
 * - the next turn goes to the oldest request of a member other than the
 *   one just answered, when there is one, so one member's queued requests
 *   do not hold everyone else back;
 * - a turn waiting on its requester's approval for longer than
 *   `rooms.approvalTimeoutMinutes` gives up: the request is expired through
 *   the permission or approval manager and the turn's agents are stopped,
 *   which ends the turn and frees the room;
 * - no agent of a room outlives its turn: whatever still runs in the room
 *   when the turn returns is stopped.
 *
 * Every change is announced to the room as `room.turn`.
 */
import { getConfig } from '@/config';
import { coreLogger } from '@/utils/logger';
import { publishRoomEvent } from './events';

export interface RoomRequest {
  requesterId: string;
  requesterName: string;
  messageId: string;
  enqueuedAt: Date;
  /**
   * What started the turn: a member asked (`room`), a listen probe (`listen`),
   * or a member of another install asked (`remote`, federation §7.5). Absent
   * means `room`.
   */
  trigger?: 'room' | 'listen' | 'remote';
  /** A `remote` turn: the install its requester acts through, for the per-install cap. */
  remoteInstanceId?: string;
}

/**
 * Runs one turn of the room for `request`; resolves when the turn is over.
 * `signal` fires when the turn is stopped: the runner must not start work
 * (or store an answer) once it has.
 */
export type RoomTurnRun = (request: RoomRequest, signal: AbortSignal) => Promise<void>;

interface Queued extends RoomRequest {
  run: RoomTurnRun;
}

interface Running extends RoomRequest {
  startedAt: Date;
  waiting: boolean;
  model?: string;
  abort: AbortController;
}

interface RoomState {
  workspaceId: string;
  running: Running | null;
  waiting: Queued[];
  draining: boolean;
}

export type RoomTurnState = 'queued' | 'started' | 'waiting' | 'done';
export type RoomTurnOutcome = 'success' | 'failed' | 'stopped' | 'cancelled' | 'dropped';

export class RoomQueueError extends Error {
  constructor(readonly code: 'queue_full' | 'not_found', message: string) {
    super(message);
    this.name = 'RoomQueueError';
  }
}

const rooms = new Map<string, RoomState>();

function stateOf(roomId: string, workspaceId: string): RoomState {
  let state = rooms.get(roomId);
  if (!state) {
    state = { workspaceId, running: null, waiting: [], draining: false };
    rooms.set(roomId, state);
  }
  return state;
}

function forget(roomId: string): void {
  const state = rooms.get(roomId);
  if (state && !state.running && state.waiting.length === 0 && !state.draining) rooms.delete(roomId);
}

/** What the room's turn strip shows. */
export interface RoomQueueSnapshot {
  running: { requesterId: string; requesterName: string; messageId: string; startedAt: string; waiting: boolean; model?: string } | null;
  queued: Array<{ requesterId: string; requesterName: string; messageId: string; enqueuedAt: string }>;
}

export function roomQueueSnapshot(roomId: string): RoomQueueSnapshot {
  const state = rooms.get(roomId);
  if (!state) return { running: null, queued: [] };
  return {
    running: state.running ? {
      requesterId: state.running.requesterId,
      requesterName: state.running.requesterName,
      messageId: state.running.messageId,
      startedAt: state.running.startedAt.toISOString(),
      waiting: state.running.waiting,
      ...(state.running.model ? { model: state.running.model } : {}),
    } : null,
    queued: state.waiting.map((q) => ({ requesterId: q.requesterId, requesterName: q.requesterName, messageId: q.messageId, enqueuedAt: q.enqueuedAt.toISOString() })),
  };
}

/** The requester of the room's running turn, or null. */
export function runningRequester(roomId: string): string | null {
  return rooms.get(roomId)?.running?.requesterId ?? null;
}

function announce(roomId: string, state: RoomTurnState, request: RoomRequest, extra: Record<string, unknown> = {}): void {
  publishRoomEvent(roomId, 'room.turn', {
    roomId,
    state,
    requesterId: request.requesterId,
    requesterName: request.requesterName,
    messageId: request.messageId,
    ...extra,
    queue: roomQueueSnapshot(roomId),
  });
}

/** Queued and running turns, in every room, started by members of install `instanceId`. */
export function remoteTurnsOf(instanceId: string): number {
  let n = 0;
  for (const state of rooms.values()) {
    if (state.running?.remoteInstanceId === instanceId) n++;
    for (const q of state.waiting) if (q.remoteInstanceId === instanceId) n++;
  }
  return n;
}

/**
 * Queue a turn for an addressed post. Returns the request's position (0 =
 * runs next). Throws `queue_full` when the member already has
 * `rooms.maxQueuedPerMember` requests waiting, or — for a `remote` turn —
 * when the members of its install already have
 * `federation.maxRemoteTurnsPerInstance` turns queued or running here.
 */
export function enqueueRoomTurn(roomId: string, workspaceId: string, request: RoomRequest, run: RoomTurnRun): { position: number } {
  if (request.trigger === 'remote' && !request.remoteInstanceId) throw new Error('A remote room turn names its install');
  const state = stateOf(roomId, workspaceId);
  const mine = state.waiting.filter((q) => q.requesterId === request.requesterId).length;
  const max = getConfig().rooms.maxQueuedPerMember;
  if (mine >= max) {
    forget(roomId);
    throw new RoomQueueError('queue_full', `You already have ${max} requests waiting in this room`);
  }
  if (request.remoteInstanceId) {
    const cap = getConfig().federation.maxRemoteTurnsPerInstance;
    if (remoteTurnsOf(request.remoteInstanceId) >= cap) {
      forget(roomId);
      throw new RoomQueueError('queue_full', `Members of your install already have ${cap} requests waiting or running on this install`);
    }
  }
  state.waiting.push({ ...request, run });
  const position = state.waiting.length - 1 + (state.running ? 1 : 0);
  announce(roomId, 'queued', request, { position });
  void drain(roomId);
  return { position };
}

async function drain(roomId: string): Promise<void> {
  const state = rooms.get(roomId);
  if (!state || state.draining) return;
  state.draining = true;
  try {
    let lastRequester: string | null = null;
    for (let next = takeNext(state, lastRequester); next; next = takeNext(state, lastRequester)) {
      const { run, ...request } = next;
      lastRequester = request.requesterId;
      const abort = new AbortController();
      state.running = { ...request, startedAt: new Date(), waiting: false, abort };
      announce(roomId, 'started', request);
      const stopWatch = watchApprovals(roomId, request);
      let outcome: RoomTurnOutcome = 'success';
      let error: string | undefined;
      try {
        await run(request, abort.signal);
        if (abort.signal.aborted) outcome = 'stopped';
      } catch (err) {
        outcome = abort.signal.aborted ? 'stopped' : err instanceof RoomTurnDropped ? 'dropped' : 'failed';
        // Every member reads `room.turn`: a dropped turn says why (its reasons
        // are written for the room); a failure says only that it failed — its
        // details are logged, and sent to the requester alone by the runner.
        if (outcome === 'dropped') error = (err as Error).message;
        if (outcome === 'failed') {
          error = `Octipus could not answer ${request.requesterName}`;
          coreLogger.error({ err, roomId, requesterId: request.requesterId }, 'Room turn failed');
        }
      } finally {
        stopWatch();
        await stopLeftovers(roomId);
        state.running = null;
      }
      announce(roomId, 'done', request, { outcome, ...(error ? { error } : {}) });
    }
  } finally {
    state.draining = false;
    forget(roomId);
  }
}

/**
 * The next request: the oldest one of a member other than `lastRequester`
 * (the member just answered), else the oldest.
 */
function takeNext(state: RoomState, lastRequester: string | null): Queued | undefined {
  const at = lastRequester ? state.waiting.findIndex((q) => q.requesterId !== lastRequester) : 0;
  return state.waiting.splice(at < 0 ? 0 : at, 1)[0];
}

/** Thrown by a runner that dropped its request at handover (access gone). */
export class RoomTurnDropped extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomTurnDropped';
  }
}

/** Agents of the room still running. */
async function roomAgents(roomId: string, userId?: string) {
  const { getAgentManager } = await import('@/core/agent-manager');
  const manager = getAgentManager();
  return {
    manager,
    agents: manager.getBySession(roomId).filter((a) => a.getStatus() === 'running' && (!userId || a.getContext().userId === userId)),
  };
}

/** No room agent survives its turn: stop whatever the turn left running. */
async function stopLeftovers(roomId: string): Promise<void> {
  const { manager, agents } = await roomAgents(roomId);
  for (const agent of agents) {
    coreLogger.warn({ roomId, agentId: agent.getContext().id }, 'Room agent outlived its turn; stopping it');
    manager.stop(agent.getContext().id, { cascade: true });
  }
}

/**
 * Stop the running turn — only the turn for `expectedMessageId`, the one
 * the caller decided about: a turn that started meanwhile is not touched.
 * Its abort signal fires (the runner stops before spawning or storing) and
 * its agents are stopped. Returns whether that turn was running. The caller
 * has checked `canActInSession(room, user, 'stop')`.
 */
export async function stopRoomTurn(roomId: string, expectedMessageId: string): Promise<boolean> {
  const running = rooms.get(roomId)?.running;
  if (!running || running.messageId !== expectedMessageId) return false;
  running.abort.abort(new Error('The room turn was stopped'));
  const { manager, agents } = await roomAgents(roomId);
  // Re-read after the await: only this turn's agents.
  if (rooms.get(roomId)?.running !== running) return true;
  for (const agent of agents) manager.stop(agent.getContext().id, { cascade: true });
  return true;
}

/** Drop every queued request of the room (editor+). Returns how many. */
export function clearRoomQueue(roomId: string): number {
  const state = rooms.get(roomId);
  if (!state) return 0;
  const dropped = state.waiting.splice(0);
  for (const request of dropped) announce(roomId, 'done', request, { outcome: 'cancelled' });
  forget(roomId);
  return dropped.length;
}

/**
 * Cancel the queued request for `messageId`. `mayCancelOthers` (editor+)
 * lets the caller cancel someone else's. Returns false when no such request
 * is waiting (already running, done, or not theirs).
 */
export function cancelQueuedTurn(roomId: string, messageId: string, userId: string, mayCancelOthers: boolean): boolean {
  const state = rooms.get(roomId);
  if (!state) return false;
  const at = state.waiting.findIndex((q) => q.messageId === messageId && (mayCancelOthers || q.requesterId === userId));
  if (at < 0) return false;
  const [request] = state.waiting.splice(at, 1);
  announce(roomId, 'done', request, { outcome: 'cancelled' });
  forget(roomId);
  return true;
}

/**
 * `userId` lost access to the room (or the space): drop their queued
 * requests and stop their running turn there. Returns what was dropped.
 */
export async function dropRoomTurnsOf(roomId: string, userId: string): Promise<{ queued: number; stopped: boolean }> {
  const state = rooms.get(roomId);
  if (!state) return { queued: 0, stopped: false };
  const dropped = state.waiting.filter((q) => q.requesterId === userId);
  state.waiting = state.waiting.filter((q) => q.requesterId !== userId);
  for (const request of dropped) announce(roomId, 'done', request, { outcome: 'dropped' });
  const running = state.running;
  const stopped = running?.requesterId === userId ? await stopRoomTurn(roomId, running.messageId) : false;
  forget(roomId);
  return { queued: dropped.length, stopped };
}

/**
 * `userId`'s account was deactivated: drop their queued requests and stop
 * their running turn in every room. Returns how many requests were dropped
 * and turns stopped.
 */
export async function dropAllRoomTurnsOf(userId: string): Promise<{ queued: number; stopped: number }> {
  const total = { queued: 0, stopped: 0 };
  const held = [...rooms.entries()]
    .filter(([, s]) => s.running?.requesterId === userId || s.waiting.some((q) => q.requesterId === userId))
    .map(([id]) => id);
  for (const roomId of held) {
    const dropped = await dropRoomTurnsOf(roomId, userId);
    total.queued += dropped.queued;
    if (dropped.stopped) total.stopped++;
  }
  return total;
}

/** Rooms with queued or running turns in `workspaceId` (for a membership change). */
export function activeRoomsIn(workspaceId: string): string[] {
  return [...rooms.entries()].filter(([, s]) => s.workspaceId === workspaceId).map(([id]) => id);
}

/**
 * The running turn of `roomId` raised an approval or permission request
 * (`waiting`), or got one answered. Announced as `room.turn` `waiting`.
 */
export function markRoomTurnWaiting(roomId: string, requesterId: string, waiting: boolean): void {
  const running = rooms.get(roomId)?.running;
  if (!running || running.requesterId !== requesterId || running.waiting === waiting) return;
  running.waiting = waiting;
  announce(roomId, waiting ? 'waiting' : 'started', running);
}

/** The running turn's model, once its root agent spawned. */
export function setRoomTurnModel(roomId: string, requesterId: string, model: string): void {
  const running = rooms.get(roomId)?.running;
  if (!running || running.requesterId !== requesterId || running.model === model) return;
  running.model = model;
  announce(roomId, running.waiting ? 'waiting' : 'started', running, { model });
}

// ── Approval timeout ──────────────────────────────────────────────

let checkEveryMs: number | null = null;

/** Test hook: how often a running turn's pending requests are checked. */
export function _setApprovalCheckIntervalForTests(ms: number | null): void {
  checkEveryMs = ms;
}

/**
 * While a turn runs, check its requester's pending requests in the room:
 * one older than `rooms.approvalTimeoutMinutes` is expired and the turn's
 * agents are stopped. Returns the stop function of the watch.
 */
function watchApprovals(roomId: string, request: RoomRequest): () => void {
  const timeoutMs = getConfig().rooms.approvalTimeoutMinutes * 60_000;
  const every = checkEveryMs ?? Math.min(60_000, timeoutMs);
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    expireStaleRequests(roomId, request.requesterId, timeoutMs, request.messageId)
      .catch((err: unknown) => coreLogger.error({ err, roomId }, 'Room approval timeout check failed'))
      .finally(() => { checking = false; });
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}

const TIMED_OUT = 'Nobody answered in time, so this room turn gave up.';

/**
 * Expire `requesterId`'s requests in the room older than `timeoutMs`; stop
 * their turn (`messageId`) when any. Returns how many.
 */
export async function expireStaleRequests(roomId: string, requesterId: string, timeoutMs: number, messageId: string): Promise<number> {
  const cutoff = Date.now() - timeoutMs;
  const [{ getAgentService }, { getPermissionManager }] = await Promise.all([
    import('@/core/agent'), import('@/security/permissions'),
  ]);
  const approvals = getAgentService().getPendingApprovals(requesterId)
    .filter((a) => a.sessionId === roomId && a.createdAt.getTime() <= cutoff);
  const permissions = (await getPermissionManager().getPendingRequests(requesterId))
    .filter((r) => r.sessionId === roomId && r.createdAt.getTime() <= cutoff);
  if (approvals.length === 0 && permissions.length === 0) return 0;
  let expired = 0;
  if (approvals.length > 0) expired += await getAgentService().expireApprovalsForUser(requesterId, TIMED_OUT, new Set([roomId]));
  if (permissions.length > 0) expired += await getPermissionManager().expireForUserInSession(requesterId, roomId);
  coreLogger.info({ roomId, requesterId, expired }, 'Room turn gave up waiting for an approval');
  await stopRoomTurn(roomId, messageId);
  return expired;
}

/** Test hook. */
export function _resetRoomQueuesForTests(): void {
  rooms.clear();
}
