-- Memory-redesign Phase B — typed workflow state.
-- See `.octipus/memory-redesign.md` Phase B and `.octipus/memory-redesign-schema.sql`.
--
-- Adds `task_state` so sibling agents discover each other's outputs via a
-- typed SQL row + LISTEN/NOTIFY fan-out, instead of cosine search over the
-- RAG `embeddings` table tagged source_type='agent_output'. The
-- agent-output write path in `src/core/rag/auto-indexer.ts` is removed in
-- the same change set.
--
-- Idempotent: safe to rerun.

CREATE TABLE IF NOT EXISTS task_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- session_id intentionally not FK'd: sessions are sometimes deleted
  -- before their tasks (cleanup ordering) and we'd rather keep the
  -- typed output than cascade-lose it. Orphan rows age out via the
  -- normal cleanup pass.
  session_id      uuid NOT NULL,
  -- swarm_nodes.id is text (1:1 with agents.id); match the type.
  swarm_node_id   text REFERENCES swarm_nodes(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  owner_agent     text NOT NULL,
  task_kind       text NOT NULL,
  status          text NOT NULL,
  inputs          jsonb NOT NULL DEFAULT '{}',
  outputs         jsonb NOT NULL DEFAULT '{}',
  depends_on      uuid[] NOT NULL DEFAULT '{}',
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_state_session_idx
  ON task_state (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_state_owner_status_idx
  ON task_state (owner_agent, status);
CREATE INDEX IF NOT EXISTS task_state_swarm_node_idx
  ON task_state (swarm_node_id);

-- LISTEN/NOTIFY fan-out. Channel is per session so a subscriber only
-- wakes for tasks in its own session — no cross-session noise.
-- Payload is intentionally small: enough to route, callers fetch the
-- full row by id if they care about inputs/outputs.
CREATE OR REPLACE FUNCTION task_state_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'task_state_' || NEW.session_id::text,
    json_build_object(
      'id',         NEW.id,
      'status',     NEW.status,
      'owner',      NEW.owner_agent,
      'task_kind',  NEW.task_kind,
      'updated_at', NEW.updated_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_state_notify_trg ON task_state;
CREATE TRIGGER task_state_notify_trg
  AFTER INSERT OR UPDATE ON task_state
  FOR EACH ROW EXECUTE FUNCTION task_state_notify();
