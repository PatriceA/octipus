-- Bump pgvector dimension 768 → 1024 to match the configured embedding
-- provider (Voyage). Affects two columns:
--   embeddings.embedding              (NOT NULL — existing rows truncated)
--   skills.description_embedding      (NULLABLE — existing values are NULL)
--
-- Rationale: 768 was inherited from the original RAG migration (0005)
-- when the embedding model was assumed to be a 768-dim provider
-- (e.g. text-embedding-3-small at default dim). Voyage's main models
-- (voyage-3, voyage-2) return 1024. Aligning the schema to the actual
-- provider in use avoids per-insert dimension errors. See
-- docs/plans/skill-discovery.md.
--
-- Drop+recreate is required because pgvector forbids ALTER COLUMN TYPE
-- across dimensions. HNSW indexes are tied to the column dimension and
-- must also be dropped+recreated.

-- ── embeddings.embedding ────────────────────────────────────────────
DROP INDEX IF EXISTS embeddings_vector_idx;

-- The column is NOT NULL — existing rows must be cleared before the type
-- change. Dev had a single test row; prod will need a re-index pass after
-- this migration regardless (handled by the existing RAG indexing path).
DELETE FROM embeddings;

ALTER TABLE embeddings DROP COLUMN embedding;
ALTER TABLE embeddings ADD COLUMN embedding vector(1024) NOT NULL;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS embeddings_vector_idx ON embeddings USING hnsw (embedding vector_cosine_ops);
EXCEPTION WHEN feature_not_supported OR undefined_object THEN
  -- PGlite: HNSW unsupported, brute-force scan still works.
  NULL;
END $$;

-- ── skills.description_embedding ────────────────────────────────────
DO $$ BEGIN
  DROP INDEX IF EXISTS skills_description_embedding_idx;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE skills DROP COLUMN IF EXISTS description_embedding;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS description_embedding vector(1024);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS skills_description_embedding_idx ON skills USING hnsw (description_embedding vector_cosine_ops);
EXCEPTION WHEN feature_not_supported OR undefined_object THEN
  NULL;
END $$;
