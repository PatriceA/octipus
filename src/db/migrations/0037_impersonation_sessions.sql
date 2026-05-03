-- Phase 3d — admin impersonation.
--
-- One row per "act as" session opened by an admin. The auth-derive
-- middleware joins the admin's session token to this table; if an
-- active row exists (started_at set, ended_at NULL) the request is
-- treated as the target user but principal.actorUserId carries the
-- admin's id so audit can tag both sides.
--
-- One active session per admin at a time — re-issuing closes the
-- previous one (recorded as ended_by_replace). Prevents stacked
-- "act as" sessions that would obscure the audit trail.

CREATE TABLE IF NOT EXISTS "impersonation_sessions" (
  "id"                  uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_user_id"       uuid       NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "target_user_id"      uuid       NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "actor_session_hash"  text       NOT NULL,
  "started_at"          timestamp  NOT NULL DEFAULT now(),
  "expires_at"          timestamp  NOT NULL,
  "ended_at"            timestamp,
  "ended_reason"        text,
  "reason"              text,
  "ip_address"          inet
);

CREATE INDEX IF NOT EXISTS "impersonation_sessions_actor_idx"
  ON "impersonation_sessions" ("actor_user_id");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_target_idx"
  ON "impersonation_sessions" ("target_user_id");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_actor_hash_idx"
  ON "impersonation_sessions" ("actor_session_hash");
CREATE INDEX IF NOT EXISTS "impersonation_sessions_ended_at_idx"
  ON "impersonation_sessions" ("ended_at");

-- RLS — same "bypass on missing GUC" pattern. Both actor and target
-- can see their own row (the actor for the banner / stop button; the
-- target so they can see who is impersonating them in their audit
-- view, future Phase 3d-2 UI). Admins go through withRlsBypass for
-- the admin-console list view.
ALTER TABLE "impersonation_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "impersonation_sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS impersonation_sessions_party_policy ON "impersonation_sessions";
CREATE POLICY impersonation_sessions_party_policy ON "impersonation_sessions"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR actor_user_id::text = current_setting('app.current_user_id', true)
    OR target_user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR actor_user_id::text = current_setting('app.current_user_id', true)
  );
