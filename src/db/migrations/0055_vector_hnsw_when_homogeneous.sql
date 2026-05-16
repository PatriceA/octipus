-- Vector-index strategy decision.
--
-- pgvector requires a fixed dimension to back HNSW. Migration 0047
-- made `embedding` dimensionless to support model swaps, at the cost
-- of forcing sequential scans on every vector search. This migration
-- restores HNSW automatically *when it's safe* — i.e. when the table
-- has a single embedding dimension.
--
-- Logic (per table — embeddings, memories):
--   1. Count distinct vector dimensions across non-null rows.
--   2. 0 rows           → leave column dimensionless. HNSW arrives
--                         on the next migration run after data lands.
--   3. 1 dimension      → ALTER COLUMN to vector(N), CREATE INDEX
--                         USING hnsw (vector_cosine_ops). One-time
--                         table rewrite; data preserved.
--   4. >1 dimension     → drift detected. RAISE NOTICE with the
--                         count and skip both ALTER + CREATE INDEX.
--                         Operator runs `bun run db:check-embedding-drift`
--                         to see the breakdown and re-indexes manually.
--
-- Idempotent: skips columns already typed `vector(N)` (re-running
-- after a successful pin is a no-op).

DO $$
DECLARE
  emb_distinct int;
  emb_dim int;
  emb_rows int;
  mem_distinct int;
  mem_dim int;
  mem_rows int;
BEGIN
  -- ── embeddings.embedding ──────────────────────────────────────────
  SELECT count(*)::int
    INTO emb_rows
    FROM embeddings
   WHERE embedding IS NOT NULL;

  IF emb_rows > 0 THEN
    SELECT count(DISTINCT vector_dims(embedding))::int,
           min(vector_dims(embedding))::int
      INTO emb_distinct, emb_dim
      FROM embeddings
     WHERE embedding IS NOT NULL;

    IF emb_distinct = 1 THEN
      EXECUTE format(
        'ALTER TABLE embeddings ALTER COLUMN embedding TYPE vector(%s) USING embedding::vector(%s)',
        emb_dim, emb_dim
      );
      CREATE INDEX IF NOT EXISTS embeddings_vector_idx
        ON embeddings USING hnsw (embedding vector_cosine_ops);
      RAISE NOTICE 'embeddings.embedding pinned at vector(%) and HNSW index created (% rows)', emb_dim, emb_rows;
    ELSE
      RAISE NOTICE 'embeddings.embedding drift detected (% distinct dimensions across % rows) — HNSW skipped. Run `bun run db:check-embedding-drift` for the breakdown.', emb_distinct, emb_rows;
    END IF;
  ELSE
    RAISE NOTICE 'embeddings table empty — leaving column dimensionless. HNSW will be added on next migration run after data lands.';
  END IF;

  -- ── memories.embedding ────────────────────────────────────────────
  SELECT count(*)::int
    INTO mem_rows
    FROM memories
   WHERE embedding IS NOT NULL;

  IF mem_rows > 0 THEN
    SELECT count(DISTINCT vector_dims(embedding))::int,
           min(vector_dims(embedding))::int
      INTO mem_distinct, mem_dim
      FROM memories
     WHERE embedding IS NOT NULL;

    IF mem_distinct = 1 THEN
      EXECUTE format(
        'ALTER TABLE memories ALTER COLUMN embedding TYPE vector(%s) USING embedding::vector(%s)',
        mem_dim, mem_dim
      );
      CREATE INDEX IF NOT EXISTS memories_embedding_idx
        ON memories USING hnsw (embedding vector_cosine_ops);
      RAISE NOTICE 'memories.embedding pinned at vector(%) and HNSW index created (% rows)', mem_dim, mem_rows;
    ELSE
      RAISE NOTICE 'memories.embedding drift detected (% distinct dimensions across % rows) — HNSW skipped.', mem_distinct, mem_rows;
    END IF;
  ELSE
    RAISE NOTICE 'memories table empty — leaving column dimensionless. HNSW will be added on next migration run after data lands.';
  END IF;
END $$;
