-- Snoozed mail (core/email/snooze.ts): a conversation taken out of the inbox
-- until `wake_at`, when the cron tick puts it back unread. Keeps the sender,
-- subject and snippet so the Snoozed list can show the mail while it is out
-- of the inbox; deleted when the mail wakes, and with the user.
CREATE TABLE IF NOT EXISTS email_snoozes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account text,
  message_ids jsonb NOT NULL,
  thread_id text,
  from_email text NOT NULL,
  from_name text,
  subject text NOT NULL,
  snippet text NOT NULL,
  wake_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  given_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_snoozes_user_idx ON email_snoozes (user_id, wake_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_snoozes_due_idx ON email_snoozes (wake_at);
