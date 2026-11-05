ALTER TABLE companion_actions ADD COLUMN authority_settings_id uuid;
ALTER TABLE companion_actions ADD COLUMN authority_revision integer;
ALTER TABLE companion_settings ADD COLUMN reconciled_revision integer NOT NULL DEFAULT -1;
CREATE TABLE companion_incidents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), goal_id uuid NOT NULL REFERENCES companion_goals(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 fingerprint text NOT NULL, category text NOT NULL, summary text NOT NULL,
 state text NOT NULL DEFAULT 'observed' CHECK (state IN ('observed','repairing','verifying','resolved','escalated')),
 strategies jsonb NOT NULL DEFAULT '[]', evidence_id uuid, revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companion_incidents_identity_idx ON companion_incidents(goal_id,session_id,fingerprint);
ALTER TABLE companion_goals ADD COLUMN execution_policy jsonb;
ALTER TABLE companion_actions ADD COLUMN incident_id uuid;
ALTER TABLE companion_actions ADD COLUMN strategy_index integer;
