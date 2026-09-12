CREATE TABLE tool_actions (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  session_id text NOT NULL,
  agent_id text NOT NULL,
  pipeline_id text,
  node_key text,
  tool_id text NOT NULL,
  tool_name text NOT NULL,
  argument_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'uncertain', 'not_executed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  reviewed_at timestamptz,
  review_id text
);
--> statement-breakpoint
CREATE INDEX tool_actions_recovery_idx ON tool_actions (user_id, session_id, reviewed_at);
--> statement-breakpoint
CREATE INDEX tool_actions_pipeline_idx ON tool_actions (user_id, pipeline_id);
--> statement-breakpoint
CREATE FUNCTION delete_session_tool_actions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM tool_actions WHERE session_id = OLD.id::text;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sessions_delete_tool_actions AFTER DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION delete_session_tool_actions();
--> statement-breakpoint
CREATE FUNCTION delete_user_tool_actions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM tool_actions WHERE user_id = OLD.id::text;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_delete_tool_actions AFTER DELETE ON users
FOR EACH ROW EXECUTE FUNCTION delete_user_tool_actions();
