ALTER TABLE companion_goals ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE companion_actions ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE companion_actions ADD COLUMN pipeline_id uuid REFERENCES pipelines(id) ON DELETE SET NULL;
ALTER TABLE companion_actions DROP CONSTRAINT IF EXISTS companion_actions_kind_check;
ALTER TABLE companion_actions DROP CONSTRAINT IF EXISTS companion_actions_kind_chk;
ALTER TABLE companion_actions ADD CONSTRAINT companion_actions_kind_chk CHECK(kind IN ('start_session','message_session','steer_session','resume_pipeline'));
ALTER TABLE companion_incidents ADD COLUMN attempt_allowance integer NOT NULL DEFAULT 0;
ALTER TABLE companion_incidents ADD COLUMN attempt_approvals jsonb NOT NULL DEFAULT '[]';
ALTER TABLE companion_incidents ADD COLUMN attempt_limit integer;
