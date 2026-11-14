-- Content not indexed because no embedding model was configured
-- (docs/MODULES.md → Capability gates). Without an embedding model nothing
-- is chunked or embedded; the item is recorded here instead, and the
-- catch-up job (src/core/rag/index-backlog.ts) indexes exactly these rows
-- once a model is bound, deleting each row it finishes.
CREATE TABLE IF NOT EXISTS index_backlog (
  kind text NOT NULL CHECK (kind IN ('document', 'note', 'repo')),
  source_id text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid,
  purpose text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, source_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS index_backlog_owner_idx ON index_backlog (owner_user_id);
