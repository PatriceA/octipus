-- Lets `seedPresetTemplates` tell an untouched preset from an edited one, so
-- shipped prompt/toolIds/declaration changes actually reach an existing
-- install instead of only ever reaching a fresh one. NULL = seeded before this
-- column existed, read as "edited" (never overwrite what we cannot prove is
-- untouched).
ALTER TABLE "pipeline_templates" ADD COLUMN IF NOT EXISTS "shipped_hash" text;
