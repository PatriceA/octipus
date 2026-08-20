-- Wave 3 — per-node token budgets in the graph.
--
-- `NodeBudget` governed swarm nodes only; a pipeline node had no budget at all,
-- so its worker fell back to the global per-agent default and its cost was
-- attributable only by correlating a time window against `cost_log`. A `foreach`
-- node is the case that makes this bite: plan items can be appended mid-run, so
-- "bounded per node" does not bound the run.
--
-- `tokens_used` is CUMULATIVE across visits — a node the QA loop sent back three
-- times cost what all three visits cost, and that is the number a budget has to
-- be judged against.

ALTER TABLE "pipeline_nodes" ADD COLUMN IF NOT EXISTS "tokens_used" integer DEFAULT 0 NOT NULL;
ALTER TABLE "pipeline_nodes" ADD COLUMN IF NOT EXISTS "max_tokens" integer;

-- The walk's own budget events. `node_tokens` is charged per visit (success or
-- failure); `budget_exhausted` belongs to the run rather than to any node,
-- which is what the new subject is for.
ALTER TYPE "run_event_subject" ADD VALUE IF NOT EXISTS 'pipeline';
ALTER TYPE "run_event_type" ADD VALUE IF NOT EXISTS 'node_tokens';
ALTER TYPE "run_event_type" ADD VALUE IF NOT EXISTS 'budget_exhausted';
