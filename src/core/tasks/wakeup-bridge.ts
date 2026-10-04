/**
 * Task wakeup bridge — carries dependency wakeups (./wakeups.ts) between
 * server processes that share one Postgres database.
 *
 * Out: the bridge is the wakeup bus's publisher (`setWakeupPublisher`).
 * After `dispatchWakeups` has emitted locally and filed its notifications,
 * the events go out, detached, with `pg_notify('octipus_task_wakeups',
 * payload)`. The payload carries ids only — kind, owner, workspace, woken
 * task, triggering task, cause — plus the sender's process id, and is split
 * so no one NOTIFY exceeds `MAX_PAYLOAD_BYTES` (Postgres refuses payloads of
 * 8000 bytes or more). Publishing needs only the query pool, so it works
 * from the moment the bridge starts, even while LISTEN is still retrying.
 *
 * In: every process LISTENs on the channel through the shared LISTEN
 * connection of db/task-state-listener.ts (`subscribeChannel`, which also
 * re-LISTENs after a reconnect). A LISTEN that fails at startup is retried
 * with backoff (5 s doubling to 5 min) until it succeeds. A payload from
 * this very process is dropped — its events were emitted here already. Any
 * other is decoded (every id must be a uuid), the woken tasks' titles are
 * re-read under their owner (an event whose task is not that owner's is
 * dropped), and each event is re-emitted on the local bus with
 * `remote: true`.
 *
 * Once cluster-wide: the originating process files the notification and
 * runs the DB-writing listeners; a remote event is for in-memory reactions
 * only (core/heartbeat.ts's `onRoleTaskWakeup` ignores it).
 *
 * Embedded PGlite is single-process: `startTaskWakeupBridge` does nothing
 * there and the wakeup bus behaves exactly as without the bridge.
 */
import { randomUUID } from 'node:crypto';
import { isUuid } from '@/db/repositories/scoped';
import { coreLogger } from '@/utils/logger';
import {
  emitSafely,
  setWakeupPublisher,
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

/**
 * A woken task as a remote payload names it. `workspaceId` is the scope it
 * is looked up in: a space's task by the space, a personal one by its owner
 * (docs/plans/coworking-spec.md §5.5).
 */
export interface TaskRef { taskId: string; userId: string; workspaceId?: string | null }

/** `titleKey(ref)` → title, for the refs whose task exists in its scope (the space, or that user's personal tasks). */
export type TitleResolver = (refs: TaskRef[]) => Promise<Map<string, string>>;

export const titleKey = (ref: TaskRef): string => `${ref.userId}/${ref.taskId}`;

/** One event on the wire: ids only, short keys. */
interface WireEvent {
  k: 'u' | 'c';
  u: string;
  w: string | null;
  t: string;
  b: string;
  c: WakeupCause;
}

const KIND_TO_WIRE: Record<TaskWakeupType, WireEvent['k']> = { 'task.unblocked': 'u', 'task.children_completed': 'c' };
const WIRE_TO_KIND: Record<WireEvent['k'], TaskWakeupType> = { u: 'task.unblocked', c: 'task.children_completed' };

function toWire(e: TaskWakeupEvent): WireEvent {
  return { k: KIND_TO_WIRE[e.type], u: e.userId, w: e.workspaceId, t: e.taskId, b: e.triggeredBy, c: e.cause };
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * The NOTIFY payloads for `events`, each at most `maxBytes`: the JSON
 * `{"v":1,"o":<origin>,"e":[…]}`, events packed in order. Sizes are summed
 * as it goes (each event serialised once). An event too large on its own
 * (never, with uuids) is dropped and logged rather than sent over the limit.
 */
export function encodeWakeups(origin: string, events: readonly TaskWakeupEvent[], maxBytes = MAX_PAYLOAD_BYTES): string[] {
  const prefix = `{"v":1,"o":${JSON.stringify(origin)},"e":[`;
  const suffix = ']}';
  const frame = bytes(prefix) + bytes(suffix);
  const out: string[] = [];
  let batch: string[] = [];
  let size = frame;
  const flush = () => {
    if (batch.length > 0) out.push(prefix + batch.join(',') + suffix);
    batch = [];
    size = frame;
  };
  for (const event of events) {
    const item = JSON.stringify(toWire(event));
    const itemBytes = bytes(item);
    if (frame + itemBytes > maxBytes) {
      coreLogger.warn({ taskId: event.taskId }, 'Task wakeup too large for NOTIFY; not sent to other processes');
      continue;
    }
    const added = itemBytes + (batch.length > 0 ? 1 : 0);
    if (size + added > maxBytes) flush();
    size += itemBytes + (batch.length > 0 ? 1 : 0);
    batch.push(item);
  }
  flush();
  return out;
}

const uuidOk = (v: unknown): v is string => typeof v === 'string' && isUuid(v);

/**
 * Parse a payload; null when it is not one of ours or is malformed. Events
 * with a bad kind, cause or any id that is not a uuid are dropped. Events
 * come without a title (the receiver re-reads it).
 */
export function decodeWakeups(payload: string): { origin: string; events: Omit<TaskWakeupEvent, 'title'>[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const p = parsed as { v?: unknown; o?: unknown; e?: unknown } | null;
  if (!p || p.v !== 1 || typeof p.o !== 'string' || p.o.length === 0 || p.o.length > 200 || !Array.isArray(p.e)) return null;
  const events: Omit<TaskWakeupEvent, 'title'>[] = [];
  for (const raw of p.e as unknown[]) {
    const e = raw as Partial<WireEvent> | null;
    if (!e || (e.k !== 'u' && e.k !== 'c')) continue;
    if (!uuidOk(e.u) || !uuidOk(e.t) || !uuidOk(e.b)) continue;
    if (e.c !== 'closed' && e.c !== 'deleted') continue;
    if (e.w !== null && !uuidOk(e.w)) continue;
    events.push({ type: WIRE_TO_KIND[e.k], userId: e.u, workspaceId: e.w, taskId: e.t, triggeredBy: e.b, cause: e.c });
  }
  return { origin: p.o, events };
}

/**
 * Handle one received payload: skip our own, re-read titles under each
 * event's owner, drop events whose task is not that owner's (or is gone),
 * re-emit the rest locally as remote events. Returns what it emitted.
 */
export async function receiveWakeups(payload: string, origin: string, resolveTitles: TitleResolver): Promise<TaskWakeupEvent[]> {
  const decoded = decodeWakeups(payload);
  if (!decoded) {
    coreLogger.warn({ payload: payload.slice(0, 200) }, 'Task wakeup bridge: dropped malformed payload');
    return [];
  }
  if (decoded.origin === origin || decoded.events.length === 0) return [];
  const refs = new Map<string, TaskRef>();
  for (const e of decoded.events) refs.set(titleKey(e), { taskId: e.taskId, userId: e.userId, workspaceId: e.workspaceId });
  let titles: Map<string, string>;
  try {
    titles = await resolveTitles([...refs.values()]);
  } catch (err) {
    // Ownership could not be checked: nothing is emitted.
    coreLogger.warn({ err }, 'Task wakeup bridge: title lookup failed; remote wakeups dropped');
    return [];
  }
  const events: TaskWakeupEvent[] = [];
  for (const e of decoded.events) {
    const title = titles.get(titleKey(e));
    if (title === undefined) {
      coreLogger.debug({ taskId: e.taskId, userId: e.userId }, 'Task wakeup bridge: task not found for its owner; dropped');
      continue;
    }
    events.push({ ...e, title, remote: true });
  }
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

/**
 * One query per scope: a space's tasks by `workspace_id = space` (any
 * member's), a personal task by `user_id = owner` and never one of a space.
 * A ref resolves only when its task is in the scope it names.
 */
async function defaultResolveTitles(refs: TaskRef[]): Promise<Map<string, string>> {
  const { getDb } = await import('@/db/postgres');
  const { and, eq, inArray } = await import('drizzle-orm');
  const { tasks } = await import('@/db/schema/tasks');
  const { workspaces } = await import('@/db/schema/organizations');
  const { notInSharedWorkspace } = await import('@/db/repositories/scoped');
  const out = new Map<string, string>();
  const named = [...new Set(refs.map((r) => r.workspaceId).filter((w): w is string => !!w))];
  const spaces = new Set(named.length === 0 ? [] : (await getDb()
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(inArray(workspaces.id, named), eq(workspaces.kind, 'shared')))).map((w) => w.id));
  const groups = new Map<string, { space: string | null; userId: string; refs: TaskRef[] }>();
  for (const r of refs) {
    const space = r.workspaceId && spaces.has(r.workspaceId) ? r.workspaceId : null;
    const key = space ? `space:${space}` : `user:${r.userId}`;
    const group = groups.get(key) ?? { space, userId: r.userId, refs: [] };
    group.refs.push(r);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ids = group.refs.map((r) => r.taskId);
    const scope = group.space ? eq(tasks.workspaceId, group.space) : and(eq(tasks.userId, group.userId), notInSharedWorkspace(tasks.workspaceId));
    const rows = await getDb()
      .select({ id: tasks.id, title: tasks.title, userId: tasks.userId })
      .from(tasks)
      .where(and(inArray(tasks.id, ids), scope));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const ref of group.refs) {
      const row = byId.get(ref.taskId);
      // The event names the woken task's owner; a row of someone else is not it.
      if (row && row.userId === ref.userId) out.set(titleKey(ref), row.title);
    }
  }
  return out;
}

// ── Lifecycle ──────────────────────────────────────────────────────────

export const LISTEN_RETRY_INITIAL_MS = 5_000;
export const LISTEN_RETRY_MAX_MS = 5 * 60_000;

interface BridgeState {
  unlisten: (() => Promise<void>) | null;
  retry: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

let state: BridgeState | null = null;

export interface BridgeOptions {
  transport?: WakeupTransport;
  origin?: string;
  resolveTitles?: TitleResolver;
  /** Backoff for a failing LISTEN (tests shorten it). */
  retryInitialMs?: number;
  retryMaxMs?: number;
}

/**
 * Start the bridge (server startup, next to `startRoleHeartbeatWakeups`).
 * Without a transport it runs only on external Postgres; on PGlite it
 * returns false and changes nothing. Publishing starts at once; LISTEN is
 * tried now and, while it fails, again with backoff (each failure logged).
 * Resolves once the first LISTEN attempt has settled. Idempotent.
 */
export async function startTaskWakeupBridge(opts: BridgeOptions = {}): Promise<boolean> {
  if (state) return true;
  let transport = opts.transport;
  if (!transport) {
    const { storageMode } = await import('@/db/postgres');
    if (storageMode() === 'embedded') return false;
    transport = await postgresTransport();
  }
  if (state) return true;
  const self: BridgeState = { unlisten: null, retry: null, stopped: false };
  state = self;
  const t = transport;
  const origin = opts.origin ?? PROCESS_ORIGIN;
  const resolveTitles = opts.resolveTitles ?? defaultResolveTitles;
  const initial = opts.retryInitialMs ?? LISTEN_RETRY_INITIAL_MS;
  const max = opts.retryMaxMs ?? LISTEN_RETRY_MAX_MS;

  setWakeupPublisher(async (events) => {
    for (const payload of encodeWakeups(origin, events)) await t.notify(TASK_WAKEUP_CHANNEL, payload);
  });

  const onPayload = (payload: string) => {
    receiveWakeups(payload, origin, resolveTitles).catch((err) =>
      coreLogger.error({ err }, 'Task wakeup bridge: receive failed'));
  };
  const attempt = async (delay: number): Promise<void> => {
    try {
      const unlisten = await t.listen(TASK_WAKEUP_CHANNEL, onPayload);
      if (self.stopped) {
        await unlisten().catch(() => {});
        return;
      }
      self.unlisten = unlisten;
      coreLogger.info({ channel: TASK_WAKEUP_CHANNEL }, 'Task wakeup bridge listening');
    } catch (err) {
      if (self.stopped) return;
      coreLogger.warn({ err, retryInMs: delay }, 'Task wakeup bridge: LISTEN failed; retrying (publishing continues)');
      self.retry = setTimeout(() => {
        self.retry = null;
        void attempt(Math.min(delay * 2, max));
      }, delay);
      self.retry.unref?.();
    }
  };
  await attempt(initial);
  return true;
}

/** Stop the bridge (shutdown, tests): no more publishing, retries or LISTEN. Idempotent. */
export async function stopTaskWakeupBridge(): Promise<void> {
  const s = state;
  state = null;
  if (!s) return;
  s.stopped = true;
  if (s.retry) clearTimeout(s.retry);
  setWakeupPublisher(null);
  if (s.unlisten) {
    try {
      await s.unlisten();
    } catch (err) {
      coreLogger.warn({ err }, 'Task wakeup bridge: UNLISTEN failed (non-fatal)');
    }
  }
}
