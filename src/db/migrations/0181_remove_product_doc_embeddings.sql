-- Product help now uses local on-demand search. Delete only generated, globally
-- owned manual chunks, never personal/workspace documents or user uploads.
DELETE FROM embeddings
WHERE user_id IS NULL AND workspace_id IS NULL
  AND purpose = 'document'
  AND metadata->>'source' = 'octipus-docs'
  AND doc_id IS NULL;
