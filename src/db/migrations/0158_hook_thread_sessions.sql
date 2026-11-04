CREATE TABLE IF NOT EXISTS hook_thread_sessions (
  hook_id uuid NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
  thread_key text NOT NULL,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hook_id, thread_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hook_thread_sessions_last_used_idx ON hook_thread_sessions (last_used_at);
