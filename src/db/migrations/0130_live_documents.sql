-- Live documents (docs/plans/coworking-spec.md §7.2, S3).
--
-- A space note open in an editor lives in the document hub
-- (src/core/docs/hub.ts) as a Yjs document; its body is persisted to
-- `notes` with a revision here. `authors` lists every member whose updates
-- are in the revision; `on_behalf_of_user_id` is the member an agent wrote
-- for. Space notes only, so the workspace is always a space.
CREATE TABLE IF NOT EXISTS note_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body text NOT NULL,
  body_sha256 text NOT NULL,
  authors uuid[] NOT NULL DEFAULT '{}',
  on_behalf_of_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  origin text NOT NULL,
  restored_from uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE note_revisions DROP CONSTRAINT IF EXISTS note_revisions_origin_chk;
--> statement-breakpoint
ALTER TABLE note_revisions ADD CONSTRAINT note_revisions_origin_chk CHECK (origin IN ('live','external','restore','proposal'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS note_revisions_note_created_idx ON note_revisions(note_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS note_revisions_ws_idx ON note_revisions(workspace_id);
--> statement-breakpoint
-- What an agent proposes to change in a space note (§7.4). Named so it does
-- not clash with the knowledge-graph link suggestions. One pending row per
-- note and agent session: a second write updates it.
CREATE TABLE IF NOT EXISTS note_edit_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid,
  agent_id text,
  action text NOT NULL DEFAULT 'edit',
  title text,
  base_body text NOT NULL,
  base_sha256 text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE note_edit_proposals DROP CONSTRAINT IF EXISTS note_edit_proposals_action_chk;
--> statement-breakpoint
ALTER TABLE note_edit_proposals ADD CONSTRAINT note_edit_proposals_action_chk CHECK (action IN ('edit','capture','meeting','archive'));
--> statement-breakpoint
ALTER TABLE note_edit_proposals DROP CONSTRAINT IF EXISTS note_edit_proposals_status_chk;
--> statement-breakpoint
ALTER TABLE note_edit_proposals ADD CONSTRAINT note_edit_proposals_status_chk CHECK (status IN ('pending','accepted','rejected','stale'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS note_edit_proposals_pending_uidx ON note_edit_proposals(note_id, session_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS note_edit_proposals_ws_status_idx ON note_edit_proposals(workspace_id, status);
--> statement-breakpoint
-- "Ben is editing" on a space file (§7.5). Paths are normalized relative
-- to the space's files root; one holder per path, until `expires_at`.
CREATE TABLE IF NOT EXISTS file_leases (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path text NOT NULL,
  holder_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  holder_kind text NOT NULL,
  agent_id text,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
--> statement-breakpoint
ALTER TABLE file_leases DROP CONSTRAINT IF EXISTS file_leases_holder_kind_chk;
--> statement-breakpoint
ALTER TABLE file_leases ADD CONSTRAINT file_leases_holder_kind_chk CHECK (holder_kind IN ('human','agent'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS file_leases_expires_idx ON file_leases(expires_at);
--> statement-breakpoint
-- How the agent edits a space's notes: `suggest` (default) turns its writes
-- into edit proposals, `direct` applies them through the hub.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_edit_mode text NOT NULL DEFAULT 'suggest';
--> statement-breakpoint
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_agent_edit_mode_chk;
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_agent_edit_mode_chk CHECK (agent_edit_mode IN ('suggest','direct'));
