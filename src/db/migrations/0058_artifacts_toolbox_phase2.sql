-- Live Artifacts Toolbox — Phase 2.
--
-- Adds `artifact_transforms` and `artifact_widgets` so toolbox transforms
-- and widgets become first-class persisted nodes of an artifact pipeline,
-- not template-string magic. See `.octipus/live-artifacts-toolbox.md` §4-§6.
--
-- Idempotent: safe to rerun.

-- ── artifact_transforms ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "artifact_transforms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "tool_id" text NOT NULL,
  "input_name" text NOT NULL,
  "params_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "artifact_transforms_artifact_id_idx"
  ON "artifact_transforms" ("artifact_id");
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_transforms_artifact_id_name_uq"
  ON "artifact_transforms" ("artifact_id", "name");

-- ── artifact_widgets ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "artifact_widgets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "slot" text NOT NULL,
  "tool_id" text NOT NULL,
  "bind_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "params_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "position" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "artifact_widgets_artifact_id_idx"
  ON "artifact_widgets" ("artifact_id");
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_widgets_artifact_id_slot_uq"
  ON "artifact_widgets" ("artifact_id", "slot");
