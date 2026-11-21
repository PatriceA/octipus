-- Local index of Gmail / Outlook headers (core/email/mail-index.ts): one row
-- per message with its folders, flags, addresses, subject and the provider's
-- short preview. Never a body or an attachment. Deleted with the user, when
-- the account is disconnected, and when the owner turns the index off.
CREATE TABLE IF NOT EXISTS email_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account text NOT NULL DEFAULT '',
  message_id text NOT NULL,
  thread_id text,
  inbox boolean NOT NULL DEFAULT false,
  sent boolean NOT NULL DEFAULT false,
  drafts boolean NOT NULL DEFAULT false,
  archive boolean NOT NULL DEFAULT false,
  trash boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  unread boolean NOT NULL DEFAULT false,
  from_name text,
  from_email text NOT NULL DEFAULT '',
  "to" jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL DEFAULT '',
  snippet text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL,
  has_attachments boolean,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS email_index_message_idx ON email_index (user_id, provider, account, message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_index_received_idx ON email_index (user_id, provider, account, received_at);
--> statement-breakpoint
-- Where the index of one mailbox stands: Gmail history id, Graph delta links,
-- whether the first read finished, the provider's unread count, sync timing.
CREATE TABLE IF NOT EXISTS email_index_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account text NOT NULL DEFAULT '',
  history_id text,
  folders jsonb NOT NULL DEFAULT '{}'::jsonb,
  backfilled_at timestamptz,
  covered_from timestamptz,
  inbox_unread integer,
  last_sync_at timestamptz,
  last_error text,
  failures integer NOT NULL DEFAULT 0,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS email_index_state_mailbox_idx ON email_index_state (user_id, provider, account);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_index_state_due_idx ON email_index_state (next_sync_at);
