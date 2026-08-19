-- Wave 1 — one run log.
--
-- `swarm_ledger` recorded swarm node lifecycle and nothing else: a pipeline's
-- graph walk and every tool dispatch left no history, so "what actually
-- happened during this run" could only be reconstructed from prose output and
-- scattered log lines. Tracing and checkpointing both need the ordered
-- transitions, which an overwritten `status` column cannot provide.
--
-- Generalized rather than duplicated — a second parallel log would have meant
-- two orderings, two retention stories, and a join to read one run.
--
-- The enum is REPLACED rather than extended: `ALTER TYPE ... ADD VALUE` cannot
-- run inside a transaction block, and migrations here do.

CREATE TYPE "run_event_subject" AS ENUM ('swarm_node', 'pipeline_node', 'plan_item', 'tool');
--> statement-breakpoint
CREATE TYPE "run_event_type" AS ENUM (
  'spawn', 'result', 'cancel', 'reconcile',
  'node_entered', 'node_completed', 'node_failed', 'edge_traversed',
  'item_started', 'item_finished',
  'tool_call'
);
--> statement-breakpoint

ALTER TABLE "swarm_ledger" RENAME TO "run_events";
--> statement-breakpoint
ALTER TABLE "run_events" RENAME COLUMN "root_session_id" TO "run_id";
--> statement-breakpoint
ALTER TABLE "run_events" RENAME COLUMN "node_id" TO "subject_id";
--> statement-breakpoint
ALTER TABLE "run_events" RENAME COLUMN "parent_node_id" TO "parent_subject_id";
--> statement-breakpoint

ALTER TABLE "run_events"
  ALTER COLUMN "event" TYPE "run_event_type" USING "event"::text::"run_event_type";
--> statement-breakpoint
DROP TYPE IF EXISTS "swarm_ledger_event";
--> statement-breakpoint

-- Existing rows are all swarm node events, which is also the column default, so
-- the backfill is the default and no UPDATE is needed.
ALTER TABLE "run_events"
  ADD COLUMN IF NOT EXISTS "subject" "run_event_subject" DEFAULT 'swarm_node' NOT NULL;
--> statement-breakpoint

ALTER INDEX IF EXISTS "swarm_ledger_root_idx" RENAME TO "run_events_run_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "swarm_ledger_root_seq_idx" RENAME TO "run_events_run_seq_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "swarm_ledger_node_idx" RENAME TO "run_events_subject_idx";
