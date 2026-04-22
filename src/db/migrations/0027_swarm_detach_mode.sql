-- Detach-mode for agent → subagent spawns.
--
-- `spawn_mode` = 'await' (default, synchronous) or 'detach' (fire-and-collect).
-- `collected_at` is set by `collect_children` / auto-collect when the parent
-- picks up the result of a detached child. Lets the orphan reaper find
-- detached subagents whose parent finished without collecting.

ALTER TABLE "swarm_nodes"
  ADD COLUMN "spawn_mode" text NOT NULL DEFAULT 'await',
  ADD COLUMN "collected_at" timestamp;

CREATE INDEX IF NOT EXISTS "swarm_nodes_detached_pending_idx"
  ON "swarm_nodes" ("parent_node_id")
  WHERE "spawn_mode" = 'detach' AND "collected_at" IS NULL;
