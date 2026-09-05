-- Durable background jobs (daily-driver plan, Phase 3).
--
-- Research runs and document processing each kept their state in the process:
-- a Map with a 30-minute TTL, an in-memory array. A restart emptied both, so a
-- client polling a research job got 404 and an uploaded document stayed
-- `queued` with nothing left that would ever pick it up. Pipelines already had
-- the answer (`pipeline_checkpoints` + a boot sweep); this table gives the two
-- lighter kinds of work the same treatment without a second queue.
--
-- The row is the job. `queued` rows are claimed with `FOR UPDATE SKIP LOCKED`
-- in `created_at` order; `running` rows found at boot are marked `interrupted`
-- (never auto-resumed, the pipeline rule); finished rows are kept so the away
-- digest can report them, and pruned after thirty days.

CREATE TABLE IF NOT EXISTS "background_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- NULL = user-level, matching every other scoped table.
  "workspace_id" uuid,
  "title" text NOT NULL,
  "stage" text,
  "detail" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result" jsonb,
  "result_ref" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Exactly the claim order, so a pop reads one index row rather than sorting
-- the queue.
CREATE INDEX IF NOT EXISTS "background_jobs_claim_idx"
  ON "background_jobs" ("kind", "status", "created_at");
--> statement-breakpoint

-- The digest's read: what changed for one user since a point in time.
CREATE INDEX IF NOT EXISTS "background_jobs_user_updated_idx"
  ON "background_jobs" ("user_id", "updated_at");
