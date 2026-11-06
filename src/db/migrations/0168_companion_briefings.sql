ALTER TABLE companion_actions DROP CONSTRAINT companion_actions_kind_chk;
ALTER TABLE companion_actions ADD CONSTRAINT companion_actions_kind_chk CHECK (kind IN ('start_session','message_session','steer_session','resume_pipeline','request_briefing'));
ALTER TABLE companion_actions ADD COLUMN briefing_context_key text;
