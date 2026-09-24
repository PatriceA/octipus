-- A draft of 0110 created `monitors` without `role`, and a database that ran
-- it counts 0110 as applied. Add the column where it is missing; a no-op on
-- every database that ran the committed 0110. A row from the draft has no
-- recorded role, so it cannot be scoped to a tool set on replay: cancel it.
ALTER TABLE monitors ADD COLUMN IF NOT EXISTS role text;
--> statement-breakpoint
UPDATE monitors SET role = 'general', status = 'cancelled' WHERE role IS NULL;
--> statement-breakpoint
ALTER TABLE monitors ALTER COLUMN role SET NOT NULL;
