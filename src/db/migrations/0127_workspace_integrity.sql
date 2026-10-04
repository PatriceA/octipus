-- Workspace integrity (docs/plans/coworking-spec.md §4.3, S0c).
--
-- notes, tasks, knowledge_links, workspace_repos and background_jobs carry a
-- workspace_id with no foreign key, so some rows name a workspace that is gone
-- or that belongs to another user. Those rows fall back to user-level
-- (workspace_id NULL), the same thing ON DELETE SET NULL would have done, and
-- then the five columns get that foreign key.
--
-- 1. Notes about to be reset could collide with the user's existing user-level
--    notes, or with each other, on notes_user_slug_uidx (user_id, slug) WHERE
--    workspace_id IS NULL. Within each (user_id, slug) group of {user-level
--    notes ∪ notes about to be reset} one note keeps its slug — an existing
--    user-level note when there is one (its slug is what [[links]] already
--    point at), otherwise the oldest — and the others become
--    `slug-<first 8 chars of id>`.
UPDATE notes SET slug = notes.slug || '-' || left(notes.id::text, 8)
FROM (
  SELECT n.id,
         row_number() OVER (
           PARTITION BY n.user_id, n.slug
           ORDER BY (n.workspace_id IS NULL) DESC, n.created_at, n.id
         ) AS rn
  FROM notes n
  WHERE n.workspace_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = n.workspace_id AND w.user_id = n.user_id)
) ranked
WHERE ranked.id = notes.id AND ranked.rn > 1;
--> statement-breakpoint
UPDATE notes SET workspace_id = NULL
WHERE workspace_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = notes.workspace_id AND w.user_id = notes.user_id);
--> statement-breakpoint
-- 2. The same reset for the other four tables (no slug to keep unique).
UPDATE tasks SET workspace_id = NULL
WHERE workspace_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = tasks.workspace_id AND w.user_id = tasks.user_id);
--> statement-breakpoint
UPDATE knowledge_links SET workspace_id = NULL
WHERE workspace_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = knowledge_links.workspace_id AND w.user_id = knowledge_links.user_id);
--> statement-breakpoint
UPDATE workspace_repos SET workspace_id = NULL
WHERE workspace_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = workspace_repos.workspace_id AND w.user_id = workspace_repos.user_id);
--> statement-breakpoint
UPDATE background_jobs SET workspace_id = NULL
WHERE workspace_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = background_jobs.workspace_id AND w.user_id = background_jobs.user_id);
--> statement-breakpoint
-- 3. Within each remaining workspace, a slug names one note: the oldest keeps
--    it, younger duplicates are renamed the same way, so a unique index on
--    (workspace_id, slug) can be created (S1).
UPDATE notes SET slug = notes.slug || '-' || left(notes.id::text, 8)
FROM (
  SELECT n.id,
         row_number() OVER (PARTITION BY n.workspace_id, n.slug ORDER BY n.created_at, n.id) AS rn
  FROM notes n
  WHERE n.workspace_id IS NOT NULL
) ranked
WHERE ranked.id = notes.id AND ranked.rn > 1;
--> statement-breakpoint
-- 4. Foreign keys, with the personal semantics every other workspace_id
--    column already has: deleting a workspace leaves its rows user-level.
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_workspace_id_fkey;
--> statement-breakpoint
ALTER TABLE notes ADD CONSTRAINT notes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_workspace_id_fkey;
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT tasks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE knowledge_links DROP CONSTRAINT IF EXISTS knowledge_links_workspace_id_fkey;
--> statement-breakpoint
ALTER TABLE knowledge_links ADD CONSTRAINT knowledge_links_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE workspace_repos DROP CONSTRAINT IF EXISTS workspace_repos_workspace_id_fkey;
--> statement-breakpoint
ALTER TABLE workspace_repos ADD CONSTRAINT workspace_repos_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE background_jobs DROP CONSTRAINT IF EXISTS background_jobs_workspace_id_fkey;
--> statement-breakpoint
ALTER TABLE background_jobs ADD CONSTRAINT background_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
