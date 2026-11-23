-- Runtime roles (docs/AGENT-ARCHITECTURE.md#runtime-roles): an operator's
-- role row carries the rest of a role definition: a display name, which
-- roles it may spawn and be spawned by, and per-agent limits. All nullable:
-- NULL means "no rule" (spawn anything that accepts it, be spawned by anyone,
-- the depth defaults), so existing rows keep their behaviour.
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "display_name" text;
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "spawns" jsonb;
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "spawned_by" jsonb;
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "limits" jsonb;
