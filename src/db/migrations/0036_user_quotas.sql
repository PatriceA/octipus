-- Phase 3c-1 — per-user quota overrides.
--
-- One row per user that has had ANY quota explicitly set. Missing
-- rows mean "inherit the global default" (config.agent.*,
-- config.api.rateLimitMax). Each column is independently nullable
-- so an admin can override one cap without touching the others.
--
-- This commit ships the schema + read-side helpers + admin UI.
-- Phase 3c-2 wires enforcement into the agent worker (concurrency
-- + token budget) and rate-limiter (per-user request rate).

CREATE TABLE IF NOT EXISTS "user_quotas" (
  "user_id"                 uuid       PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "max_concurrent_agents"   integer,
  "max_tokens_per_day"      integer,
  "max_api_calls_per_minute" integer,
  "created_at"              timestamp  NOT NULL DEFAULT now(),
  "updated_at"              timestamp  NOT NULL DEFAULT now()
);

-- The table is small (one row per overridden user) and read on
-- every quota check; the PK on user_id is the only access pattern,
-- so no extra indexes.

-- RLS — same "bypass on missing GUC" pattern as 0034/0035.
-- Users can read their own quota row; admins go through withRlsBypass.
ALTER TABLE "user_quotas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_quotas" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_quotas_owner_policy ON "user_quotas";
CREATE POLICY user_quotas_owner_policy ON "user_quotas"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );
