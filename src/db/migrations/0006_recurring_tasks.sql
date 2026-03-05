CREATE TABLE IF NOT EXISTS recurring_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  cron_expression TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  action_type TEXT NOT NULL,
  action_config JSONB NOT NULL,
  is_enabled BOOLEAN DEFAULT true NOT NULL,
  last_run_at TIMESTAMP,
  next_run_at TIMESTAMP,
  run_count INTEGER DEFAULT 0 NOT NULL,
  last_error TEXT,
  status TEXT DEFAULT 'active' NOT NULL,
  created_at TIMESTAMP DEFAULT now() NOT NULL,
  updated_at TIMESTAMP DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS recurring_tasks_user_id_idx ON recurring_tasks(user_id);
CREATE INDEX IF NOT EXISTS recurring_tasks_next_run_idx ON recurring_tasks(next_run_at);
