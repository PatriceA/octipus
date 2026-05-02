-- Phase 1b-1 — vault scoping.
--
-- Adds a `scope` enum column to the vault and backfills:
--   - rows with the legacy `user_id = 'system'` sentinel  → scope='system'
--   - every other row                                       → scope='user'
--
-- After backfill the column is NOT NULL with a default of 'user' so future
-- inserts that forget to set the scope still land in the safest bucket.
-- 'workspace' is reserved for Phase 2 — added to the enum now so a later
-- migration doesn't have to ALTER TYPE again.

-- 1. Create the enum (idempotent for re-runs).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vault_scope') THEN
    CREATE TYPE "vault_scope" AS ENUM ('system', 'user', 'workspace');
  END IF;
END$$;

-- 2. Add the column nullable so the backfill can run.
ALTER TABLE "vault" ADD COLUMN IF NOT EXISTS "scope" "vault_scope";

-- 3. Backfill existing rows.
UPDATE "vault" SET "scope" = 'system'
  WHERE "scope" IS NULL AND "user_id" = 'system';
UPDATE "vault" SET "scope" = 'user'
  WHERE "scope" IS NULL;

-- 4. Lock down the column.
ALTER TABLE "vault" ALTER COLUMN "scope" SET DEFAULT 'user';
ALTER TABLE "vault" ALTER COLUMN "scope" SET NOT NULL;

-- 5. Index for the new scope-aware reads.
CREATE INDEX IF NOT EXISTS "vault_scope_idx" ON "vault" ("scope");
