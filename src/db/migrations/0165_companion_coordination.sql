ALTER TABLE companion_goals ADD COLUMN dependencies jsonb NOT NULL DEFAULT '[]';
ALTER TABLE companion_actions ADD COLUMN token_cap integer;
CREATE TABLE companion_claims(resource text PRIMARY KEY,action_id uuid NOT NULL REFERENCES companion_actions(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE companion_wakes ADD COLUMN token_cap integer;
CREATE TABLE companion_claim_mutex(id text PRIMARY KEY);
INSERT INTO companion_claim_mutex(id) VALUES('dispatch');
CREATE TABLE companion_stage_reservations(pipeline_id uuid PRIMARY KEY REFERENCES pipelines(id) ON DELETE CASCADE,goal_id uuid NOT NULL REFERENCES companion_goals(id) ON DELETE CASCADE,tokens integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
