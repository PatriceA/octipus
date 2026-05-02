-- Phase 3b-2 — extend RLS to the remaining user-owned tables.
--
-- Migration 0034 covered the highest-value tables (sessions, vault,
-- api_tokens, channel_identities). This migration finishes the sweep
-- with the same "bypass on missing GUC" pattern so existing code paths
-- stay non-disruptive while the wrapper from `src/security/rls.ts`
-- gradually takes over enforcement.
--
-- Three policy shapes:
--
--   1. Direct user_id (most tables) — same as 0034:
--        USING (bypass='true' OR user_id::text = current_setting(...))
--
--   2. messages — no user_id column; ownership lives on sessions:
--        USING (bypass='true' OR EXISTS (
--          SELECT 1 FROM sessions
--          WHERE sessions.id = messages.session_id
--          AND sessions.user_id::text = current_setting(...)))
--      Subqueries in policies cost more than direct comparisons, but
--      this is the natural shape for a strict child-by-FK relationship
--      and the messages.session_id column is already indexed.
--
--   3. pipeline_stages — same shape as messages but joining through
--      pipelines.user_id.
--
-- For columns that are nullable (added in Phase 0 as backwards-compat
-- columns: agent_events.user_id, embeddings.user_id,
-- hook_executions.user_id, swarm_nodes.user_id), rows with NULL
-- user_id never match the policy and become invisible without
-- bypass. That's intentional: orphan rows from pre-Phase-0 data
-- aren't accessible to per-user reads, but the system bypass path
-- (cron, reapers, compaction) sees them via withRlsBypass.

-- ── direct user_id, NOT NULL ─────────────────────────────────────
-- documents
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_owner_policy ON "documents";
CREATE POLICY documents_owner_policy ON "documents"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  );

-- agents (user_id text)
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agents_owner_policy ON "agents";
CREATE POLICY agents_owner_policy ON "agents"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  );

-- hooks
ALTER TABLE "hooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hooks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hooks_owner_policy ON "hooks";
CREATE POLICY hooks_owner_policy ON "hooks"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- pipelines
ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipelines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipelines_owner_policy ON "pipelines";
CREATE POLICY pipelines_owner_policy ON "pipelines"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- notifications
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_owner_policy ON "notifications";
CREATE POLICY notifications_owner_policy ON "notifications"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- trajectory_runs
ALTER TABLE "trajectory_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trajectory_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trajectory_runs_owner_policy ON "trajectory_runs";
CREATE POLICY trajectory_runs_owner_policy ON "trajectory_runs"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- recurring_tasks
ALTER TABLE "recurring_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recurring_tasks_owner_policy ON "recurring_tasks";
CREATE POLICY recurring_tasks_owner_policy ON "recurring_tasks"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- skill_permissions
ALTER TABLE "skill_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "skill_permissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skill_permissions_owner_policy ON "skill_permissions";
CREATE POLICY skill_permissions_owner_policy ON "skill_permissions"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- permission_requests
ALTER TABLE "permission_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "permission_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS permission_requests_owner_policy ON "permission_requests";
CREATE POLICY permission_requests_owner_policy ON "permission_requests"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- ── direct user_id, NULLABLE ────────────────────────────────────
-- These columns were added as nullable in Phase 0 for back-compat
-- with pre-Phase-0 data. Rows with NULL user_id are intentionally
-- invisible to per-user reads (NULL never matches the comparison);
-- system jobs see them via withRlsBypass.

-- agent_events
ALTER TABLE "agent_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_events_owner_policy ON "agent_events";
CREATE POLICY agent_events_owner_policy ON "agent_events"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  );

-- embeddings
ALTER TABLE "embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "embeddings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS embeddings_owner_policy ON "embeddings";
CREATE POLICY embeddings_owner_policy ON "embeddings"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- hook_executions
ALTER TABLE "hook_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hook_executions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hook_executions_owner_policy ON "hook_executions";
CREATE POLICY hook_executions_owner_policy ON "hook_executions"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- swarm_nodes
ALTER TABLE "swarm_nodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "swarm_nodes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS swarm_nodes_owner_policy ON "swarm_nodes";
CREATE POLICY swarm_nodes_owner_policy ON "swarm_nodes"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  );

-- ── ownership via FK subquery ───────────────────────────────────
-- messages (no user_id; lives on sessions)
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_owner_policy ON "messages";
CREATE POLICY messages_owner_policy ON "messages"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE sessions.id = messages.session_id
        AND sessions.user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM sessions
      WHERE sessions.id = messages.session_id
        AND sessions.user_id::text = current_setting('app.current_user_id', true)
    )
  );

-- pipeline_stages (no user_id; lives on pipelines)
ALTER TABLE "pipeline_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pipeline_stages_owner_policy ON "pipeline_stages";
CREATE POLICY pipeline_stages_owner_policy ON "pipeline_stages"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = pipeline_stages.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = pipeline_stages.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  );
