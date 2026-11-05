ALTER TABLE companion_goals ADD COLUMN source_session_id uuid REFERENCES sessions(id) ON DELETE SET NULL;
ALTER TABLE companion_goals ADD COLUMN flow_label jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE TABLE companion_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 goal_id uuid NOT NULL REFERENCES companion_goals(id) ON DELETE CASCADE,
 request_key uuid NOT NULL,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 generation text NOT NULL DEFAULT '',
 protection_level integer NOT NULL DEFAULT 1,
 flow_label jsonb NOT NULL DEFAULT '{}'::jsonb,
 kind text NOT NULL CHECK (kind IN ('start_session', 'message_session', 'steer_session')),
 message text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','unknown','cancelled')),
 lease_token uuid,
 lease_until timestamptz,
 result text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX companion_actions_request_idx ON companion_actions(goal_id,request_key);
CREATE INDEX companion_actions_due_idx ON companion_actions(status,created_at);
CREATE UNIQUE INDEX companion_actions_session_claim_idx ON companion_actions(session_id) WHERE status IN ('running','unknown') AND kind <> 'steer_session';
