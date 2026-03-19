-- Hybrid search: add tsvector for BM25-style full-text search alongside pgvector
-- The column is auto-generated from content — stays in sync without triggers

ALTER TABLE embeddings
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX IF NOT EXISTS embeddings_content_tsv_idx ON embeddings USING GIN (content_tsv);

-- Tiered content: L0 abstract (~100 tokens) and L1 overview (~500 tokens)
-- Generated async by LLM after indexing, used to reduce token consumption in search results

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS abstract TEXT;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS overview TEXT;

-- Ensure HNSW index exists for vector cosine similarity (may already exist from 0005)
CREATE INDEX IF NOT EXISTS embeddings_embedding_hnsw_idx ON embeddings
  USING hnsw (embedding vector_cosine_ops);
