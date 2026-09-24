CREATE TABLE monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation text,
  role text NOT NULL,
  name text NOT NULL,
  continuation text NOT NULL,
  source jsonb NOT NULL,
  status text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed','paused','ready','delivering','completed','cancelled','blocked')),
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 10 AND 3600),
  deadline timestamptz NOT NULL,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  previous jsonb,
  observation jsonb,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX monitors_due_idx ON monitors(status, next_check_at);
--> statement-breakpoint
CREATE INDEX monitors_session_idx ON monitors(session_id, user_id);
