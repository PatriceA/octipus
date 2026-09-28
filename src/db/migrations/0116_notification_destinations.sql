-- Admin allowlist of shared notification destinations (a Slack #alerts
-- channel, a Telegram group). Hooks, notifications and monitors may always
-- message chats linked to their owner; any other (channel_type, channel_id)
-- must be listed here (src/channels/ownership.ts). org_id NULL means the
-- destination is approved for every user on the instance; otherwise only for
-- members of that org. NULLS NOT DISTINCT keeps one instance-wide row per
-- destination.
CREATE TABLE IF NOT EXISTS notification_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  channel_type text NOT NULL,
  channel_id text NOT NULL,
  label text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_destinations_uniq
  ON notification_destinations(channel_type, channel_id, org_id) NULLS NOT DISTINCT;
