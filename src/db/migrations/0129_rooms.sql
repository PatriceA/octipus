-- Rooms and space memory (docs/plans/coworking-spec.md §6.1, S2).
--
-- A room is a session with kind = 'room' inside a shared workspace (D7).
-- `kind` is the only room discriminator: personal paths add kind = 'chat'
-- and never see a room, its creator included. `room_visibility` is set for
-- rooms only: 'space' (every member) or 'private' (the room_members rows).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat';
--> statement-breakpoint
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_kind_chk;
--> statement-breakpoint
ALTER TABLE sessions ADD CONSTRAINT sessions_kind_chk CHECK (kind IN ('chat','room'));
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS room_visibility text;
--> statement-breakpoint
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_room_visibility_chk;
--> statement-breakpoint
ALTER TABLE sessions ADD CONSTRAINT sessions_room_visibility_chk
  CHECK ((kind = 'room') = (room_visibility IS NOT NULL)
         AND (room_visibility IS NULL OR room_visibility IN ('space','private')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_ws_rooms_idx ON sessions(workspace_id) WHERE kind = 'room';
--> statement-breakpoint
-- Access to private rooms only; an open room is every member's.
CREATE TABLE IF NOT EXISTS room_members (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id);
--> statement-breakpoint
-- Read state and mute, for any room.
CREATE TABLE IF NOT EXISTS room_reads (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id uuid,
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, user_id)
);
--> statement-breakpoint
-- Who wrote a room post. Personal chats leave it NULL (the session's owner).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Facts members record for the space's agent (§6.5). RESTRICT: only the
-- purge job deletes a space, and it deletes these rows first (D15).
CREATE TABLE IF NOT EXISTS space_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) <= 500),
  author_kind text NOT NULL CHECK (author_kind IN ('member','agent')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  session_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  retracted_at timestamptz,
  retracted_by uuid REFERENCES users(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS space_memory_ws_idx ON space_memory(workspace_id, created_at DESC) WHERE retracted_at IS NULL;
