-- Memory-redesign Phase A — tag and version embeddings.
-- See `.octipus/memory-redesign.md` and `.octipus/memory-redesign-schema.sql`.
--
-- Adds purpose, content_sha256, embedding_version, access_count,
-- last_accessed_at to `embeddings`. The knowledge base is disposable in
-- this install (re-indexing happens on next document upload / agent
-- activity), so existing rows are truncated rather than backfilled —
-- avoids a fragile `source_type` → `purpose` migration and the dedup
-- pass that would be needed before the unique index can be enforced.
--
-- Idempotent: safe to rerun.

DELETE FROM embeddings;

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS purpose            text NOT NULL,
  ADD COLUMN IF NOT EXISTS content_sha256     text NOT NULL,
  ADD COLUMN IF NOT EXISTS embedding_version  text NOT NULL,
  ADD COLUMN IF NOT EXISTS access_count       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_accessed_at   timestamptz;

CREATE INDEX IF NOT EXISTS embeddings_purpose_idx
  ON embeddings (purpose);
CREATE INDEX IF NOT EXISTS embeddings_embedding_version_idx
  ON embeddings (embedding_version);
CREATE INDEX IF NOT EXISTS embeddings_last_accessed_at_idx
  ON embeddings (last_accessed_at);
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_dedup_idx
  ON embeddings (purpose, source_id, content_sha256);
