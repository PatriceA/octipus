-- Live Artifacts Toolbox — Phase 3.
--
-- Adds `artifact_exports` so each artifact can register named download
-- exporters served via `GET /a/:slug/export/:export_id`. The tool id
-- points at a registered exporter (`art_export_csv`, `art_export_json`,
-- `art_export_markdown`, …) and the bind/params shape mirrors widgets.
--
-- Idempotent: safe to rerun.

CREATE TABLE IF NOT EXISTS "artifact_exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "export_id" text NOT NULL,
  "tool_id" text NOT NULL,
  "bind_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "params_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "artifact_exports_artifact_id_idx"
  ON "artifact_exports" ("artifact_id");
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_exports_artifact_id_export_id_uq"
  ON "artifact_exports" ("artifact_id", "export_id");
