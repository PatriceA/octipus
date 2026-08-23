-- Phase 8 — retire Valkey.
--
-- Postgres is already the system of record and already runs wherever Octipus
-- runs, so the second stateful service was buying three things it has: key
-- expiry, an ordered list, and a pub/sub fan-out. These two tables cover the
-- first two; `LISTEN`/`NOTIFY` covers the third and needs no schema.
--
-- Expiry is enforced on READ (`expires_at IS NULL OR expires_at > now()`), not
-- by the sweep. The sweep reclaims space; it does not define correctness, so an
-- expired key is never returned even in the window before it runs.

CREATE TABLE IF NOT EXISTS "kv_store" (
  "key" text PRIMARY KEY,
  "value" text NOT NULL,
  -- NULL = no expiry, matching the previous backend's persisted keys.
  "expires_at" timestamp with time zone
);

-- The sweep's only query. Partial, because a row with no expiry is never swept
-- and indexing it would be pure write cost.
CREATE INDEX IF NOT EXISTS "kv_store_expires_at_idx"
  ON "kv_store" ("expires_at") WHERE "expires_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "kv_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order, and the tiebreak that makes the queue FIFO. `score` is
  -- wall-clock milliseconds, so two pushes in the same millisecond tie — and
  -- the only other column to break the tie with was a random uuid, which made
  -- same-millisecond ordering arbitrary rather than first-in-first-out.
  "seq" bigserial NOT NULL,
  "queue" text NOT NULL,
  -- The ordering key the previous sorted set used: wall-clock milliseconds
  -- pulled forward a second per priority point, so higher priority sorts first.
  "score" bigint NOT NULL,
  "payload" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Exactly the pop order, so `FOR UPDATE SKIP LOCKED` reads one index row rather
-- than sorting the queue on every pop.
CREATE INDEX IF NOT EXISTS "kv_queue_pop_idx" ON "kv_queue" ("queue", "score", "seq");
