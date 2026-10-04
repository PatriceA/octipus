-- Who deactivated a user (docs/plans/coworking-spec.md §4.1, L7/L8): 'admin'
-- or 'scim:<orgId>'. `setUserActive` (src/security/user-lifecycle.ts) is the
-- only writer of `is_active` and records it, so a SCIM `active: true` never
-- re-enables an account an admin switched off.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by text;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_deactivated_by_check;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_deactivated_by_check CHECK (deactivated_by IS NULL OR deactivated_by = 'admin' OR deactivated_by LIKE 'scim:%');
--> statement-breakpoint
-- Accounts already disabled before this column existed: the source is unknown,
-- so they count as an admin's decision (SCIM may not undo it).
UPDATE users SET deactivated_by = 'admin' WHERE is_active = false AND deactivated_by IS NULL;
