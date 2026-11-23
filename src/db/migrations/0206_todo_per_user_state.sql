-- The personal layer of a to-do is per user (review of 0205): in a space
-- every member has their own star, My Day and order. `task_user_state` holds
-- one row per (task, user) that changed any of them; a missing row is "not
-- starred, not in My Day, the task's default order" (tasks.sort_order). The
-- API returns the caller's own values under the same field names.
--
-- `task_lists` keeps a list that has no to-do yet (a list is otherwise the
-- `category` of its to-dos), scoped like tasks: personal (workspace null or a
-- personal workspace, the creator's) or one space's (every member's).
CREATE TABLE IF NOT EXISTS "task_user_state" (
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "important" boolean DEFAULT false NOT NULL,
  "my_day_on" date,
  "sort_order" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("task_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_user_state_user_day_idx" ON "task_user_state" ("user_id", "my_day_on") WHERE "my_day_on" IS NOT NULL;
--> statement-breakpoint
-- Move what 0205 stored on the shared row to its owner's state, then drop it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'important') THEN
    INSERT INTO "task_user_state" ("task_id", "user_id", "important", "my_day_on")
      SELECT "id", "user_id", "important", "my_day_on" FROM "tasks" WHERE "important" OR "my_day_on" IS NOT NULL
      ON CONFLICT DO NOTHING;
    ALTER TABLE "tasks" DROP COLUMN "important";
    ALTER TABLE "tasks" DROP COLUMN IF EXISTS "my_day_on";
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_lists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_lists_user_idx" ON "task_lists" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_lists_workspace_idx" ON "task_lists" ("workspace_id");
