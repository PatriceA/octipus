-- Background Companion reports: the server decides whether one reaches the owner.
CREATE TABLE IF NOT EXISTS companion_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id uuid REFERENCES companion_goals(id) ON DELETE CASCADE,
  matter_key text NOT NULL,
  impact text NOT NULL,
  evidence text NOT NULL,
  material_change text NOT NULL,
  deadline timestamptz,
  message text NOT NULL,
  text_hash text NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companion_reports_decision_chk CHECK (decision IN ('delivered', 'recorded'))
);
CREATE INDEX IF NOT EXISTS companion_reports_matter_idx ON companion_reports (user_id, workspace_id, matter_key, created_at);
