CREATE TABLE companion_settings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, enabled boolean NOT NULL DEFAULT false,
 model_name text NOT NULL DEFAULT '', autonomy text NOT NULL DEFAULT 'observe' CHECK (autonomy IN ('observe','coordinate','repair')),
 options jsonb NOT NULL DEFAULT '{}'::jsonb, supervisor_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
 revision integer NOT NULL DEFAULT 0, approved_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companion_settings_scope_idx ON companion_settings(user_id,workspace_id);
--> statement-breakpoint
CREATE TABLE companion_events (
 seq bigserial PRIMARY KEY, goal_id uuid NOT NULL REFERENCES companion_goals(id) ON DELETE CASCADE,
 session_id uuid, kind text NOT NULL, source_id text NOT NULL, state text NOT NULL,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companion_events_pending_idx ON companion_events(consumed_at,seq);
CREATE INDEX companion_events_goal_idx ON companion_events(goal_id,seq);
CREATE UNIQUE INDEX companion_events_stall_idx ON companion_events(goal_id,kind,source_id) WHERE kind='stall';
--> statement-breakpoint
CREATE TABLE companion_wakes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings_id uuid NOT NULL REFERENCES companion_settings(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, generation text NOT NULL DEFAULT '',
 status text NOT NULL CHECK (status IN ('running','completed','failed','unknown')), event_seqs jsonb NOT NULL,
 lease_token uuid NOT NULL, lease_until timestamptz NOT NULL, result text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companion_wakes_active_idx ON companion_wakes(settings_id) WHERE status IN ('running','unknown');
--> statement-breakpoint
CREATE FUNCTION companion_observe_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean; target_session uuid; actor_user text; actor_workspace uuid;
BEGIN
 IF TG_TABLE_NAME = 'pipelines' THEN
   changed := OLD.status IS DISTINCT FROM NEW.status OR OLD.current_node_key IS DISTINCT FROM NEW.current_node_key
     OR OLD.metadata->'environmentBlock' IS DISTINCT FROM NEW.metadata->'environmentBlock'
     OR OLD.metadata->'pendingDecision' IS DISTINCT FROM NEW.metadata->'pendingDecision'
     OR OLD.metadata->'pendingApproval' IS DISTINCT FROM NEW.metadata->'pendingApproval'
     OR OLD.metadata->'permissionProfile' IS DISTINCT FROM NEW.metadata->'permissionProfile';
   target_session := NEW.session_id;
   actor_user := NEW.user_id::text; actor_workspace := NEW.workspace_id;
 ELSIF TG_TABLE_NAME = 'sessions' THEN
   changed := OLD.status IS DISTINCT FROM NEW.status;
   target_session := NEW.id;
   actor_user := NEW.user_id::text; actor_workspace := NEW.workspace_id;
 ELSIF TG_TABLE_NAME = 'companion_actions' THEN
   changed := OLD.status IS DISTINCT FROM NEW.status;
   target_session := NEW.session_id;
   SELECT user_id::text,workspace_id INTO actor_user,actor_workspace FROM companion_goals WHERE id=NEW.goal_id;
 ELSE
   IF TG_TABLE_NAME = 'agents' AND NEW.parent_agent_id IS NOT NULL THEN RETURN NEW; END IF;
   changed := OLD.status IS DISTINCT FROM NEW.status;
   target_session := NEW.session_id;
   actor_user := NEW.user_id::text; actor_workspace := NEW.workspace_id;
 END IF;
 IF NOT changed THEN RETURN NEW; END IF;
 INSERT INTO companion_events(goal_id,session_id,kind,source_id,state)
 SELECT DISTINCT g.id,target_session,TG_TABLE_NAME,NEW.id::text,NEW.status::text
 FROM companion_goals g JOIN companion_session_links l ON l.goal_id=g.id
 JOIN sessions s ON s.id=l.session_id
 WHERE l.session_id=target_session AND l.active AND g.state IN ('queued','active','waiting','needs_decision')
   AND g.user_id=s.user_id AND g.workspace_id=s.workspace_id AND s.kind='chat' AND s.group_channel_id IS NULL
   AND g.user_id::text=actor_user AND g.workspace_id=actor_workspace
   AND (TG_TABLE_NAME <> 'pipelines' OR l.pipeline_id IS NULL OR l.pipeline_id::text=NEW.id::text);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER companion_pipeline_event AFTER UPDATE ON pipelines FOR EACH ROW EXECUTE FUNCTION companion_observe_execution();
CREATE TRIGGER companion_agent_event AFTER UPDATE OF status ON agents FOR EACH ROW EXECUTE FUNCTION companion_observe_execution();
CREATE TRIGGER companion_session_event AFTER UPDATE OF status ON sessions FOR EACH ROW EXECUTE FUNCTION companion_observe_execution();
CREATE TRIGGER companion_action_event AFTER UPDATE OF status ON companion_actions FOR EACH ROW EXECUTE FUNCTION companion_observe_execution();
--> statement-breakpoint
CREATE FUNCTION companion_observe_goal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD.state IS NOT DISTINCT FROM NEW.state THEN RETURN NEW; END IF;
 INSERT INTO companion_events(goal_id,kind,source_id,state) VALUES (NEW.id,'goal',NEW.id::text,NEW.state);
 RETURN NEW;
END $$;
CREATE TRIGGER companion_goal_event AFTER INSERT ON companion_goals FOR EACH ROW EXECUTE FUNCTION companion_observe_goal();
CREATE TRIGGER companion_goal_state_event AFTER UPDATE OF state ON companion_goals FOR EACH ROW EXECUTE FUNCTION companion_observe_goal();
--> statement-breakpoint
INSERT INTO companion_events(goal_id,kind,source_id,state)
SELECT id,'goal',id::text,state FROM companion_goals WHERE state IN ('queued','active','waiting','needs_decision');
