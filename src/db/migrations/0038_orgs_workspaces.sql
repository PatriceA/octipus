-- Phase 3g — optional org / workspace grouping layer.
--
-- Schema-only scaffolding. The previous phases scoped every isolated
-- row by `user_id`. This migration adds two grouping layers above and
-- below the user, both optional:
--
--   organizations
--     └── org_members (many users)
--           └── User (already exists; users.org_id is the "primary" org)
--                 └── workspaces (many per user)
--
-- Phase 3g ships the tables, a manager, and a small REST surface
-- gated on the new `multiuser.orgWorkspaces` feature flag (default
-- off). No existing table grows a foreign key in this phase — Phase 4
-- adopts `workspace_id` on sessions/documents/etc. once we have UI
-- that lets users actually switch workspaces. Keeping the migration
-- additive means single-user installs and every prior multi-user
-- deployment see byte-for-byte unchanged behavior until the flag is
-- flipped.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-running the
-- migration on a partially-applied database is safe.

CREATE TABLE IF NOT EXISTS "organizations" (
  "id"          uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"        text       NOT NULL UNIQUE,
  "name"        text       NOT NULL,
  "created_by"  uuid       REFERENCES "users"("id") ON DELETE SET NULL,
  "metadata"    jsonb      NOT NULL DEFAULT '{}',
  "created_at"  timestamp  NOT NULL DEFAULT now(),
  "updated_at"  timestamp  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "organizations_slug_idx"       ON "organizations" ("slug");
CREATE INDEX IF NOT EXISTS "organizations_created_by_idx" ON "organizations" ("created_by");

-- org_members: many-to-many between organizations and users. The role
-- column reserves room for `org_admin` (manage members + org settings)
-- vs the default `member`. RBAC checks layer on top of this table once
-- the flag flips on.
CREATE TABLE IF NOT EXISTS "org_members" (
  "org_id"     uuid       NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id"    uuid       NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role"       text       NOT NULL DEFAULT 'member',
  "joined_at"  timestamp  NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "org_members_user_id_idx" ON "org_members" ("user_id");

-- workspaces: per-user grouping. Equivalent to a "project" in the
-- product mental model. Phase 4 will let agents bind to a workspace,
-- and per-workspace filesystem roots / vault scopes will derive from
-- this row.
--
-- `slug` is unique per user (so two users can both have a `default`
-- workspace) — the FK lives on (user_id, slug). `is_default` marks the
-- workspace selected when no explicit choice is made; the manager
-- ensures at most one default per user via partial unique index.
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id"          uuid       PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid       NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "slug"        text       NOT NULL,
  "name"        text       NOT NULL,
  "is_default"  boolean    NOT NULL DEFAULT false,
  "metadata"    jsonb      NOT NULL DEFAULT '{}',
  "created_at"  timestamp  NOT NULL DEFAULT now(),
  "updated_at"  timestamp  NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "slug")
);

CREATE INDEX IF NOT EXISTS "workspaces_user_id_idx" ON "workspaces" ("user_id");

-- At most one default workspace per user. Enforced as a partial
-- unique index so non-default rows don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_one_default_per_user"
  ON "workspaces" ("user_id") WHERE "is_default" = true;

-- RLS — same "bypass on missing GUC" pattern used by 0034/0035/0037.
-- Workspaces are owned by a user; org membership is visible to the
-- member themselves. Org rows are visible to any member.
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_owner_policy ON "workspaces";
CREATE POLICY workspaces_owner_policy ON "workspaces"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

ALTER TABLE "org_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "org_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_members_self_policy ON "org_members";
CREATE POLICY org_members_self_policy ON "org_members"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR user_id::text = current_setting('app.current_user_id', true)
  );

-- Organization rows: visible to any user who is a member; modifiable
-- only via withRlsBypass (admin operations). Reads use a subquery
-- against org_members so policies stay independent.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_member_policy ON "organizations";
CREATE POLICY organizations_member_policy ON "organizations"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM org_members
      WHERE org_members.org_id = organizations.id
        AND org_members.user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
  );
