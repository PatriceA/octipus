-- Memory-redesign post-implementation cleanup.
-- See `.octipus/memory-redesign.md` review follow-up.
--
-- Two fixes:
--
--   1. embeddings.doc_id → documents.id FK with ON DELETE CASCADE.
--      The Phase C migration declared the column without the FK, so
--      deleting a document leaves orphan chunks. The cleanup loop's
--      "orphaned documents" pass matched on `source_id` (text) instead
--      of `doc_id` (uuid), so doc_id-tagged rows would never be
--      reaped. Backfill: NULL out any doc_id pointing at a now-deleted
--      document, then declare the FK.
--
--   2. memories.active partial index. The schema name implied
--      `WHERE superseded_by IS NULL` but the index was full. Hot read
--      path filters on supersession every time — partial index halves
--      its size in steady-state.
--
-- Idempotent: safe to rerun.

-- ── 1. embeddings.doc_id FK ─────────────────────────────────────────

UPDATE embeddings
SET doc_id = NULL
WHERE doc_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = embeddings.doc_id);

DO $$ BEGIN
  ALTER TABLE embeddings
    ADD CONSTRAINT embeddings_doc_id_fk
    FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- ── 2. memories partial active index ────────────────────────────────

DROP INDEX IF EXISTS memories_user_scope_type_active_idx;

CREATE INDEX IF NOT EXISTS memories_user_scope_type_active_idx
  ON memories (user_id, agent_scope, fact_type)
  WHERE superseded_by IS NULL;
