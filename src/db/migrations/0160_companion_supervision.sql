CREATE TABLE companion_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_key uuid NOT NULL,
  title text NOT NULL,
  request text NOT NULL,
  outcome text NOT NULL,
  acceptance_criteria jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CONSTRAINT companion_goals_state_chk CHECK (state IN ('queued', 'active', 'waiting', 'needs_decision', 'paused', 'completed', 'cancelled')),
  priority integer NOT NULL DEFAULT 0 CONSTRAINT companion_goals_priority_chk CHECK (priority BETWEEN 0 AND 3),
  token_budget integer CONSTRAINT companion_goals_budget_chk CHECK (token_budget IS NULL OR token_budget BETWEEN 1 AND 1000000000),
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  work_plan_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  protection_level integer NOT NULL DEFAULT 1 CONSTRAINT companion_goals_protection_chk CHECK (protection_level BETWEEN 1 AND 4),
  revision integer NOT NULL DEFAULT 0,
  completion_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX companion_goals_request_idx ON companion_goals(user_id, workspace_id, request_key);
CREATE INDEX companion_goals_scope_idx ON companion_goals(user_id, workspace_id, state);
--> statement-breakpoint
CREATE TABLE companion_session_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES companion_goals(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pipeline_id uuid REFERENCES pipelines(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  origin text NOT NULL DEFAULT 'adopted' CONSTRAINT companion_links_origin_chk CHECK (origin IN ('adopted', 'created')),
  ownership text NOT NULL DEFAULT 'owner' CONSTRAINT companion_links_ownership_chk CHECK (ownership IN ('owner', 'observer')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
--> statement-breakpoint
CREATE INDEX companion_links_goal_idx ON companion_session_links(goal_id);
CREATE INDEX companion_links_session_idx ON companion_session_links(session_id);
CREATE UNIQUE INDEX companion_links_session_once_idx ON companion_session_links(goal_id, session_id) WHERE pipeline_id IS NULL;
CREATE UNIQUE INDEX companion_links_pipeline_once_idx ON companion_session_links(goal_id, pipeline_id) WHERE pipeline_id IS NOT NULL;
CREATE UNIQUE INDEX companion_links_session_owner_idx ON companion_session_links(session_id) WHERE pipeline_id IS NULL AND active AND ownership = 'owner';
CREATE UNIQUE INDEX companion_links_pipeline_owner_idx ON companion_session_links(pipeline_id) WHERE pipeline_id IS NOT NULL AND active AND ownership = 'owner';
