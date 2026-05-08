-- Phase 4 follow-up — org-shared resources.
--
-- Adds an optional `org_id` to `model_config` and `skills` so an org
-- admin can curate a model registry and a skill set that every member
-- of the org sees. Visibility rule applied by the service layer:
--
--   row visible to user U  iff
--     org_id IS NULL                                      (system / personal default)
--     OR user_id = U                                      (personal — skills.user_id)
--     OR org_id IN (SELECT org_id FROM org_members
--                     WHERE user_id = U)                  (shared via org membership)
--
-- Additive only: existing rows have org_id IS NULL and stay visible
-- exactly as before. Single-user installs see no change.
--
-- Idempotent.

ALTER TABLE "model_config"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "model_config_org_id_idx" ON "model_config" ("org_id");

ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "organizations"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "skills_org_id_idx" ON "skills" ("org_id");
