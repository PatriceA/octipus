-- Persona system — orchestrator persona profile.
--
-- Adds a composite (user_id, category) index on `profiles` so the
-- assistant-profile lookup ("find this user's persona") is a single
-- index scan. The `category` column already accepts arbitrary text
-- values; the persona repository writes `category='assistant'`.
--
-- Idempotent: safe to rerun.

CREATE INDEX IF NOT EXISTS "profiles_user_category_idx"
  ON "profiles" ("user_id", "category");
