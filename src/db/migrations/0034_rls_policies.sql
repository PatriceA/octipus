-- Phase 3b — Row-Level Security policies on user-owned tables.
--
-- Defense-in-depth complement to `scopedRepos(principal)`. The
-- application-layer scope is the primary check; RLS catches anything
-- the scope might miss (forgotten WHERE, raw SQL, new untrusted code
-- path).
--
-- Pattern for every policy:
--
--   USING (
--     COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
--     OR <user_id check>
--   )
--
-- "Bypass on missing GUC" lets every code path that hasn't been wired
-- through `withRlsPrincipal()` continue to work. RLS only blocks reads
-- when both:
--   1. SET LOCAL app.bypass_rls = 'false'   (set by withRlsPrincipal)
--   2. SET LOCAL app.current_user_id = <uuid> (set by withRlsPrincipal)
-- ...and the row's user_id doesn't match.
--
-- FORCE ROW LEVEL SECURITY makes the policy apply even to the table
-- owner — important on Postgres where the migration role is the owner.
-- PGlite ignores all of this (single-superuser, RLS bypassed
-- structurally), so embedded installs see zero behavior change. The
-- migration syntax is still accepted on PGlite — it's just a no-op.
--
-- This first slice covers the highest-value tables: sessions, vault,
-- api_tokens, channel_identities. Other user-owned tables
-- (documents, agents, agent_events, embeddings, hooks, hook_executions,
-- pipelines, notifications, trajectory_runs, swarm_nodes,
-- recurring_tasks) follow in 3b-2 once the first slice has run in
-- staging.

-- ── sessions ────────────────────────────────────────────────────
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_owner_policy ON "sessions";
CREATE POLICY sessions_owner_policy ON "sessions"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- ── api_tokens ───────────────────────────────────────────────────
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_tokens_owner_policy ON "api_tokens";
CREATE POLICY api_tokens_owner_policy ON "api_tokens"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- ── channel_identities ──────────────────────────────────────────
ALTER TABLE "channel_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_identities" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_identities_owner_policy ON "channel_identities";
CREATE POLICY channel_identities_owner_policy ON "channel_identities"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- ── vault ───────────────────────────────────────────────────────
-- vault.user_id is `text` and uses the literal sentinel 'system' for
-- system-scoped rows. The policy compares text-to-text directly so
-- both UUID and 'system' values work without casts.
ALTER TABLE "vault" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "vault" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vault_owner_policy ON "vault";
CREATE POLICY vault_owner_policy ON "vault"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
    -- system-scoped rows are readable by any authenticated principal;
    -- the application-layer canAccessByName / allowed_tools enforce
    -- whether THIS principal can actually read the secret.
    OR scope = 'system'
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id = current_setting('app.current_user_id', true)
  );
