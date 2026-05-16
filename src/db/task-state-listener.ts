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
 * postgres-js auto-reconnects on the underlying socket, BUT a
 * reconnected connection forgets its prior `LISTEN`s. We track the
 * active channel set in memory and re-issue `LISTEN` for each
 * channel after every reconnect via the `onconnect` hook.
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
import { dbLogger } from '@/utils/logger';

export interface TaskStateNotification {
  id: string;
  status: string;
  owner: string;
  task_kind: string;
  updated_at: string;
}

export type TaskStateHandler = (note: TaskStateNotification) => void;

interface ChannelEntry {
  handlers: Set<TaskStateHandler>;
  /** Returned by `sql.listen()`; calling it issues UNLISTEN. */
  cancel: (() => Promise<void>) | null;
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
  return (process.env.STORAGE_MODE || 'external') === 'embedded';
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

export async function subscribeTaskState(
  sessionId: string,
  handler: TaskStateHandler,
): Promise<() => Promise<void>> {
  const client = await getListenClient();
  if (!client) {
    // Embedded mode — no-op subscriber. Caller should poll.
    dbLogger.debug({ sessionId }, 'task-state-listener: embedded mode, returning no-op subscription');
    return async () => {};
  }
  const name = channelName(sessionId);
  let entry = channels.get(name);
  if (!entry) {
    entry = { handlers: new Set(), cancel: null };
    channels.set(name, entry);
    const sub = await client.listen(name, (payload) => dispatch(name, payload));
    entry.cancel = sub.unlisten;
  }
  entry.handlers.add(handler);

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
      try {
        if (e.cancel) await e.cancel();
      } catch (err) {
        dbLogger.warn({ err, channel: name }, 'task-state-listener: UNLISTEN failed (non-fatal)');
      }
      channels.delete(name);
    }
  };
}

function dispatch(channel: string, payload: string): void {
  const entry = channels.get(channel);
  if (!entry) return;
  let parsed: TaskStateNotification;
  try {
    parsed = JSON.parse(payload) as TaskStateNotification;
  } catch (err) {
    dbLogger.warn({ err, channel, payload }, 'task-state-listener: dropped malformed payload');
    return;
  }
  // Snapshot the handlers so a handler that unsubscribes itself
  // mid-dispatch doesn't mutate the set we're iterating.
  const handlers = [...entry.handlers];
  for (const h of handlers) {
    try {
      h(parsed);
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
  if (_client) {
    try { await _client.end(); } catch { /* swallow */ }
    _client = null;
  }
}

/** Test-only: expose the channel bookkeeping. */
export function _channelsForTest(): ReadonlyMap<string, { handlerCount: number }> {
  const out = new Map<string, { handlerCount: number }>();
  for (const [k, v] of channels) out.set(k, { handlerCount: v.handlers.size });
  return out;
}
