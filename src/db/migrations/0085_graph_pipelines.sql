-- Wave 1 — pipelines become a graph.
--
-- `pipeline_stages` modelled a strictly linear list: `stage_index` walked by
-- `pipelines.current_stage_index`. Branching, fan-out and cycles were
-- impossible, and the one cycle that mattered (QA sends work back) was
-- special-cased inside `pipeline-manager.ts` instead of being expressible.
--
-- Full cutover, not a parallel structure: the table is RENAMED (so existing
-- rows and their outputs survive), the ordinal keeps only a display meaning,
-- and execution order moves to `pipeline_edges`. Every pre-existing pipeline is
-- backfilled into the chain it already was.

CREATE TYPE "pipeline_node_kind" AS ENUM ('step', 'foreach');
--> statement-breakpoint
CREATE TYPE "pipeline_edge_condition" AS ENUM (
  'always', 'qa_pass', 'qa_fail', 'audit_gate_failed', 'loop_body', 'loop_done', 'on_error'
);
--> statement-breakpoint
CREATE TYPE "plan_item_status" AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');
--> statement-breakpoint

ALTER TABLE "pipeline_stages" RENAME TO "pipeline_nodes";
--> statement-breakpoint
ALTER TABLE "pipeline_nodes" RENAME COLUMN "stage_index" TO "ordinal";
--> statement-breakpoint
ALTER TABLE "pipeline_nodes" ADD COLUMN IF NOT EXISTS "node_key" text;
--> statement-breakpoint
ALTER TABLE "pipeline_nodes" ADD COLUMN IF NOT EXISTS "kind" "pipeline_node_kind" DEFAULT 'step' NOT NULL;
--> statement-breakpoint
ALTER TABLE "pipeline_nodes" ADD COLUMN IF NOT EXISTS "parent_node_key" text;
--> statement-breakpoint
ALTER TABLE "pipeline_nodes" ADD COLUMN IF NOT EXISTS "visits" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Backfill: an existing stage's key is its position, which is exactly what the
-- compiler emits for a plain step today. Keyed off row_number, not `ordinal`
-- directly: nothing ever enforced uniqueness on the old `stage_index`, and one
-- duplicated row would fail the unique index below and take the boot migration
-- down with it.
WITH keyed AS (
  SELECT "id",
         'n' || (row_number() OVER (PARTITION BY "pipeline_id" ORDER BY "ordinal", "id") - 1)::text AS k
  FROM "pipeline_nodes"
)
UPDATE "pipeline_nodes" n SET "node_key" = keyed.k
FROM keyed WHERE keyed."id" = n."id" AND n."node_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "pipeline_nodes" ALTER COLUMN "node_key" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_nodes_pipeline_key_idx"
  ON "pipeline_nodes" ("pipeline_id", "node_key");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pipeline_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pipeline_id" uuid NOT NULL REFERENCES "pipelines"("id") ON DELETE CASCADE,
  "from_node_key" text NOT NULL,
  "to_node_key" text NOT NULL,
  "condition" "pipeline_edge_condition" DEFAULT 'always' NOT NULL,
  "max_traversals" integer,
  "traversals" integer DEFAULT 0 NOT NULL,
  "ordinal" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_edges_from_idx"
  ON "pipeline_edges" ("pipeline_id", "from_node_key", "ordinal");
--> statement-breakpoint

-- Backfill the chain each existing pipeline already was: node N -> node N+1,
-- unconditional. A finished pipeline gets its edges too, so the UI can render
-- historical runs with the same code path as live ones.
WITH seq AS (
  SELECT "pipeline_id", "node_key",
         row_number() OVER (PARTITION BY "pipeline_id" ORDER BY "ordinal", "id") AS rn
  FROM "pipeline_nodes"
)
INSERT INTO "pipeline_edges" ("pipeline_id", "from_node_key", "to_node_key", "condition", "ordinal")
SELECT a."pipeline_id", a."node_key", b."node_key", 'always', 0
FROM seq a
JOIN seq b ON b."pipeline_id" = a."pipeline_id" AND b.rn = a.rn + 1;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "plan_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pipeline_id" uuid NOT NULL REFERENCES "pipelines"("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "title" text NOT NULL,
  "detail" text,
  "status" "plan_item_status" DEFAULT 'pending' NOT NULL,
  "created_by_node_key" text,
  "created_by_user_id" uuid REFERENCES "users"("id"),
  "result" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_items_pipeline_idx"
  ON "plan_items" ("pipeline_id", "ordinal");
--> statement-breakpoint

-- The walker's position is a node key, not an index: a backward edge or a loop
-- body revisits nodes, which an ordinal cannot express.
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "current_node_key" text;
--> statement-breakpoint
UPDATE "pipelines" SET "current_node_key" = 'n' || "current_stage_index"::text
  WHERE "current_node_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "pipelines" DROP COLUMN IF EXISTS "current_stage_index";
--> statement-breakpoint

-- RLS. The renamed table keeps its policy (policies follow the table), but the
-- policy's own name and its predicate still say `pipeline_stages`, and the two
-- NEW tables have none at all — a table with no policy under FORCE RLS is not
-- "open", it is invisible, and an edge nobody can read is a pipeline that
-- cannot run. Same FK-subquery shape as the table they replace.
DROP POLICY IF EXISTS pipeline_stages_owner_policy ON "pipeline_nodes";
--> statement-breakpoint
CREATE POLICY pipeline_nodes_owner_policy ON "pipeline_nodes"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = pipeline_nodes.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = pipeline_nodes.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  );
--> statement-breakpoint

ALTER TABLE "pipeline_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pipeline_edges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pipeline_edges_owner_policy ON "pipeline_edges"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = pipeline_edges.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = pipeline_edges.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  );
--> statement-breakpoint

ALTER TABLE "plan_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "plan_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY plan_items_owner_policy ON "plan_items"
  USING (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = plan_items.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    COALESCE(current_setting('app.bypass_rls', true), 'true') = 'true'
    OR EXISTS (
      SELECT 1 FROM pipelines
      WHERE pipelines.id = plan_items.pipeline_id
        AND pipelines.user_id::text = current_setting('app.current_user_id', true)
    )
  );
