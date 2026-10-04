-- Listen and proactive modes for group channels (docs/plans/group-chat-bot.md
-- §7, phase 4). `mode` decides whether the bot may post unprompted; the rate
-- limit and quiet hours are per channel, and the unprompted slot is claimed by
-- a conditional UPDATE so two processes never both post. Reactions on the
-- bot's messages are recorded as feedback, one per member and message.
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'mention';
--> statement-breakpoint
ALTER TABLE group_channels DROP CONSTRAINT IF EXISTS group_channels_mode_check;
--> statement-breakpoint
ALTER TABLE group_channels ADD CONSTRAINT group_channels_mode_check CHECK (mode IN ('mention','listen','proactive'));
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS quiet_hours_start smallint;
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS quiet_hours_end smallint;
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS max_unprompted_per_day smallint NOT NULL DEFAULT 8;
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS min_minutes_between smallint NOT NULL DEFAULT 60;
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS last_unprompted_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS unprompted_day text;
--> statement-breakpoint
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS unprompted_count smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS group_channel_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_channel_id uuid NOT NULL REFERENCES group_channels(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  thread_id text,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS group_channel_feedback_uniq
  ON group_channel_feedback(group_channel_id, message_id, user_id);
