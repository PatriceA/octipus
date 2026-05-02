-- Multi-user Phase 0 — additive, non-breaking ownership columns.
--
-- Adds nullable ownership columns to the tables that today are
-- effectively global (RAG embeddings, agent events, swarm nodes, hook
-- executions) and a nullable org grouping to users. Phase 0 leaves
-- these nullable so existing rows stay valid; Phase 1 backfills,
-- enforces NOT NULL where appropriate, and starts filtering reads.
--
-- Every statement is idempotent so re-running this migration on a
-- partially-applied database is safe.

ALTER TABLE "embeddings"      ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "agent_events"    ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "swarm_nodes"     ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "hook_executions" ADD COLUMN IF NOT EXISTS "user_id" uuid;
ALTER TABLE "users"           ADD COLUMN IF NOT EXISTS "org_id" uuid;

CREATE INDEX IF NOT EXISTS "embeddings_user_id_idx"      ON "embeddings"      ("user_id");
CREATE INDEX IF NOT EXISTS "agent_events_user_id_idx"    ON "agent_events"    ("user_id");
CREATE INDEX IF NOT EXISTS "swarm_nodes_user_id_idx"     ON "swarm_nodes"     ("user_id");
CREATE INDEX IF NOT EXISTS "hook_executions_user_id_idx" ON "hook_executions" ("user_id");

-- Audit middleware (shadow mode) writes one row per state-changing API
-- call with action='api_request'. Adding the enum value is idempotent.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'api_request';
