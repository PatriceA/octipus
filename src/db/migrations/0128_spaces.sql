-- Shared spaces (docs/plans/coworking-spec.md §5.1, S1).
--
-- A space is a workspace with kind = 'shared' and no owning user row
-- (user_id NULL): who may do what in it is `workspace_members`, read per
-- request. `created_by` records the creator separately, so deleting the
-- creator's account never cascades into the space.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'personal';
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE workspaces ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_kind_chk;
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_kind_chk CHECK (
  (kind = 'personal' AND user_id IS NOT NULL)
  OR (kind = 'shared' AND user_id IS NULL AND is_default = false));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','commenter','viewer','guest')),
  scope        jsonb,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);
--> statement-breakpoint
-- Invites are bearer secrets: only sha256(token) is stored, and a use is
-- taken by one conditional UPDATE (src/core/spaces/invites.ts).
CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor','commenter','viewer','guest')),
  scope jsonb,
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 100),
  use_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_invites_ws_idx ON workspace_invites(workspace_id);
--> statement-breakpoint
-- One slug per workspace; 0127 (S0c) renamed legacy duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS notes_ws_slug_uidx ON notes(workspace_id, slug) WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_links_ws_to_idx ON knowledge_links(workspace_id, to_type, to_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS embeddings_ws_idx ON embeddings(workspace_id) WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
-- History tables: no foreign key to workspaces, so their rows keep the id
-- after a space is purged (the space's audit trail and billing outlive it).
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS workspace_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_ws_created_idx ON audit_log(workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS workspace_id uuid;
--> statement-breakpoint
ALTER TABLE permission_requests ADD COLUMN IF NOT EXISTS workspace_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS permission_requests_ws_idx ON permission_requests(workspace_id) WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE cost_log ADD COLUMN IF NOT EXISTS workspace_id uuid;
--> statement-breakpoint
ALTER TABLE cost_log ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'own';
--> statement-breakpoint
ALTER TABLE cost_log DROP CONSTRAINT IF EXISTS cost_log_funding_chk;
--> statement-breakpoint
ALTER TABLE cost_log ADD CONSTRAINT cost_log_funding_chk CHECK (funding IN ('own','sponsor','install'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cost_log_ws_funding_idx ON cost_log(workspace_id, funding, created_at) WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'own';
--> statement-breakpoint
-- A data source of a space artifact refreshes only while its principal is a
-- member allowed to write there (§5.5); a removal or downgrade pauses it.
ALTER TABLE artifact_data_sources ADD COLUMN IF NOT EXISTS paused_at timestamptz;
--> statement-breakpoint
ALTER TABLE artifact_data_sources ADD COLUMN IF NOT EXISTS paused_reason text;
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_created';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_updated';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_archived';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_purged';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_member_added';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_member_role_changed';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_member_removed';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_invite_created';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_invite_revoked';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_invite_accepted';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_content_changed';
--> statement-breakpoint
-- The flow guard's label of a session (security/flow-guard.ts), written
-- through when a flag is first gained: after a restart, data a space
-- session read from personal sources still needs consent to be written
-- into the space (I6).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS flow_label jsonb;
