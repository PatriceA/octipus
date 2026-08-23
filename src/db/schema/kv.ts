import { bigint, bigserial, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The key-value store behind the cache, the raw get/set/del pairs and the
 * pub/sub spill. Replaces Valkey; see `src/db/storage/postgres-provider.ts`
 * for the semantics, in particular that expiry is enforced on read and the
 * sweep only reclaims space.
 */
export const kvStore = pgTable(
  'kv_store',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    /** NULL means no expiry, matching the previous backend's persist. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [index('kv_store_expires_at_idx').on(t.expiresAt)],
);

/**
 * The queue. `score` is the ordering key the previous backend's sorted set
 * used — wall-clock milliseconds pulled forward a second per priority point —
 * kept so relative ordering is unchanged.
 */
export const kvQueue = pgTable(
  'kv_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Insertion order — the FIFO tiebreak when two pushes share a `score`. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    queue: text('queue').notNull(),
    score: bigint('score', { mode: 'number' }).notNull(),
    payload: text('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('kv_queue_pop_idx').on(t.queue, t.score, t.seq)],
);

export type KvEntry = typeof kvStore.$inferSelect;
export type KvQueueItem = typeof kvQueue.$inferSelect;
