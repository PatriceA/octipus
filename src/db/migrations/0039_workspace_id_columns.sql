-- Phase 4 — workspace_id adoption.
--
-- Phase 3g shipped the `workspaces` table (migration 0038) but kept
-- it isolated from existing tables. Phase 4 wires per-workspace
-- scoping into the data layer: sessions, documents, and hooks each
-- gain a nullable `workspace_id` column referencing `workspaces(id)`.
--
-- Nullable on purpose:
--   - Existing rows stay valid without backfill — the auth layer
--     treats NULL as "user-level" scope (visible to every workspace
--     owned by the user).
--   - Operators who haven't flipped `multiuser.orgWorkspaces` on
--     don't have to run the backfill script.
--
-- The backfill walks each user's rows and stamps them with the
-- user's default workspace; see `scripts/backfill-workspace-id.ts`.
--
-- Foreign key uses ON DELETE SET NULL: deleting a workspace shouldn't
-- cascade-delete the user's sessions / documents / hooks. After a
-- workspace deletion the rows fall back to "user-level" scope and
-- become visible to every workspace the user owns again — same shape
-- as a fresh row.
--
-- Idempotent: every ALTER uses IF NOT EXISTS so re-running on a
-- partially-applied database is safe.

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid
  REFERENCES "workspaces"("id") ON DELETE SET NULL;

ALTER TABLE "documents"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid
  REFERENCES "workspaces"("id") ON DELETE SET NULL;

ALTER TABLE "hooks"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid
  REFERENCES "workspaces"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "sessions_workspace_id_idx"  ON "sessions"  ("workspace_id");
CREATE INDEX IF NOT EXISTS "documents_workspace_id_idx" ON "documents" ("workspace_id");
CREATE INDEX IF NOT EXISTS "hooks_workspace_id_idx"     ON "hooks"     ("workspace_id");

-- Composite (user_id, workspace_id) index — the dominant query
-- shape once Phase 4 lights up: "fetch X for this user in this
-- workspace". A separate index speeds it up without doubling the
-- lookup cost when workspace_id is NULL.
CREATE INDEX IF NOT EXISTS "sessions_user_id_workspace_id_idx"
  ON "sessions" ("user_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "documents_user_id_workspace_id_idx"
  ON "documents" ("user_id", "workspace_id");
CREATE INDEX IF NOT EXISTS "hooks_user_id_workspace_id_idx"
  ON "hooks" ("user_id", "workspace_id");
