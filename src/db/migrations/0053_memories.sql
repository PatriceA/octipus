-- Memory-redesign Phase D — atomic, updatable long-term memories.
-- See `.octipus/memory-redesign.md` Phase D.
--
-- One row = one atomic fact about the user. The extractor/judge
-- pipeline (src/core/memory/) produces these from conversation turns.
-- Updates are NEVER destructive: a new row is INSERTed and
-- superseded_by is set on the old. Active retrieval uses the
-- `memories_active` view below.
--
-- Idempotent: safe to rerun.

CREATE TABLE IF NOT EXISTS memories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id       uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_scope        text,
  fact_type          text NOT NULL,
  content            text NOT NULL,
  embedding          vector NOT NULL,
  embedding_version  text NOT NULL,
  -- messages may get compacted away; the source pointer is best-effort,
  -- so no FK.
  source_message_id  uuid,
  confidence         real NOT NULL DEFAULT 1.0,
  valid_until        timestamptz,
  superseded_by      uuid REFERENCES memories(id) ON DELETE SET NULL,
  access_count       integer NOT NULL DEFAULT 0,
  last_accessed_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id);
CREATE INDEX IF NOT EXISTS memories_user_scope_type_active_idx
  ON memories (user_id, agent_scope, fact_type);
CREATE INDEX IF NOT EXISTS memories_workspace_idx
  ON memories (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_superseded_by_idx ON memories (superseded_by);
CREATE INDEX IF NOT EXISTS memories_valid_until_idx
  ON memories (valid_until) WHERE valid_until IS NOT NULL;

-- Active-memories view — what the orchestrator reads. Filters out
-- superseded rows and expired TTLs so callers don't have to remember
-- the predicate.
CREATE OR REPLACE VIEW memories_active AS
  SELECT *
    FROM memories
   WHERE superseded_by IS NULL
     AND (valid_until IS NULL OR valid_until > now());
