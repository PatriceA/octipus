-- Coworking S6 (guests) and S7 (the remote member representation),
-- docs/plans/coworking-spec.md §10-11, docs/SPACES.md (Guests, Across installs).

-- A guest's scope ({ rooms, folders }) lives on the membership; every other
-- role has none. Guests that joined before scopes existed get the empty scope.
UPDATE workspace_members SET scope = NULL WHERE role <> 'guest' AND scope IS NOT NULL;
--> statement-breakpoint
UPDATE workspace_members SET scope = '{"rooms":[],"folders":[]}'::jsonb WHERE role = 'guest' AND scope IS NULL;
--> statement-breakpoint
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_scope_chk;
--> statement-breakpoint
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_scope_chk CHECK ((role = 'guest') = (scope IS NOT NULL));
--> statement-breakpoint
UPDATE workspace_invites SET scope = NULL WHERE role <> 'guest' AND scope IS NOT NULL;
--> statement-breakpoint
ALTER TABLE workspace_invites DROP CONSTRAINT IF EXISTS workspace_invites_scope_chk;
--> statement-breakpoint
ALTER TABLE workspace_invites ADD CONSTRAINT workspace_invites_scope_chk CHECK (role = 'guest' OR scope IS NULL);
--> statement-breakpoint

-- Users: local accounts, or remote members of a space hosted here (S7).
ALTER TABLE users ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'local';
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS remote_instance_id text;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS remote_user_ref text;
--> statement-breakpoint
-- A leading "~" marks a remote member's username ("~name@<instance>"): local
-- usernames that already start with one are renamed before the CHECK.
UPDATE users
SET username = 'renamed-' || substr(replace(id::text, '-', ''), 1, 8) || '-' || ltrim(username, '~')
WHERE kind = 'local' AND left(username, 1) = '~';
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_kind_chk;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_kind_chk CHECK (
  (kind = 'local' AND left(username, 1) <> '~' AND remote_instance_id IS NULL AND remote_user_ref IS NULL)
  OR (kind = 'remote' AND left(username, 1) = '~' AND email IS NULL AND password_hash IS NULL
      AND is_admin = false AND totp_enabled = false
      AND remote_instance_id IS NOT NULL AND remote_user_ref IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_remote_ref_uidx ON users(remote_instance_id, remote_user_ref) WHERE kind = 'remote';
