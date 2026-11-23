-- The inbound email channel (docs/CHANNELS.md#email): what it did with each
-- mail of its mailbox (accepted, answered with a notice, or dropped and why)
-- and the replies it sent. One inbound row per received mail, claimed before
-- the mail is looked at, so no mail is answered twice.
CREATE TABLE IF NOT EXISTS email_channel_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  mail_message_id uuid REFERENCES mail_messages(id) ON DELETE SET NULL,
  direction text NOT NULL,
  status text NOT NULL,
  reason text,
  address text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  message_id_header text,
  thread_key text,
  subject text,
  "references" text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_channel_messages_mail_idx ON email_channel_messages (mail_message_id);
CREATE INDEX IF NOT EXISTS email_channel_messages_header_idx ON email_channel_messages (account_id, message_id_header);
CREATE INDEX IF NOT EXISTS email_channel_messages_address_idx ON email_channel_messages (account_id, address, created_at);
CREATE INDEX IF NOT EXISTS email_channel_messages_thread_idx ON email_channel_messages (account_id, thread_key, created_at);
