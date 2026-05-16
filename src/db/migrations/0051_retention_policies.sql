-- Memory-redesign Phase A.5 — per-purpose retention policy.
-- See `.octipus/memory-redesign.md` and `.octipus/memory-redesign-schema.sql`.
--
-- Replaces the hardcoded "stale agent_output > 30d" sweep with a row-driven
-- policy keyed on the `purpose` column added in Phase A. Cleanup loop reads
-- this table.
--
-- Idempotent: safe to rerun. Defaults are seeded with ON CONFLICT DO NOTHING
-- so an operator-edited row survives a re-run.

CREATE TABLE IF NOT EXISTS retention_policies (
  purpose          text PRIMARY KEY,
  max_age_days     integer,
  lfu_min_access   integer,
  lfu_min_age_days integer,
  notes            text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO retention_policies (purpose, max_age_days, lfu_min_access, lfu_min_age_days, notes) VALUES
  ('document',           NULL, NULL, NULL, 'Tied to documents row lifecycle; cascade delete handles it.'),
  ('code',               NULL, NULL, NULL, 'Re-indexed on file change via content_sha256 upsert.'),
  ('image_description',  NULL, NULL, NULL, 'Tied to documents row lifecycle.'),
  ('knowledge_artifact', 365,  1,    180,  'Agent-flagged "worth remembering" outputs.'),
  ('message',            90,   NULL, NULL, 'Conversation chunks. Compaction handles long-term recall.'),
  ('ephemeral',          7,    NULL, NULL, 'Legacy agent_output rows; should be empty after Phase B.')
ON CONFLICT (purpose) DO NOTHING;
