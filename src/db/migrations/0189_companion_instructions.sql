-- The owner's standing instructions for Companion, each with its verified quote.
CREATE TABLE IF NOT EXISTS companion_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id uuid REFERENCES companion_goals(id) ON DELETE CASCADE,
  text text NOT NULL,
  quote text NOT NULL,
  source_message_id uuid,
  replaces_id uuid,
  state text NOT NULL DEFAULT 'active',
  retired_reason text,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT companion_instructions_state_chk CHECK (state IN ('active', 'retired'))
);
CREATE INDEX IF NOT EXISTS companion_instructions_scope_idx ON companion_instructions (user_id, workspace_id, state);
