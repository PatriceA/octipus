ALTER TABLE tool_actions ADD COLUMN IF NOT EXISTS attempt_id text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS docker_project_owners (
  identity text PRIMARY KEY,
  repo_path text NOT NULL,
  user_id text NOT NULL,
  workspace_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
