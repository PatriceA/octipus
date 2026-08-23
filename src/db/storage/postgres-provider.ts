/**
 * Postgres-backed StorageProvider — the external mode.
 *
 * Replaces Valkey. The system of record is already Postgres and already runs
 * everywhere Octipus runs, so a second stateful service was buying key expiry,
 * an ordered list and a pub/sub fan-out that Postgres has: a TTL column and a
 * sweep, `FOR UPDATE SKIP LOCKED`, and `LISTEN`/`NOTIFY`.
 *
 * Three behaviours worth stating because they are not free:
 *
 *  - Expiry is enforced on read as well as by the sweep, so an expired key is
 *    never returned even in the window before the sweep runs. The sweep exists
 *    to reclaim space, not to define correctness.
 *  - `pop()` is `FOR UPDATE SKIP LOCKED` inside a transaction, so two workers
 *    popping at once take different rows rather than blocking or double-taking.
 *  - `LISTEN` pins a connection for as long as the subscription lives, so it
 *    runs on a dedicated client rather than the query pool — the same reason
 *    `task-state-listener.ts` owns its own connection.
 *
 * ponytail: the cache sweep is a 60s interval, not a per-key timer. Ceiling —
 * expired rows occupy space for up to a minute past their TTL, which is
 * invisible to callers because reads filter on `expires_at`. Upgrade path: a
 * partial index on `expires_at` if the table ever grows enough to notice.
 */
import { getConfig } from '@/config';
import { queryRaw } from '@/db/postgres';
import { dbLogger } from '@/utils/logger';
import type { CacheProvider, PubSubProvider, QueueProvider, StorageProvider } from './types';

const SWEEP_INTERVAL_MS = 60_000;

/** A `LISTEN`-capable client, kept separate from the query pool. */
type ListenClient = {
  listen: (channel: string, onPayload: (payload: string) => void) => Promise<{ unlisten: () => Promise<void> }>;
  notify: (channel: string, payload: string) => Promise<unknown>;
  end: () => Promise<void>;
};

/**
 * Postgres channel names are identifiers: 63 bytes, and case-folded unless
 * quoted. Anything outside that is hashed rather than truncated, because two
 * long channel names sharing a prefix must not collapse into one.
 */
function channelIdentifier(channel: string): string {
  const safe = channel.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
  if (safe.length <= 63 && safe === channel.toLowerCase()) return safe;
  let hash = 0;
  for (let i = 0; i < channel.length; i++) hash = (hash * 31 + channel.charCodeAt(i)) | 0;
  return `${safe.slice(0, 50)}_${(hash >>> 0).toString(36)}`;
}

export class PostgresStorageProvider implements StorageProvider {
  readonly mode = 'external' as const;
  private sweepInterval: ReturnType<typeof setInterval>;
  private listenClient: ListenClient | null = null;
  private subscriptions = new Map<string, { handlers: Set<(m: unknown) => void>; unlisten: () => Promise<void> }>();

  constructor() {
    this.sweepInterval = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    // Reclaiming space must never hold the process open on its own.
    this.sweepInterval.unref?.();
    dbLogger.info('Postgres storage provider initialized');
  }

  private async sweep(): Promise<void> {
    try {
      await queryRaw('DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at <= now()');
    } catch (err) {
      dbLogger.warn({ err }, 'kv sweep failed (non-fatal)');
    }
  }

  createCache(prefix: string, defaultTtl = 3600): CacheProvider {
    const p = prefix ? `${prefix}:` : '';
    return {
      async get<T>(key: string): Promise<T | null> {
        const raw = await readKey(p + key);
        if (raw === null) return null;
        try { return JSON.parse(raw) as T; } catch { return raw as unknown as T; }
      },
      async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
        const ttl = ttlSeconds ?? defaultTtl;
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        await writeKey(p + key, serialized, ttl);
      },
      async delete(key: string): Promise<void> { await deleteKey(p + key); },
      async exists(key: string): Promise<boolean> { return (await readKey(p + key)) !== null; },
      async increment(key: string, by = 1): Promise<number> {
        // One statement, so two concurrent increments cannot read the same
        // value and both write it back — the counter is the whole point.
        const { rows } = await queryRaw(
          `INSERT INTO kv_store (key, value, expires_at)
           VALUES ($1, $2::text, NULL)
           ON CONFLICT (key) DO UPDATE SET
             value = (CASE
               WHEN kv_store.expires_at IS NOT NULL AND kv_store.expires_at <= now() THEN 0
               ELSE COALESCE(NULLIF(regexp_replace(kv_store.value, '[^0-9-]', '', 'g'), '')::bigint, 0)
             END + $2::bigint)::text,
             expires_at = CASE
               WHEN kv_store.expires_at IS NOT NULL AND kv_store.expires_at <= now() THEN NULL
               ELSE kv_store.expires_at
             END
           RETURNING value`,
          [p + key, String(by)],
        );
        return Number(rows[0]?.value ?? by);
      },
      async expire(key: string, ttlSeconds: number): Promise<void> {
        await queryRaw(
          `UPDATE kv_store SET expires_at = now() + make_interval(secs => $2) WHERE key = $1`,
          [p + key, ttlSeconds],
        );
      },
      async ttl(key: string): Promise<number> {
        const { rows } = await queryRaw(
          `SELECT expires_at FROM kv_store
           WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
          [p + key],
        );
        if (rows.length === 0) return -2; // absent, as the previous backend reported it
        const expiresAt = rows[0].expires_at ?? rows[0].expiresAt;
        if (!expiresAt) return -1; // present, no expiry
        const remaining = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000);
        return remaining > 0 ? remaining : -2;
      },
    };
  }

  createQueue(name: string): QueueProvider {
    return {
      async push(item: unknown, priority = 0): Promise<void> {
        // Same ordering key the previous backend used: time, pulled forward a
        // second per priority point, so a higher priority sorts earlier.
        const score = Date.now() - priority * 1000;
        await queryRaw(
          'INSERT INTO kv_queue (queue, score, payload) VALUES ($1, $2, $3)',
          [name, score, JSON.stringify(item)],
        );
      },
      async pop(): Promise<unknown | null> {
        const { rows } = await queryRaw(
          `DELETE FROM kv_queue WHERE id = (
             SELECT id FROM kv_queue WHERE queue = $1
             ORDER BY score ASC, id ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           ) RETURNING payload`,
          [name],
        );
        if (rows.length === 0) return null;
        return parsePayload(rows[0].payload);
      },
      async peek(): Promise<unknown | null> {
        const { rows } = await queryRaw(
          'SELECT payload FROM kv_queue WHERE queue = $1 ORDER BY score ASC, id ASC LIMIT 1',
          [name],
        );
        if (rows.length === 0) return null;
        return parsePayload(rows[0].payload);
      },
      async length(): Promise<number> {
        const { rows } = await queryRaw('SELECT count(*)::int AS n FROM kv_queue WHERE queue = $1', [name]);
        return Number(rows[0]?.n ?? 0);
      },
      async clear(): Promise<void> {
        await queryRaw('DELETE FROM kv_queue WHERE queue = $1', [name]);
      },
    };
  }

  createPubSub(): PubSubProvider {
    return {
      publish: (channel, message) => this.publish(channel, message),
      subscribe: (channel, handler) => this.subscribe(channel, handler),
      unsubscribe: (channel, handler) => this.unsubscribe(channel, handler),
    };
  }

  private async getListenClient(): Promise<ListenClient> {
    if (this.listenClient) return this.listenClient;
    const postgresMod = await import('postgres');
    const postgres = postgresMod.default;
    const config = getConfig();
    this.listenClient = postgres(config.database.url, {
      max: 1,
      idle_timeout: 0,
      connect_timeout: config.database.connectionTimeout / 1000,
      prepare: false,
    }) as unknown as ListenClient;
    return this.listenClient;
  }

  private async publish(channel: string, message: unknown): Promise<void> {
    const serialized = typeof message === 'string' ? message : JSON.stringify(message);
    const client = await this.getListenClient();
    // NOTIFY's payload limit is 8000 bytes. Rather than fail or silently drop,
    // spill the body into the kv table and send its key — a subscriber that
    // gets a spill marker reads the row. The alternative, an 8KB ceiling that
    // shows up only under a big message in production, is the worse failure.
    if (Buffer.byteLength(serialized, 'utf8') > 7000) {
      const key = `pubsub:spill:${channel}:${Date.now()}:${Math.trunc(performance.now() * 1000)}`;
      await writeKey(key, serialized, 300);
      await client.notify(channelIdentifier(channel), JSON.stringify({ __spill: key }));
      return;
    }
    await client.notify(channelIdentifier(channel), serialized);
  }

  private async subscribe(channel: string, handler: (message: unknown) => void): Promise<void> {
    const name = channelIdentifier(channel);
    const existing = this.subscriptions.get(name);
    if (existing) {
      existing.handlers.add(handler);
      return;
    }
    const handlers = new Set([handler]);
    const client = await this.getListenClient();
    const sub = await client.listen(name, (payload) => {
      void dispatch(handlers, payload);
    });
    this.subscriptions.set(name, { handlers, unlisten: sub.unlisten });
  }

  private async unsubscribe(channel: string, handler?: (message: unknown) => void): Promise<void> {
    const name = channelIdentifier(channel);
    const entry = this.subscriptions.get(name);
    if (!entry) return;
    if (handler) entry.handlers.delete(handler);
    else entry.handlers.clear();
    if (entry.handlers.size === 0) {
      this.subscriptions.delete(name);
      try { await entry.unlisten(); } catch { /* connection already gone */ }
    }
  }

  async getRaw(key: string): Promise<string | null> { return readKey(key); }
  async setRaw(key: string, value: string, ttlSeconds?: number): Promise<void> { await writeKey(key, value, ttlSeconds ?? 0); }
  async delRaw(key: string): Promise<void> { await deleteKey(key); }

  async ping(): Promise<boolean> {
    await queryRaw('SELECT 1');
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.sweepInterval);
    for (const entry of this.subscriptions.values()) {
      try { await entry.unlisten(); } catch { /* already gone */ }
    }
    this.subscriptions.clear();
    if (this.listenClient) {
      try { await this.listenClient.end(); } catch { /* already gone */ }
      this.listenClient = null;
    }
    dbLogger.info('Postgres storage provider closed');
  }
}

async function dispatch(handlers: Set<(m: unknown) => void>, payload: string): Promise<void> {
  let message: unknown;
  try { message = JSON.parse(payload); } catch { message = payload; }
  if (message && typeof message === 'object' && '__spill' in (message as Record<string, unknown>)) {
    const key = (message as { __spill: string }).__spill;
    const raw = await readKey(key);
    if (raw === null) return; // the spill expired — the message is gone, not wrong
    try { message = JSON.parse(raw); } catch { message = raw; }
  }
  for (const handler of handlers) {
    // One throwing subscriber must not stop the others, and must not take the
    // LISTEN connection down with it.
    try { handler(message); } catch (err) { dbLogger.warn({ err }, 'pubsub subscriber threw'); }
  }
}

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { return payload; }
}

async function readKey(key: string): Promise<string | null> {
  const { rows } = await queryRaw(
    'SELECT value FROM kv_store WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())',
    [key],
  );
  return rows.length > 0 ? String(rows[0].value) : null;
}

async function writeKey(key: string, value: string, ttlSeconds: number): Promise<void> {
  await queryRaw(
    `INSERT INTO kv_store (key, value, expires_at)
     VALUES ($1, $2, CASE WHEN $3::int > 0 THEN now() + make_interval(secs => $3::int) ELSE NULL END)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
    [key, value, ttlSeconds],
  );
}

async function deleteKey(key: string): Promise<void> {
  await queryRaw('DELETE FROM kv_store WHERE key = $1', [key]);
}
