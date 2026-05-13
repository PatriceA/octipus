-- Make embedding columns dimensionless so any embedding model works
-- (e.g. nomic-embed-text = 768, Voyage = 1024, OpenAI = 1536/3072).
-- pgvector supports bare `vector` without a fixed dimension.
--
-- Idempotent: safe to rerun if a previous attempt partially applied.

-- ── embeddings.embedding ────────────────────────────────────────────
DROP INDEX IF EXISTS embeddings_vector_idx;
DELETE FROM embeddings;

-- Drop and re-add only if the column exists (idempotent)
DO $$ BEGIN
  ALTER TABLE embeddings DROP COLUMN IF EXISTS embedding;
  ALTER TABLE embeddings ADD COLUMN embedding vector NOT NULL;
EXCEPTION WHEN duplicate_column THEN
  -- Column already exists as dimensionless vector from a prior partial run
  NULL;
END $$;

-- HNSW indexes require fixed dimensions; dimensionless columns cannot
-- use HNSW. Skip index creation — brute-force scan works for embedded mode.

-- ── skills.description_embedding ────────────────────────────────────
DO $$ BEGIN
  DROP INDEX IF EXISTS skills_description_embedding_idx;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE skills DROP COLUMN IF EXISTS description_embedding;
  ALTER TABLE skills ADD COLUMN IF NOT EXISTS description_embedding vector;
EXCEPTION WHEN duplicate_column THEN
  NULL;
END $$;
