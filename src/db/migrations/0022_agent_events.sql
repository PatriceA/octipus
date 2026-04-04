-- Agent events table — persists agent iterations/events across server restarts
-- Events older than 1 day are cleaned up on startup
CREATE TABLE IF NOT EXISTS agent_events (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_events_agent_id_idx ON agent_events (agent_id);
CREATE INDEX IF NOT EXISTS agent_events_session_id_idx ON agent_events (session_id);
CREATE INDEX IF NOT EXISTS agent_events_created_at_idx ON agent_events (created_at);
