-- Hook execution history table
DO $$ BEGIN
  CREATE TYPE "execution_status" AS ENUM ('success', 'error', 'skipped');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "execution_source" AS ENUM ('hook', 'recurring_task', 'manual_test');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "hook_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hook_id" uuid REFERENCES "hooks"("id") ON DELETE CASCADE,
  "recurring_task_id" uuid REFERENCES "recurring_tasks"("id") ON DELETE CASCADE,
  "source" "execution_source" NOT NULL,
  "status" "execution_status" NOT NULL,
  "trigger_type" text,
  "action_type" text,
  "result" jsonb,
  "error" text,
  "duration_ms" integer,
  "trigger_context" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "hook_executions_hook_id_idx" ON "hook_executions" ("hook_id");
CREATE INDEX IF NOT EXISTS "hook_executions_recurring_task_id_idx" ON "hook_executions" ("recurring_task_id");
CREATE INDEX IF NOT EXISTS "hook_executions_created_at_idx" ON "hook_executions" ("created_at");
CREATE INDEX IF NOT EXISTS "hook_executions_status_idx" ON "hook_executions" ("status");
