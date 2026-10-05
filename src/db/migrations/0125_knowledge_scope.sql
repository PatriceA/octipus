-- Knowledge scope (docs/plans/coworking-spec.md §4.1, leak L2). The knowledge
-- base was install-wide: chunks were stored without an owner and every reader
-- saw every chunk. Reads and writes now go through a KnowledgeScope
-- (src/core/rag/knowledge-scope.ts); this migration gives existing rows their
-- owner, makes dedup per owner, and lets cleanup runs and admin install-scope
-- access be attributed.
--
-- Owner backfill, for rows with no user_id only:
--   1. document rows (uploads and research reports, both `documents` rows):
--      from `documents` via doc_id or the `doc:<id>` source id. documents.user_id
--      is text, so it is cast only when it is a UUID.
--   2. note rows (`note:<id>`): from `notes`.
--   3. file rows (filesystem auto-index, knowledge tool, POST /api/knowledge/index):
--      from their path `<rootPath>/users/<uid>/workspaces/<segment>/files/…`;
--      segment `default` is that user's default workspace, a workspace uuid of
--      that user is itself, anything else leaves the row user-level.
-- Product docs (metadata.source = 'octipus-docs') stay user_id NULL. Rows that
-- match none of these stay install rows: admins (audited) and system jobs only.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'knowledge_install_access';
--> statement-breakpoint
ALTER TABLE cleanup_audit_log ADD COLUMN IF NOT EXISTS user_id uuid;
--> statement-breakpoint
ALTER TABLE cleanup_audit_log ADD COLUMN IF NOT EXISTS workspace_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cleanup_audit_log_user_id_idx ON cleanup_audit_log(user_id);
--> statement-breakpoint
UPDATE embeddings e
SET user_id = d.user_id::uuid,
    workspace_id = COALESCE(e.workspace_id, d.workspace_id)
FROM documents d
WHERE e.user_id IS NULL
  AND (e.doc_id = d.id OR e.source_id = 'doc:' || d.id::text)
  AND d.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
UPDATE embeddings e
SET user_id = n.user_id,
    workspace_id = COALESCE(e.workspace_id, n.workspace_id)
FROM notes n
WHERE e.user_id IS NULL
  AND e.source_id = 'note:' || n.id::text;
--> statement-breakpoint
WITH file_rows AS (
  SELECT id, parts[1]::uuid AS uid, parts[2] AS segment
  FROM (
    SELECT e.id,
           regexp_match(
             e.source_id,
             '[/\\]users[/\\]([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[/\\]workspaces[/\\]([^/\\]+)[/\\]files[/\\]'
           ) AS parts
    FROM embeddings e
    WHERE e.user_id IS NULL
      AND (e.metadata->>'source') IS DISTINCT FROM 'octipus-docs'
  ) matched
  WHERE parts IS NOT NULL
)
UPDATE embeddings e
SET user_id = f.uid,
    workspace_id = COALESCE(e.workspace_id, CASE
      WHEN f.segment = 'default' THEN (
        SELECT w.id FROM workspaces w
        WHERE w.user_id = f.uid AND w.is_default
        ORDER BY w.created_at
        LIMIT 1
      )
      ELSE (
        SELECT w.id FROM workspaces w
        WHERE w.user_id = f.uid AND w.id::text = lower(f.segment)
      )
    END)
FROM file_rows f
WHERE e.id = f.id
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = f.uid);
--> statement-breakpoint
DROP INDEX IF EXISTS embeddings_dedup_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_dedup_idx
  ON embeddings(purpose, source_id, content_sha256, user_id, workspace_id) NULLS NOT DISTINCT;
