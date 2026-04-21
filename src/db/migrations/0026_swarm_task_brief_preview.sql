-- Swarm: persist the child's task brief on the node row so the live-tree
-- UI can display "what was this child asked to do?" without fetching events.
-- Nullable so existing rows remain valid.
ALTER TABLE "swarm_nodes"
  ADD COLUMN IF NOT EXISTS "task_brief_preview" text;
