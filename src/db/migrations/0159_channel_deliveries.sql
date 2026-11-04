CREATE TABLE IF NOT EXISTS channel_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_type text NOT NULL,
  channel_id text NOT NULL,
  content text NOT NULL,
  thread_id text,
  kind text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channel_deliveries_due_idx ON channel_deliveries (status, next_attempt_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channel_deliveries_user_idx ON channel_deliveries (user_id);
