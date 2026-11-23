-- The personal to-do layer (Microsoft To Do's feel, docs/API.md "Tasks"):
--   important       the star
--   sort_order      manual order within a list, ascending; new rows get minus
--                   their creation time in ms, so the newest is first until
--                   the user drags one (a drag writes a value between two
--                   neighbours)
--   my_day_on       the calendar day (user's zone) the to-do was put in
--                   My Day; it is in My Day only while that day is today
--   repeat          a repeat rule (core/tasks/repeat.ts), null = no repeat
--   repeat_next_id  the occurrence created when this one was completed:
--                   set once, under a guard, so it is created exactly once
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "important" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Existing rows keep their newest-first order; only when the column is new,
-- so a re-run never resets an order the user dragged into place.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'sort_order') THEN
    ALTER TABLE "tasks" ADD COLUMN "sort_order" double precision DEFAULT (-(extract(epoch from now()) * 1000)) NOT NULL;
    UPDATE "tasks" SET "sort_order" = -(extract(epoch from "created_at") * 1000);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "my_day_on" date;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "repeat" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "repeat_next_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_user_my_day_idx" ON "tasks" ("user_id", "my_day_on") WHERE "my_day_on" IS NOT NULL;
