/**
 * Task wakeup bridge — carries dependency wakeups (./wakeups.ts) between
 * server processes that share one Postgres database.
 *
 * Out: the bridge is the wakeup bus's publisher (`setWakeupPublisher`).
 * After `dispatchWakeups` has emitted locally, the events go out with
 * `pg_notify('octipus_task_wakeups', payload)`. The payload carries ids
 * only — kind, owner, workspace, woken task, triggering task, cause — plus
 * the sender's process id, and is split so no one NOTIFY exceeds
 * `MAX_PAYLOAD_BYTES` (Postgres refuses payloads of 8000 bytes or more).
 *
 * In: every process LISTENs on the channel through the shared LISTEN
 * connection of db/task-state-listener.ts (`subscribeChannel`, which also
 * re-LISTENs after a reconnect). A payload from this very process is
 * dropped — its events were emitted here already. Any other is decoded,
 * the woken tasks' titles re-read in one query, and each event re-emitted
 * on the local bus with `remote: true`.
 *
 * Once cluster-wide: the originating process files the notification and
 * runs the DB-writing listeners; a remote event is for in-memory reactions
 * only (core/heartbeat.ts's `onRoleTaskWakeup` ignores it).
 *
 * Embedded PGlite is single-process: `startTaskWakeupBridge` does nothing
 * there and the wakeup bus behaves exactly as without the bridge.
 */
import { randomUUID } from 'node:crypto';
import { coreLogger } from '@/utils/logger';
import {
  emitSafely,
  setWakeupPublisher,
  TASK_WAKEUP_TYPES,
  type TaskWakeupEvent,
  type TaskWakeupType,
  type WakeupCause,
} from './wakeups';

export const TASK_WAKEUP_CHANNEL = 'octipus_task_wakeups';

/** Largest payload one NOTIFY carries; well under Postgres's 8000-byte limit. */
export const MAX_PAYLOAD_BYTES = 4000;

/** This process's id on the channel, to recognise (and skip) its own notifications. */
export const PROCESS_ORIGIN = randomUUID();

/** How the bridge talks to the database; a fake in tests. */
export interface WakeupTransport {
  notify(channel: string, payload: string): Promise<void>;
  /** Start listening; resolves to the unsubscribe function. */
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
}

/** Woken task id → title, for the ids a remote payload names (missing ids are fine). */
export type TitleResolver = (taskIds: string[]) => Promise<Map<string, string>>;

/** One event on the wire: ids only, short keys. */
interface WireEvent {
  k: 'u' | 'c';
  u: string;
  w: string | null;
  t: string;
  b: string;
  c: WakeupCause;
}

interface WirePayload {
  v: 1;
  o: string;
  e: WireEvent[];
}

const KIND_TO_WIRE: Record<TaskWakeupType, WireEvent['k']> = { 'task.unblocked': 'u', 'task.children_completed': 'c' };
const WIRE_TO_KIND: Record<WireEvent['k'], TaskWakeupType> = { u: 'task.unblocked', c: 'task.children_completed' };

function toWire(e: TaskWakeupEvent): WireEvent {
  return { k: KIND_TO_WIRE[e.type], u: e.userId, w: e.workspaceId, t: e.taskId, b: e.triggeredBy, c: e.cause };
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * The NOTIFY payloads for `events`, each at most `maxBytes`. Events are
 * packed in order; an event too large on its own (never, with uuids) is
 * dropped and logged rather than sent over the limit.
 */
export function encodeWakeups(origin: string, events: readonly TaskWakeupEvent[], maxBytes = MAX_PAYLOAD_BYTES): string[] {
  const out: string[] = [];
  let batch: WireEvent[] = [];
  const serialise = (e: WireEvent[]) => JSON.stringify({ v: 1, o: origin, e } satisfies WirePayload);
  for (const event of events) {
    const wire = toWire(event);
    if (bytes(serialise([...batch, wire])) <= maxBytes) {
      batch.push(wire);
      continue;
    }
    if (batch.length > 0) out.push(serialise(batch));
    batch = [wire];
    if (bytes(serialise(batch)) > maxBytes) {
      coreLogger.warn({ taskId: event.taskId }, 'Task wakeup too large for NOTIFY; not sent to other processes');
      batch = [];
    }
  }
  if (batch.length > 0) out.push(serialise(batch));
  return out;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Parse a payload; null when it is not one of ours or is malformed. Events without a title yet. */
export function decodeWakeups(payload: string): { origin: string; events: Omit<TaskWakeupEvent, 'title'>[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const p = parsed as Partial<WirePayload> | null;
  if (!p || p.v !== 1 || !isStr(p.o) || !Array.isArray(p.e)) return null;
  const events: Omit<TaskWakeupEvent, 'title'>[] = [];
  for (const raw of p.e as unknown[]) {
    const e = raw as Partial<WireEvent> | null;
    if (!e || (e.k !== 'u' && e.k !== 'c') || !isStr(e.u) || !isStr(e.t) || !isStr(e.b)) continue;
    if (e.c !== 'closed' && e.c !== 'deleted') continue;
    if (e.w !== null && !isStr(e.w)) continue;
    const type = WIRE_TO_KIND[e.k];
    if (!TASK_WAKEUP_TYPES.includes(type)) continue;
    events.push({ type, userId: e.u, workspaceId: e.w ?? null, taskId: e.t, triggeredBy: e.b, cause: e.c });
  }
  return { origin: p.o, events };
}

/**
 * Handle one received payload: skip our own, re-read titles, re-emit
 * locally as remote events. Returns what it emitted (tests).
 */
export async function receiveWakeups(payload: string, origin: string, resolveTitles: TitleResolver): Promise<TaskWakeupEvent[]> {
  const decoded = decodeWakeups(payload);
  if (!decoded) {
    coreLogger.warn({ payload: payload.slice(0, 200) }, 'Task wakeup bridge: dropped malformed payload');
    return [];
  }
  if (decoded.origin === origin || decoded.events.length === 0) return [];
  let titles = new Map<string, string>();
  try {
    titles = await resolveTitles([...new Set(decoded.events.map((e) => e.taskId))]);
  } catch (err) {
    coreLogger.warn({ err }, 'Task wakeup bridge: title lookup failed (emitting without titles)');
  }
  const events = decoded.events.map((e): TaskWakeupEvent => ({ ...e, title: titles.get(e.taskId) ?? '', remote: true }));
  for (const event of events) emitSafely(event);
  return events;
}

// ── Default (Postgres) transport and titles ────────────────────────────

async function postgresTransport(): Promise<WakeupTransport> {
  const { getDb } = await import('@/db/postgres');
  const { sql } = await import('drizzle-orm');
  const { subscribeChannel } = await import('@/db/task-state-listener');
  return {
    notify: async (channel, payload) => {
      await getDb().execute(sql`SELECT pg_notify(${channel}, ${payload})`);
    },
    listen: subscribeChannel,
  };
}

async function defaultResolveTitles(taskIds: string[]): Promise<Map<string, string>> {
  const { getDb } = await import('@/db/postgres');
  const { inArray } = await import('drizzle-orm');
  const { tasks } = await import('@/db/schema/tasks');
  const rows = await getDb().select({ id: tasks.id, title: tasks.title }).from(tasks).where(inArray(tasks.id, taskIds));
  return new Map(rows.map((r) => [r.id, r.title]));
}

// ── Lifecycle ──────────────────────────────────────────────────────────

let unlisten: (() => Promise<void>) | null = null;
let starting: Promise<boolean> | null = null;

export interface BridgeOptions {
  transport?: WakeupTransport;
  origin?: string;
  resolveTitles?: TitleResolver;
}

/**
 * Start the bridge (server startup, next to `startRoleHeartbeatWakeups`).
 * Without a transport it runs only when this process can LISTEN, i.e. on
 * external Postgres; on PGlite it returns false and changes nothing.
 * Idempotent. The publisher is set only once the LISTEN is up, so a
 * process never sends what it could not also hear.
 */
export function startTaskWakeupBridge(opts: BridgeOptions = {}): Promise<boolean> {
  starting ??= (async () => {
    let transport = opts.transport;
    if (!transport) {
      const { listenAvailable } = await import('@/db/task-state-listener');
      if (!listenAvailable()) return false;
      transport = await postgresTransport();
    }
    const origin = opts.origin ?? PROCESS_ORIGIN;
    const resolveTitles = opts.resolveTitles ?? defaultResolveTitles;
    const t = transport;
    unlisten = await t.listen(TASK_WAKEUP_CHANNEL, (payload) => {
      receiveWakeups(payload, origin, resolveTitles).catch((err) =>
        coreLogger.error({ err }, 'Task wakeup bridge: receive failed'));
    });
    setWakeupPublisher(async (events) => {
      for (const payload of encodeWakeups(origin, events)) await t.notify(TASK_WAKEUP_CHANNEL, payload);
    });
    coreLogger.info({ channel: TASK_WAKEUP_CHANNEL }, 'Task wakeup bridge listening');
    return true;
  })().catch((err: unknown) => {
    starting = null;
    throw err;
  });
  return starting;
}

/** Stop the bridge (shutdown, tests). Idempotent. */
export async function stopTaskWakeupBridge(): Promise<void> {
  const pendingStart = starting;
  starting = null;
  if (pendingStart) await pendingStart.catch(() => false);
  setWakeupPublisher(null);
  const u = unlisten;
  unlisten = null;
  if (u) {
    try {
      await u();
    } catch (err) {
      coreLogger.warn({ err }, 'Task wakeup bridge: UNLISTEN failed (non-fatal)');
    }
  }
}
