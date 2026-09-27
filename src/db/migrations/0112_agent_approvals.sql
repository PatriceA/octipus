-- Agent approvals were held only in process memory, so a restart lost them and
-- answering one failed with "not found". The row is now the record of truth.
CREATE TABLE IF NOT EXISTS agent_approvals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid,
  agent_id text NOT NULL,
  summary text NOT NULL,
  question text NOT NULL,
  options jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  response text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_approvals_user_status_idx ON agent_approvals(user_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_approvals_status_idx ON agent_approvals(status);
