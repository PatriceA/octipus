-- Email triage training set (core/email/triage-labels.ts): the decision
-- model's answer per mail and the label it is measured against, set by the
-- owner or a reference model. Stores sender, subject and a short snippet so
-- labelled mail can serve as worked examples; deleted with the user.
CREATE TABLE IF NOT EXISTS email_triage_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  message_id text NOT NULL,
  from_email text NOT NULL,
  subject text NOT NULL,
  snippet text NOT NULL,
  clef jsonb,
  label_priority text,
  label_category text,
  label_source text,
  label_model text,
  labeled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS email_triage_labels_message_idx ON email_triage_labels (user_id, provider, message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_triage_labels_sender_idx ON email_triage_labels (user_id, from_email);
