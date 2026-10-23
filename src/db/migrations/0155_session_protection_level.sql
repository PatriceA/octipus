-- The highest protection level a session has read (docs/PROTECTION-LEVELS.md,
-- C6b). Null: nothing leveled read yet. Only ever raised.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "protection_level" smallint CHECK ("protection_level" BETWEEN 1 AND 4);
