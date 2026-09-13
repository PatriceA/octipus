CREATE TABLE push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform text NOT NULL,
  device_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX push_tokens_user_id_idx ON push_tokens (user_id);
