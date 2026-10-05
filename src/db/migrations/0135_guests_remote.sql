-- Coworking S6 (guests) and S7 (the remote member representation),
-- docs/plans/coworking-spec.md §10-11, docs/SPACES.md (Guests, Across installs).

-- A guest's scope ({ rooms, folders }) lives on the membership; every other
-- role has none. Guests that joined before scopes existed get the empty scope.
UPDATE workspace_members SET scope = NULL WHERE role <> 'guest' AND scope IS NOT NULL;
--> statement-breakpoint
UPDATE workspace_members SET scope = '{"rooms":[],"folders":[]}'::jsonb WHERE role = 'guest' AND scope IS NULL;
--> statement-breakpoint
-- Before S6 a guest scope was any JSON object. One that is not the shape
-- `parseGuestScope` accepts (an object of `rooms`: uuid strings and `folders`:
-- relative paths, at most 100 each) is reset to the empty scope: the least
-- access. What this cannot check (a folder's slug form) reads as the empty
-- scope at runtime, logged (`storedGuestScope`).
CREATE OR REPLACE FUNCTION guest_scope_is_valid(s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; e jsonb; f text; seg text;
BEGIN
  IF s IS NULL OR jsonb_typeof(s) <> 'object' THEN RETURN false; END IF;
  FOR k IN SELECT jsonb_object_keys(s) LOOP
    IF k NOT IN ('rooms', 'folders') THEN RETURN false; END IF;
  END LOOP;
  IF s->'rooms' IS NOT NULL THEN
    IF jsonb_typeof(s->'rooms') <> 'array' OR jsonb_array_length(s->'rooms') > 100 THEN RETURN false; END IF;
    FOR e IN SELECT jsonb_array_elements(s->'rooms') LOOP
      IF jsonb_typeof(e) <> 'string' OR (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
    END LOOP;
  END IF;
  IF s->'folders' IS NOT NULL THEN
    IF jsonb_typeof(s->'folders') <> 'array' OR jsonb_array_length(s->'folders') > 100 THEN RETURN false; END IF;
    FOR e IN SELECT jsonb_array_elements(s->'folders') LOOP
      IF jsonb_typeof(e) <> 'string' THEN RETURN false; END IF;
      f := btrim(e #>> '{}');
      IF length(f) > 512 OR position(chr(92) in f) > 0 OR btrim(f, '/') = '' THEN RETURN false; END IF;
      FOR seg IN SELECT regexp_split_to_table(f, '/') LOOP
        IF seg <> '' AND (seg IN ('.', '..') OR seg <> btrim(seg)) THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END IF;
  RETURN true;
END $$;
--> statement-breakpoint
UPDATE workspace_members SET scope = '{"rooms":[],"folders":[]}'::jsonb
WHERE role = 'guest' AND NOT guest_scope_is_valid(scope);
--> statement-breakpoint
UPDATE workspace_invites SET scope = '{"rooms":[],"folders":[]}'::jsonb
WHERE role = 'guest' AND scope IS NOT NULL AND NOT guest_scope_is_valid(scope);
--> statement-breakpoint
DROP FUNCTION IF EXISTS guest_scope_is_valid(jsonb);
--> statement-breakpoint
-- Before S6 a guest entered the rooms they had a `room_members` row in; now
-- a guest's rooms are their scope's. Carry those rooms into the scope, and
-- keep only ids of rooms of the guest's own space (sorted, at most 100).
UPDATE workspace_members m SET scope = jsonb_build_object(
  'rooms', COALESCE((
    SELECT jsonb_agg(r.id ORDER BY r.id) FROM (
      SELECT s.id::text AS id FROM sessions s
      WHERE s.workspace_id = m.workspace_id AND s.kind = 'room'
        AND (s.id::text IN (SELECT lower(x) FROM jsonb_array_elements_text(COALESCE(m.scope->'rooms', '[]'::jsonb)) x)
             OR s.id IN (SELECT rm.session_id FROM room_members rm WHERE rm.user_id = m.user_id))
      ORDER BY s.id LIMIT 100
    ) r), '[]'::jsonb),
  'folders', COALESCE(m.scope->'folders', '[]'::jsonb))
WHERE m.role = 'guest';
--> statement-breakpoint
-- A pending guest invite has no account yet, so no `room_members` row: its
-- rooms are only restricted to the rooms of its space.
UPDATE workspace_invites i SET scope = jsonb_build_object(
  'rooms', COALESCE((
    SELECT jsonb_agg(r.id ORDER BY r.id) FROM (
      SELECT s.id::text AS id FROM sessions s
      WHERE s.workspace_id = i.workspace_id AND s.kind = 'room'
        AND s.id::text IN (SELECT lower(x) FROM jsonb_array_elements_text(COALESCE(i.scope->'rooms', '[]'::jsonb)) x)
      ORDER BY s.id LIMIT 100
    ) r), '[]'::jsonb),
  'folders', COALESCE(i.scope->'folders', '[]'::jsonb))
WHERE i.role = 'guest' AND i.scope IS NOT NULL;
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
-- usernames that already start with one are renamed before the CHECK, to
-- "renamed-<8 hex of the id>-<name>" (with a counter when even that is
-- taken), and each rename is audited (`user_updated`, `username_renamed`)
-- so an admin can tell the user their new login name.
DO $$ DECLARE u record; base text; candidate text; n int; BEGIN
  FOR u IN SELECT id, username FROM users WHERE kind = 'local' AND left(username, 1) = '~' ORDER BY created_at, id LOOP
    base := 'renamed-' || substr(replace(u.id::text, '-', ''), 1, 8);
    candidate := base || '-' || ltrim(u.username, '~');
    n := 1;
    WHILE EXISTS (SELECT 1 FROM users WHERE username = candidate) LOOP
      n := n + 1;
      candidate := base || '-' || n || '-' || ltrim(u.username, '~');
    END LOOP;
    UPDATE users SET username = candidate WHERE id = u.id;
    INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
    VALUES (u.id::text, 'user_updated', 'user', u.id::text,
            jsonb_build_object('event', 'username_renamed', 'from', u.username, 'to', candidate,
                               'reason', 'a leading ~ marks members from other installs'));
  END LOOP;
END $$;
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
