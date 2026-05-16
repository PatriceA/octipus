-- Memory-redesign Phase C — document hierarchy.
-- See `.octipus/memory-redesign.md` Phase C and `.octipus/memory-redesign-schema.sql`.
--
-- Lets a chunk know its section path (e.g. ['Article IV', 'Clause 4.2'])
-- so retrieval can pull the matching clause plus its ancestor headings into
-- the prompt. Solves the "Clause 4.2 modifies Section 1" problem without
-- extracting a knowledge graph.
--
-- Idempotent: safe to rerun.

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS parent_chunk_id  uuid REFERENCES embeddings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS section_path     text[],
  ADD COLUMN IF NOT EXISTS heading_level    smallint,
  ADD COLUMN IF NOT EXISTS doc_id           uuid;

CREATE INDEX IF NOT EXISTS embeddings_parent_chunk_idx
  ON embeddings (parent_chunk_id);
CREATE INDEX IF NOT EXISTS embeddings_doc_id_idx
  ON embeddings (doc_id);
CREATE INDEX IF NOT EXISTS embeddings_section_path_gin_idx
  ON embeddings USING GIN (section_path);
