-- Group channels: shared chats (a Slack channel) a workspace owner has
-- enrolled Octipus into from inside the channel. Without a row the bot stays
-- silent there. Design: docs/plans/group-chat-bot.md.
CREATE TABLE IF NOT EXISTS group_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_type text NOT NULL,
  channel_id text NOT NULL,
  label text,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS group_channels_channel_uniq
  ON group_channels(channel_type, channel_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_channels_owner_idx ON group_channels(owner_user_id);
--> statement-breakpoint
-- A member's conversation in one group thread. Keyed by thread, so these rows
-- are exempt from the one-active-session-per-chat rule below.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS group_channel_id uuid
  REFERENCES group_channels(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_group_thread_idx
  ON sessions(group_channel_id, thread_id) WHERE group_channel_id IS NOT NULL;
--> statement-breakpoint
-- Recreate 0028's guard so it covers 1:1 chat sessions only; group sessions
-- get their own one-active-row-per-(user, group, thread) guard.
DROP INDEX IF EXISTS sessions_user_channel_active_uniq_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_channel_active_uniq_idx
  ON sessions(user_id, channel_type, channel_id)
  WHERE status = 'active'
    AND channel_type IN ('telegram', 'slack', 'whatsapp', 'teams', 'discord')
    AND group_channel_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_group_thread_active_uniq_idx
  ON sessions(user_id, group_channel_id, thread_id)
  WHERE status = 'active' AND group_channel_id IS NOT NULL;
