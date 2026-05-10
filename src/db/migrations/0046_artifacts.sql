-- Live Artifacts — persistent hosted pages tied to a workspace.
-- Five new tables: artifacts, artifact_versions, artifact_data_sources,
-- artifact_data_snapshots, artifact_share_links. See docs/plans/live-artifacts.md.

-- ── enums ──────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "public"."artifact_type" AS ENUM('dashboard', 'table', 'rss', 'news', 'html');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "public"."artifact_visibility" AS ENUM('private', 'workspace', 'signed', 'public');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "public"."artifact_source_kind" AS ENUM('tool', 'http', 'rss', 'mcp', 'skill_query');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "public"."artifact_source_status" AS ENUM('ok', 'error', 'pending');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── artifacts ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" text NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_by_agent_id" text,
  "title" text NOT NULL,
  "type" "artifact_type" NOT NULL,
  "visibility" "artifact_visibility" NOT NULL DEFAULT 'workspace',
  "current_version_id" uuid,
  "allowed_embed_origins" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "deleted_at" timestamp
);

CREATE INDEX IF NOT EXISTS "artifacts_workspace_id_idx" ON "artifacts" ("workspace_id");
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_workspace_id_slug_uq" ON "artifacts" ("workspace_id", "slug");
CREATE INDEX IF NOT EXISTS "artifacts_created_by_user_id_idx" ON "artifacts" ("created_by_user_id");

-- ── artifact_versions ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "artifact_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "html_template" text NOT NULL DEFAULT '',
  "js_bundle_sha256" text,
  "css" text NOT NULL DEFAULT '',
  "schema_json" text NOT NULL DEFAULT '{}',
  "change_summary" text NOT NULL DEFAULT '',
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "artifact_versions_artifact_id_idx" ON "artifact_versions" ("artifact_id");
CREATE INDEX IF NOT EXISTS "artifact_versions_created_at_idx" ON "artifact_versions" ("created_at");

-- ── artifact_data_sources ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "artifact_data_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" "artifact_source_kind" NOT NULL,
  "config_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "refresh_seconds" integer NOT NULL DEFAULT 300,
  "principal_id" text NOT NULL,
  "last_run_at" timestamp,
  "last_status" "artifact_source_status" NOT NULL DEFAULT 'pending',
  "last_error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "artifact_data_sources_artifact_id_idx" ON "artifact_data_sources" ("artifact_id");
CREATE UNIQUE INDEX IF NOT EXISTS "artifact_data_sources_artifact_id_name_uq" ON "artifact_data_sources" ("artifact_id", "name");

-- ── artifact_data_snapshots ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "artifact_data_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id" uuid NOT NULL REFERENCES "artifact_data_sources"("id") ON DELETE CASCADE,
  "payload_json" jsonb NOT NULL,
  "captured_at" timestamp NOT NULL DEFAULT now(),
  "ttl_seconds" integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS "artifact_data_snapshots_source_id_captured_at_idx"
  ON "artifact_data_snapshots" ("source_id", "captured_at" DESC);

-- ── artifact_share_links ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "artifact_share_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "artifact_id" uuid NOT NULL REFERENCES "artifacts"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "scope_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "expires_at" timestamp NOT NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "revoked_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "artifact_share_links_token_hash_idx" ON "artifact_share_links" ("token_hash");
CREATE INDEX IF NOT EXISTS "artifact_share_links_artifact_id_idx" ON "artifact_share_links" ("artifact_id");
