-- Live Artifacts Toolbox — Phase 1.
--
-- Adds the `tool_id` column + a new `toolbox` value to the source-kind enum
-- so artifact sources can be wired to a discoverable toolbox collector
-- (see src/core/artifacts/toolbox/) instead of the inline kind-switch in
-- src/core/artifacts/refresh.ts. Old rows untouched — they keep dispatching
-- via the legacy switch. New rows set `kind = 'toolbox'` + populate
-- `tool_id` with a stable id like `art_collect_http_json`.
--
-- Idempotent: safe to rerun.

-- Extend the enum. Postgres requires ALTER TYPE … ADD VALUE outside of any
-- enclosing transaction; drizzle-kit's runner already commits per statement.
DO $$ BEGIN
  ALTER TYPE "public"."artifact_source_kind" ADD VALUE IF NOT EXISTS 'toolbox';
EXCEPTION WHEN undefined_object THEN
  -- Enum may not exist yet on a brand-new DB; the artifacts migration
  -- (0046) creates it. Loud failure here would surface as a confusing
  -- "type does not exist" — skip and let 0046 run first.
  NULL;
END $$;

-- Add the column. NULL is meaningful — it marks a legacy-kind row.
ALTER TABLE "artifact_data_sources"
  ADD COLUMN IF NOT EXISTS "tool_id" text;

-- Partial index so the toolbox dispatcher can list every artifact using a
-- given collector without scanning the whole table — useful when a
-- collector is deprecated and we want to find sources still pointing at it.
CREATE INDEX IF NOT EXISTS "artifact_data_sources_tool_id_idx"
  ON "artifact_data_sources" ("tool_id")
  WHERE "tool_id" IS NOT NULL;
