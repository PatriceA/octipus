-- Fix action_type enum: rename execute_skill to execute_tool (the action runs tools, not skills)
ALTER TYPE "action_type" RENAME VALUE 'execute_skill' TO 'execute_tool';

-- Merge recurring tasks into hooks: add schedule-specific columns to hooks
ALTER TABLE "hooks" ADD COLUMN IF NOT EXISTS "next_run_at" timestamp;
ALTER TABLE "hooks" ADD COLUMN IF NOT EXISTS "last_error" text;

CREATE INDEX IF NOT EXISTS "hooks_next_run_at_idx" ON "hooks" ("next_run_at");

-- Migrate existing recurring tasks into hooks as schedule-triggered hooks
INSERT INTO "hooks" (
  "user_id", "name", "description", "trigger", "trigger_config",
  "action", "action_config", "is_enabled", "execution_count",
  "last_executed_at", "next_run_at", "last_error", "metadata"
)
SELECT
  rt."user_id",
  rt."name",
  rt."description",
  'schedule'::"trigger_type",
  jsonb_build_object(
    'cronExpression', rt."cron_expression",
    'timezone', COALESCE(rt."timezone", 'UTC')
  ),
  CASE rt."action_type"
    WHEN 'spawn_agent' THEN 'spawn_agent'::"action_type"
    WHEN 'execute_tool' THEN 'execute_tool'::"action_type"
    WHEN 'webhook' THEN 'webhook'::"action_type"
    ELSE 'spawn_agent'::"action_type"
  END,
  rt."action_config",
  rt."is_enabled" AND rt."status" = 'active',
  rt."run_count",
  rt."last_run_at",
  rt."next_run_at",
  rt."last_error",
  jsonb_build_object('migratedFromRecurringTask', rt."id")
FROM "recurring_tasks" rt
WHERE NOT EXISTS (
  SELECT 1 FROM "hooks" h
  WHERE h."metadata"->>'migratedFromRecurringTask' = rt."id"::text
);
