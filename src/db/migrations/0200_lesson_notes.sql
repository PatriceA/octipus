-- Lesson notes (docs/plans/learning-notes-and-skill-discovery.md, "A lesson note").
--
-- A note written by a learning review is now its own kind: note_kind
-- 'lesson' (it keeps the tag 'session-learning') and its embedding rows have
-- purpose 'lesson', so recall can tell it from the user's own notes.
--
-- 1. Notes a learning review wrote that are still plain notes become lessons:
--    the review's slug ('learning-<hash>'), its tag, and the frontmatter key it
--    set ('learningJobId'). A note the user tagged #session-learning
--    themselves has neither the slug nor the key and stays a note. Never a
--    note of a shared space: reviews write to personal workspaces (or the user
--    level), and a space's notes are not one user's lessons.
-- 2. Their 'note' embedding rows (source_id 'note:<id>') become 'lesson' rows,
--    except a row whose 'lesson' twin (same source, content, user, workspace)
--    already exists: renaming it would break the embeddings dedup unique index.
-- 3. Such a leftover 'note' row is an exact copy of its twin and is removed, so
--    no chunk of a lesson is served as an ordinary note.
--
-- Bodies are not rewritten (the legacy "Evidence: session ..." footer goes on
-- the next merge). Safe to run twice: every statement only matches what is
-- still left to convert.
UPDATE notes SET note_kind = 'lesson'
WHERE note_kind = 'note' AND 'session-learning' = ANY(tags)
  AND slug LIKE 'learning-%' AND frontmatter ? 'learningJobId'
  AND (workspace_id IS NULL OR EXISTS (SELECT 1 FROM workspaces w WHERE w.id = notes.workspace_id AND w.kind = 'personal'));
--> statement-breakpoint
UPDATE embeddings e SET purpose = 'lesson'
FROM notes n
WHERE n.note_kind = 'lesson'
  AND e.source_id = 'note:' || n.id::text
  AND e.purpose = 'note'
  AND NOT EXISTS (
    SELECT 1 FROM embeddings twin
    WHERE twin.purpose = 'lesson'
      AND twin.source_id = e.source_id
      AND twin.content_sha256 = e.content_sha256
      AND twin.user_id IS NOT DISTINCT FROM e.user_id
      AND twin.workspace_id IS NOT DISTINCT FROM e.workspace_id
  );
--> statement-breakpoint
DELETE FROM embeddings e
USING notes n
WHERE n.note_kind = 'lesson'
  AND e.source_id = 'note:' || n.id::text
  AND e.purpose = 'note'
  AND EXISTS (
    SELECT 1 FROM embeddings twin
    WHERE twin.purpose = 'lesson'
      AND twin.source_id = e.source_id
      AND twin.content_sha256 = e.content_sha256
      AND twin.user_id IS NOT DISTINCT FROM e.user_id
      AND twin.workspace_id IS NOT DISTINCT FROM e.workspace_id
  );
