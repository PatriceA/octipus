-- Interactive answers ("inline UI", docs/plans/inline-ui-spec.md §5.1).
--
-- The root agent writes an `octi-ui` fenced block in a reply; at the end of
-- the turn the server stores its source here and leaves a marker line in the
-- reply. Session content: cascades with the session like `messages`.
CREATE TABLE IF NOT EXISTS inline_ui_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  agent_id text,
  requester_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  height_hint integer DEFAULT 320 NOT NULL,
  css text DEFAULT '' NOT NULL,
  html text DEFAULT '' NOT NULL,
  js text DEFAULT '' NOT NULL,
  scripts boolean NOT NULL,
  tainted boolean DEFAULT false NOT NULL,
  risk text DEFAULT 'normal' NOT NULL,
  issues jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE inline_ui_blocks DROP CONSTRAINT IF EXISTS inline_ui_blocks_risk_chk;
--> statement-breakpoint
ALTER TABLE inline_ui_blocks ADD CONSTRAINT inline_ui_blocks_risk_chk CHECK (risk IN ('normal', 'high'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inline_ui_blocks_session_created_idx ON inline_ui_blocks (session_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inline_ui_blocks_session_run_idx ON inline_ui_blocks (session_id, run_id);
