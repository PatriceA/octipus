-- Agent-authored refresh of a live artifact (docs/ARTIFACTS.md#agent-refresh):
-- the stored instruction an agent re-runs, as the artifact's owner, to
-- regenerate the page; an optional owner-set schedule; and the state of the
-- last attempt. One row per artifact, removed with it. New table only: no
-- existing row changes, and an artifact without a row refreshes nothing.
CREATE TABLE IF NOT EXISTS "artifact_agent_refresh" (
  "artifact_id" uuid PRIMARY KEY NOT NULL REFERENCES "artifacts"("id") ON DELETE cascade,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "instruction" text NOT NULL,
  "instruction_set_by" text DEFAULT 'owner' NOT NULL,
  "interval_minutes" integer,
  "schedule_chain" text,
  "next_run_at" timestamp with time zone,
  "schedule_disabled_reason" text,
  "schedule_set_at" timestamp with time zone,
  "session_id" uuid,
  "run_started_at" timestamp with time zone,
  "last_attempt_at" timestamp with time zone,
  "last_outcome" text,
  "last_error" text,
  "last_success_at" timestamp with time zone,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_page_hash" text,
  "last_version_id" uuid,
  "pending_version_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifact_agent_refresh_owner_idx" ON "artifact_agent_refresh" ("owner_user_id");
