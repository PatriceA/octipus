-- What started each agent (Mission control, docs/MISSION-CONTROL.md).
-- Existing rows stay NULL: their origin was never recorded, and guessing it
-- from the role or channel would show a wrong "Started by".
ALTER TABLE agents ADD COLUMN IF NOT EXISTS source text;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN IF NOT EXISTS origin jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agents_user_created_idx ON agents (user_id, created_at);
