-- Each heartbeat gate decision, so the Triggers page can say why a heartbeat
-- did or did not run (docs/HEARTBEAT.md). Pruned after 14 days by the heartbeat.
CREATE TABLE IF NOT EXISTS heartbeat_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hook_id uuid NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  ran boolean NOT NULL,
  reason text,
  ready_tasks integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS heartbeat_checks_hook_checked_idx ON heartbeat_checks (hook_id, checked_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS heartbeat_checks_user_checked_idx ON heartbeat_checks (user_id, checked_at);
