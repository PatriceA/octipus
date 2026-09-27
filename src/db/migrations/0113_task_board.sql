-- Work board on `tasks` (after Paperclip): an assignee (a user, a role or a
-- swarm node), an atomic checkout so two agents never work the same task, and
-- a comment thread per task. Hand-written and idempotent.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_kind text;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_ref text;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checked_out_by text;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checkout_run_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tasks_user_assignee_idx ON tasks(user_id, assignee_kind, assignee_ref, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_kind text NOT NULL,
  author_ref text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS task_comments_task_idx ON task_comments(task_id, created_at);
