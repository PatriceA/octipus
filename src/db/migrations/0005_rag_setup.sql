CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  model TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS embeddings_source_type_idx ON embeddings (source_type);
CREATE INDEX IF NOT EXISTS embeddings_source_id_idx ON embeddings (source_id);

-- HNSW index for fast cosine similarity search (PostgreSQL with pgvector only; PGlite uses brute-force scan)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS embeddings_vector_idx ON embeddings USING hnsw (embedding vector_cosine_ops);
EXCEPTION WHEN feature_not_supported OR undefined_object THEN
  -- PGlite does not support HNSW indexes; cosine search still works without an index
  NULL;
END $$;
