-- Create agent status enum
DO $$ BEGIN
  CREATE TYPE agent_status AS ENUM ('running', 'completed', 'failed', 'stopped');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create agents table for persistent agent history
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  session_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'general',
  model TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  status agent_status NOT NULL DEFAULT 'running',
  iterations INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  tool_calls JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS agents_session_id_idx ON agents (session_id);
CREATE INDEX IF NOT EXISTS agents_user_id_idx ON agents (user_id);
CREATE INDEX IF NOT EXISTS agents_status_idx ON agents (status);
CREATE INDEX IF NOT EXISTS agents_created_at_idx ON agents (created_at);
