-- Append-only log of compaction passes per session. Replaces the
-- single rolling `session.context.compactedSummary` string with a
-- structured table supporting iterative summary chaining, cumulative
-- file tracking, and `/compact <instructions>` audit.
CREATE TABLE IF NOT EXISTS "compaction_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "parent_entry_id" uuid,
  "summary" text NOT NULL,
  "file_ops" jsonb NOT NULL DEFAULT '{"read":[],"written":[],"edited":[]}'::jsonb,
  "user_instructions" text,
  "tokens_before" integer NOT NULL,
  "tokens_after" integer NOT NULL,
  "savings_ratio" real NOT NULL,
  "messages_summarized" integer NOT NULL DEFAULT 0,
  "trigger_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "compaction_entries_session_idx" ON "compaction_entries" ("session_id");
CREATE INDEX IF NOT EXISTS "compaction_entries_session_created_idx" ON "compaction_entries" ("session_id", "created_at");
