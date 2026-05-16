-- Drop the legacy `source_type` column from `embeddings`.
--
-- Phase A (migration 0049) added `purpose` as the canonical
-- categorisation column and backfilled `source_type` → `purpose`.
-- Code has carried both columns notNull during the soft-migration
-- window; this migration completes the retirement.
--
-- Idempotent: safe to rerun.

DROP INDEX IF EXISTS embeddings_source_type_idx;

-- Drop the column. Postgres rewrites tables when dropping a NOT NULL
-- column on PG <12; on PG 12+ this is a metadata-only operation.
ALTER TABLE embeddings DROP COLUMN IF EXISTS source_type;
