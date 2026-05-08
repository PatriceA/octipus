-- Phase 1 of hybrid skill discovery (see docs/plans/skill-discovery.md).
--
-- Adds four columns to `skills` so per-message discovery can union three
-- candidate sets (always_inject, trigger match, vector similarity) instead
-- of dumping every topic-assigned skill into every spawn's system prompt.
--
--   triggers              jsonb  — string[] keywords / phrases, case-insensitive
--                                  substring match against the user message.
--   description_embedding vector(768)
--                                — embedding of (name + description). NULL until
--                                  Phase 2 backfill runs. 768-dim matches the
--                                  default embedding model (see migration 0005).
--   description_hash      text   — sha256(name + description). Mismatch with
--                                  the live row signals a stale embedding.
--   always_inject         boolean — true ⇒ skill is always present for its topic
--                                  regardless of the message.
--
-- Additive only. All ALTERs use IF NOT EXISTS so the migration is safe to
-- re-run and non-blocking on prod. The pgvector extension was created in
-- migration 0005 — no CREATE EXTENSION here.

ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "triggers" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "description_embedding" vector(768);

ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "description_hash" text;

ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "always_inject" boolean NOT NULL DEFAULT false;

-- HNSW index for fast cosine similarity search (PostgreSQL with pgvector only;
-- PGlite uses brute-force scan and rejects HNSW with feature_not_supported).
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS "skills_description_embedding_idx" ON "skills" USING hnsw ("description_embedding" vector_cosine_ops);
EXCEPTION WHEN feature_not_supported OR undefined_object THEN
  -- PGlite does not support HNSW indexes; cosine search still works without an index
  NULL;
END $$;

-- Partial index — always_inject rows are a small hot set fetched on every spawn.
CREATE INDEX IF NOT EXISTS "skills_always_inject_idx" ON "skills" ("always_inject") WHERE "always_inject" = true;
