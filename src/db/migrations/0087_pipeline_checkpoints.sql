-- Wave 2 — checkpoint, resume, rewind.
--
-- The graph walker's state (handoff chain, per-edge traversal counts, QA
-- feedback in flight, the plan item being worked) lives only in the process
-- running it. `run_events` records which node boundaries were crossed but not
-- enough to continue from one, so a restart or a deliberate pause lost the run
-- even though every node's output was already durable.
--
-- One row per node ENTRY. Resuming re-enters the node that was interrupted;
-- rewinding loads the row written when the target node was last entered.

CREATE TABLE IF NOT EXISTS "pipeline_checkpoints" (
  "seq" bigserial PRIMARY KEY NOT NULL,
  "pipeline_id" uuid NOT NULL REFERENCES "pipelines"("id") ON DELETE CASCADE,
  "node_key" text NOT NULL,
  "state" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_checkpoints_pipeline_idx"
  ON "pipeline_checkpoints" ("pipeline_id", "seq");
