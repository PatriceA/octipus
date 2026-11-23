-- Archived notes are out of every knowledge search (src/core/rag/embeddings.ts,
-- notArchivedNoteSql). Archiving keeps a note's embedding rows, and each search
-- leaves out a row whose source_id is 'note:' || id of an archived note with
-- NOT EXISTS over this index: it holds only archived notes, keyed by the
-- source_id their chunks carry, so the anti-join reads a handful of entries
-- (or probes one per candidate) instead of scanning notes on every recall.
CREATE INDEX IF NOT EXISTS notes_archived_source_idx ON notes (('note:' || id::text)) WHERE archived_at IS NOT NULL;
