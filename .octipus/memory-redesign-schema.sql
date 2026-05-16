-- ====================================================================
-- Memory & Knowledge System Redesign — schema sketch
-- ====================================================================
-- DRAFT / DESIGN ARTIFACT. NOT a runnable migration.
-- Real migrations are generated per-phase via `bun run db:generate`
-- once each phase in .octipus/memory-redesign.md is approved.
-- ====================================================================


-- --------------------------------------------------------------------
-- Phase A — Tag and version existing embeddings
-- Goal: cleanup becomes purpose-aware; same content cannot be inserted
-- twice; embedding model swaps are no longer silent.
-- --------------------------------------------------------------------

ALTER TABLE embeddings
  ADD COLUMN purpose            text,                  -- document | code | image_description | knowledge_artifact | message | ephemeral
  ADD COLUMN content_sha256     text,
  ADD COLUMN embedding_version  text,                  -- e.g. "nomic-embed-text:v1.5/768"
  ADD COLUMN access_count       int     DEFAULT 0 NOT NULL,
  ADD COLUMN last_accessed_at   timestamptz;

-- Backfill purpose from existing source_type before NOT NULL constraint.
UPDATE embeddings SET purpose = CASE source_type
    WHEN 'document'     THEN 'document'
    WHEN 'code'         THEN 'code'
    WHEN 'agent_output' THEN 'ephemeral'   -- targeted for accelerated cleanup in Phase B
    WHEN 'message'      THEN 'message'
    ELSE 'ephemeral'
  END
  WHERE purpose IS NULL;

-- Backfill content_sha256.
UPDATE embeddings SET content_sha256 = encode(digest(content, 'sha256'), 'hex')
  WHERE content_sha256 IS NULL;
-- (requires pgcrypto; already enabled in 0000_initial.sql)

-- Backfill embedding_version from existing `model` column.
UPDATE embeddings SET embedding_version = model
  WHERE embedding_version IS NULL;

-- Drop existing duplicates keeping newest, then enforce uniqueness.
DELETE FROM embeddings e
  USING embeddings dup
  WHERE e.content_sha256 = dup.content_sha256
    AND e.purpose        = dup.purpose
    AND e.source_id      = dup.source_id
    AND e.created_at    <  dup.created_at;

ALTER TABLE embeddings
  ALTER COLUMN purpose           SET NOT NULL,
  ALTER COLUMN content_sha256    SET NOT NULL,
  ALTER COLUMN embedding_version SET NOT NULL;

CREATE UNIQUE INDEX embeddings_dedup_idx
  ON embeddings (purpose, source_id, content_sha256);

CREATE INDEX embeddings_purpose_idx           ON embeddings (purpose);
CREATE INDEX embeddings_embedding_version_idx ON embeddings (embedding_version);
CREATE INDEX embeddings_last_accessed_at_idx  ON embeddings (last_accessed_at);


-- --------------------------------------------------------------------
-- Phase B — Workflow state out of RAG
-- Goal: agent outputs stop polluting vector search; sibling agents read
-- typed state via SQL + LISTEN/NOTIFY.
-- --------------------------------------------------------------------

CREATE TABLE task_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  swarm_node_id   uuid REFERENCES swarm_nodes(id) ON DELETE SET NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  owner_agent     text NOT NULL,                       -- role id
  task_kind       text NOT NULL,                       -- 'assignment' | 'review' | 'finding' | …
  status          text NOT NULL,                       -- 'pending' | 'in_progress' | 'done' | 'cancelled' | 'failed'
  inputs          jsonb NOT NULL DEFAULT '{}',
  outputs         jsonb NOT NULL DEFAULT '{}',
  depends_on      uuid[] NOT NULL DEFAULT '{}',
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_state_session_idx      ON task_state (session_id, created_at DESC);
CREATE INDEX task_state_owner_status_idx ON task_state (owner_agent, status);
CREATE INDEX task_state_swarm_node_idx   ON task_state (swarm_node_id);

-- LISTEN/NOTIFY fan-out so a Project agent finishing instantly wakes
-- waiters without polling. Channel name is per session.
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

CREATE TRIGGER task_state_notify_trg
  AFTER INSERT OR UPDATE ON task_state
  FOR EACH ROW EXECUTE FUNCTION task_state_notify();


-- --------------------------------------------------------------------
-- Phase C — Document structure
-- Goal: a chunk knows its section path, so retrieval can pull
-- "Clause 4.2" plus its parent "Article IV / Section 1".
-- --------------------------------------------------------------------

ALTER TABLE embeddings
  ADD COLUMN parent_chunk_id  uuid REFERENCES embeddings(id) ON DELETE SET NULL,
  ADD COLUMN section_path     text[],                -- ['Article IV', 'Section 1', 'Clause 4.2']
  ADD COLUMN heading_level    smallint,              -- 0=body, 1=H1, 2=H2, …
  ADD COLUMN doc_id           uuid REFERENCES documents(id) ON DELETE CASCADE;

CREATE INDEX embeddings_parent_chunk_idx ON embeddings (parent_chunk_id);
CREATE INDEX embeddings_doc_id_idx       ON embeddings (doc_id);
CREATE INDEX embeddings_section_path_idx ON embeddings USING GIN (section_path);


-- --------------------------------------------------------------------
-- Phase D — Memories layer (mem0-pattern, octipus-native)
-- Goal: user preferences, profile, relationships, workflow notes get an
-- update path. ADD/UPDATE/DELETE driven by an LLM judge at write time.
-- --------------------------------------------------------------------

CREATE TABLE memories (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id      uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_scope       text,                            -- NULL = global to user; else role id
  fact_type         text NOT NULL,                   -- preference | profile | relationship | skill_observation | workflow_note
  content           text NOT NULL,                   -- one atomic fact, one sentence
  embedding         vector NOT NULL,
  embedding_version text NOT NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  confidence        real NOT NULL DEFAULT 1.0,
  valid_until       timestamptz,                     -- soft TTL; NULL = persistent
  superseded_by     uuid REFERENCES memories(id) ON DELETE SET NULL,
  access_count      int NOT NULL DEFAULT 0,
  last_accessed_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memories_user_idx           ON memories (user_id);
CREATE INDEX memories_user_scope_type_idx ON memories (user_id, agent_scope, fact_type)
  WHERE superseded_by IS NULL;
CREATE INDEX memories_workspace_idx      ON memories (workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX memories_superseded_by_idx  ON memories (superseded_by);
CREATE INDEX memories_valid_until_idx    ON memories (valid_until) WHERE valid_until IS NOT NULL;

-- Active-memories view: only rows that have not been superseded and
-- have not expired. This is what the orchestrator retrieves from.
CREATE OR REPLACE VIEW memories_active AS
  SELECT *
    FROM memories
   WHERE superseded_by IS NULL
     AND (valid_until IS NULL OR valid_until > now());


-- --------------------------------------------------------------------
-- Phase A.5 — Per-purpose retention rules
-- Stored config so the cleanup job stops hard-coding 30 days.
-- --------------------------------------------------------------------

CREATE TABLE retention_policies (
  purpose          text PRIMARY KEY,
  max_age_days     int,                              -- NULL = no age limit
  lfu_min_access   int,                              -- prune if access_count < this AND old
  lfu_min_age_days int,
  notes            text
);

INSERT INTO retention_policies (purpose, max_age_days, lfu_min_access, lfu_min_age_days, notes) VALUES
  ('document',          NULL, NULL, NULL, 'Tied to documents row lifecycle; cascade delete handles it.'),
  ('code',              NULL, NULL, NULL, 'Re-indexed on file change via content_sha256 upsert.'),
  ('image_description', NULL, NULL, NULL, 'Tied to documents row lifecycle.'),
  ('knowledge_artifact', 365, 1,    180,  'Agent-flagged "worth remembering" outputs.'),
  ('message',           90,   NULL, NULL, 'Conversation chunks. Compaction handles long-term recall.'),
  ('ephemeral',         7,    NULL, NULL, 'Legacy agent_output rows; will be empty after Phase B migration.');


-- ====================================================================
-- End of sketch. Things deliberately NOT included here:
--   - Apache AGE / graph schema   (out of scope; SQL parent pointers suffice)
--   - CLIP / ColPali image vectors (out of scope; vision caption is enough)
--   - mem0 integration tables     (we own this layer; mem0 is a trial-only scaffold)
-- ====================================================================
