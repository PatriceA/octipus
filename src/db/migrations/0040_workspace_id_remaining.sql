-- Phase 4 follow-up — extend workspace_id to the remaining
-- user-owned tables.
--
-- Phase 4 (migration 0039) added workspace_id to sessions, documents,
-- and hooks. This migration completes the coverage for the rest of
-- the user-owned schema:
--
--   - agents
--   - notifications
--   - trajectory_runs
--   - pipelines
--   - embeddings
--   - agent_events
--   - swarm_nodes
--   - vault            (vault has its own scope enum; the column lets
--                       `scope='workspace'` rows narrow further)
--
-- All columns are nullable; FKs use ON DELETE SET NULL. NULL means
-- "user-level" (visible to every workspace owned by the user) — same
-- semantics as 0039. Re-runnable: every ALTER uses IF NOT EXISTS.

ALTER TABLE "agents"          ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "notifications"   ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "trajectory_runs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "pipelines"       ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "embeddings"      ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "agent_events"    ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "swarm_nodes"     ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;
ALTER TABLE "vault"           ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE SET NULL;

-- Per-table workspace_id index so range scans stay cheap once the
-- runtime starts filtering.
CREATE INDEX IF NOT EXISTS "agents_workspace_id_idx"          ON "agents"          ("workspace_id");
CREATE INDEX IF NOT EXISTS "notifications_workspace_id_idx"   ON "notifications"   ("workspace_id");
CREATE INDEX IF NOT EXISTS "trajectory_runs_workspace_id_idx" ON "trajectory_runs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "pipelines_workspace_id_idx"       ON "pipelines"       ("workspace_id");
CREATE INDEX IF NOT EXISTS "embeddings_workspace_id_idx"      ON "embeddings"      ("workspace_id");
CREATE INDEX IF NOT EXISTS "agent_events_workspace_id_idx"    ON "agent_events"    ("workspace_id");
CREATE INDEX IF NOT EXISTS "swarm_nodes_workspace_id_idx"     ON "swarm_nodes"     ("workspace_id");
CREATE INDEX IF NOT EXISTS "vault_workspace_id_idx"           ON "vault"           ("workspace_id");

-- Composite (user_id, workspace_id) — dominant query shape once
-- filtering is on. Skipped for tables that store user_id as text or
-- where the existing composite already serves.
CREATE INDEX IF NOT EXISTS "agents_user_id_workspace_id_idx"
  ON "agents" ("user_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "notifications_user_id_workspace_id_idx"
  ON "notifications" ("user_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "trajectory_runs_user_id_workspace_id_idx"
  ON "trajectory_runs" ("user_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "pipelines_user_id_workspace_id_idx"
  ON "pipelines" ("user_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "vault_user_id_workspace_id_idx"
  ON "vault" ("user_id", "workspace_id");
