/**
 * Memory-redesign Phase B.2 — long-lived LISTEN subscriber for the
 * `task_state_<session_id>` NOTIFY channels installed by migration
 * 0050. Lets in-process callers react to sibling-agent completions
 * without polling.
 *
 * Why a separate module (not just `getDb().listen()`)
 * ──────────────────────────────────────────────────
 * `LISTEN` ties up a Postgres connection for the duration of the
 * subscription, so it must run on a dedicated connection separate
 * from the query pool — otherwise the pool gradually loses slots
 * every time someone subscribes. This module owns that one connection.
 *
 * What it provides
 * ────────────────
 *   subscribeTaskState(sessionId, handler) → unsubscribe()
 *   subscribeChannel(channel, rawHandler) → unsubscribe() — any channel
 *     on the same connection (the task wakeup bridge uses it)
 *
 * The handler is called with the JSON payload published by the
 * `task_state_notify` trigger:
 *   { id, status, owner, task_kind, updated_at }
 *
 * Reference counting: multiple subscribers on the same `sessionId`
 * share one upstream `LISTEN`. The last `unsubscribe()` for a
 * channel issues `UNLISTEN`. The shared connection is left open for
 * future subscribers — closing and reopening on every empty
 * subscriber list would churn the connection during normal
 * session-bounce traffic.
 *
 * Reconnect / failure mode
 * ────────────────────────
 * postgres-js auto-reconnects on the underlying socket, and a
 * reconnected connection forgets its prior `LISTEN`s. postgres-js's
 * `listen()` keeps its own channel table and re-issues `LISTEN` for
 * every channel on reconnect (its `onclose` handler), so a
 * subscription here survives a dropped socket. Notifications sent
 * while the socket was down are lost: consumers must tolerate a miss.
 *
 * Embedded (PGlite) mode
 * ──────────────────────
 * PGlite does not implement LISTEN/NOTIFY in a way callers can
 * subscribe to from JS. In that mode the module short-circuits to
 * a no-op subscriber; readers that depend on notifications must
 * fall back to polling. This is the same trade-off the docs called
 * out for the rest of the runtime in embedded mode.
 */

import { getConfig } from '@/config';
import { storageMode } from '@/db/postgres';
import { dbLogger } from '@/utils/logger';

export interface TaskStateNotification {
  id: string;
  status: string;
  owner: string;
  task_kind: string;
  updated_at: string;
}

export type TaskStateHandler = (note: TaskStateNotification) => void;

/** A raw NOTIFY payload handler (see `subscribeChannel`). */
export type ChannelHandler = (payload: string) => void;

interface ChannelEntry {
  handlers: Set<ChannelHandler>;
  /** Returned by `sql.listen()`; calling it issues UNLISTEN. */
  cancel: (() => Promise<void>) | null;
  /** The first subscriber's LISTEN; later subscribers wait on it too. */
  ready: Promise<void> | null;
}

type PgClient = {
  listen: (
    channel: string,
    onPayload: (payload: string) => void,
    onSubscribed?: () => void,
  ) => Promise<{ unlisten: () => Promise<void> }>;
  end: () => Promise<void>;
};

let _client: PgClient | null = null;
const channels = new Map<string, ChannelEntry>();

function isEmbedded(): boolean {
  return storageMode() === 'embedded';
}

/**
 * True when this process can LISTEN (external Postgres). Embedded PGlite
 * is one process by nature: nothing to hear from, nothing to fan out to.
 */
export function listenAvailable(): boolean {
  return !isEmbedded();
}

async function getListenClient(): Promise<PgClient | null> {
  if (isEmbedded()) return null;
  if (_client) return _client;
  const postgresMod = await import('postgres');
  const postgres = postgresMod.default || (postgresMod as unknown as { default: typeof postgresMod.default }).default;
  const config = getConfig();
  // Dedicated single-connection client. `max: 1` keeps the LISTEN
  // pinned to one socket; `prepare: false` matches the main pool's
  // workaround for the Bun + postgres-js stale-prepare bug.
  const sql = (postgres as unknown as (url: string, opts: Record<string, unknown>) => PgClient)(config.database.url, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: config.database.connectionTimeout / 1000,
    prepare: false,
    // postgres-js fires `onnotice` for server NOTICE messages, not
    // pg_notify. Use it only for logging here.
    onnotice: (notice: unknown) => dbLogger.debug({ notice }, 'task-state-listener: PostgreSQL notice'),
  });
  _client = sql;
  return _client;
}

function channelName(sessionId: string): string {
  return `task_state_${sessionId}`;
}

/**
 * Subscribe to any NOTIFY channel with a raw-payload handler, sharing the
 * dedicated LISTEN connection and its ref-counting. Returns the
 * unsubscribe function; in embedded mode a no-op one (see module doc).
 * `subscribeTaskState` is built on it, and so is the cross-process task
 * wakeup bridge (core/tasks/wakeup-bridge.ts).
 */
export async function subscribeChannel(name: string, handler: ChannelHandler): Promise<() => Promise<void>> {
  const client = await getListenClient();
  if (!client) {
    dbLogger.debug({ channel: name }, 'task-state-listener: embedded mode, returning no-op subscription');
    return async () => {};
  }
  let entry = channels.get(name);
  if (!entry) {
    const created: ChannelEntry = { handlers: new Set(), cancel: null, ready: null };
    entry = created;
    channels.set(name, created);
    created.ready = client.listen(name, (payload) => dispatch(name, payload)).then(
      (sub) => { created.cancel = sub.unlisten; },
      (err: unknown) => {
        if (channels.get(name) === created) channels.delete(name);
        throw err;
      },
    );
  }
  entry.handlers.add(handler);
  try {
    await entry.ready;
  } catch (err) {
    entry.handlers.delete(handler);
    throw err;
  }

  let unsubscribed = false;
  return async () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const e = channels.get(name);
    if (!e) return;
    e.handlers.delete(handler);
    if (e.handlers.size === 0) {
      // Last subscriber: UNLISTEN and drop the channel record. The
      // dedicated client stays open for future subscribers — see
      // module doc for why we don't close on empty.
      channels.delete(name);
      try {
        if (e.cancel) await e.cancel();
      } catch (err) {
        dbLogger.warn({ err, channel: name }, 'task-state-listener: UNLISTEN failed (non-fatal)');
      }
    }
  };
}

/**
 * The typed layer for `task_state_*` channels: one raw subscription per
 * channel, one JSON.parse per notification, then the typed handlers. The
 * handler set dedupes: subscribing the same function twice registers it once.
 */
interface TaskStateEntry {
  handlers: Set<TaskStateHandler>;
  /** The raw subscription's unsubscribe, once LISTEN is up. */
  raw: Promise<() => Promise<void>>;
}

const taskStateChannels = new Map<string, TaskStateEntry>();

function dispatchTaskState(name: string, payload: string): void {
  const entry = taskStateChannels.get(name);
  if (!entry) return;
  let parsed: TaskStateNotification;
  try {
    parsed = JSON.parse(payload) as TaskStateNotification;
  } catch (err) {
    dbLogger.warn({ err, channel: name, payload }, 'task-state-listener: dropped malformed payload');
    return;
  }
  for (const h of [...entry.handlers]) {
    try {
      h(parsed);
    } catch (err) {
      dbLogger.warn({ err, channel: name }, 'task-state-listener: handler threw (non-fatal)');
    }
  }
}

export async function subscribeTaskState(
  sessionId: string,
  handler: TaskStateHandler,
): Promise<() => Promise<void>> {
  if (isEmbedded()) {
    // Embedded mode — no-op subscriber. Caller should poll.
    dbLogger.debug({ sessionId }, 'task-state-listener: embedded mode, returning no-op subscription');
    return async () => {};
  }
  const name = channelName(sessionId);
  let entry = taskStateChannels.get(name);
  if (!entry) {
    const created: TaskStateEntry = {
      handlers: new Set(),
      raw: subscribeChannel(name, (payload) => dispatchTaskState(name, payload)),
    };
    entry = created;
    taskStateChannels.set(name, created);
    created.raw.catch(() => {
      if (taskStateChannels.get(name) === created) taskStateChannels.delete(name);
    });
  }
  entry.handlers.add(handler);
  try {
    await entry.raw;
  } catch (err) {
    entry.handlers.delete(handler);
    throw err;
  }

  let unsubscribed = false;
  const current = entry;
  return async () => {
    if (unsubscribed) return;
    unsubscribed = true;
    current.handlers.delete(handler);
    if (current.handlers.size === 0 && taskStateChannels.get(name) === current) {
      taskStateChannels.delete(name);
      await (await current.raw)();
    }
  };
}

function dispatch(channel: string, payload: string): void {
  const entry = channels.get(channel);
  if (!entry) return;
  // Snapshot the handlers so a handler that unsubscribes itself
  // mid-dispatch doesn't mutate the set we're iterating.
  const handlers = [...entry.handlers];
  for (const h of handlers) {
    try {
      h(payload);
    } catch (err) {
      dbLogger.warn({ err, channel }, 'task-state-listener: handler threw (non-fatal)');
    }
  }
}

/**
 * Tear down all subscriptions and close the dedicated connection.
 * Called from the graceful-shutdown hook so the process exits cleanly.
 */
export async function shutdownTaskStateListener(): Promise<void> {
  for (const [, entry] of channels) {
    if (entry.cancel) {
      try { await entry.cancel(); } catch { /* swallow during shutdown */ }
    }
  }
  channels.clear();
  taskStateChannels.clear();
  if (_client) {
    try { await _client.end(); } catch { /* swallow */ }
    _client = null;
  }
}

/** Test-only: expose the channel bookkeeping. */
export function _channelsForTest(): ReadonlyMap<string, { handlerCount: number }> {
  const out = new Map<string, { handlerCount: number }>();
  for (const [k, v] of channels) out.set(k, { handlerCount: taskStateChannels.get(k)?.handlers.size ?? v.handlers.size });
  return out;
}
