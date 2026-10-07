-- Spaces across installs (docs/plans/federation-spec.md §8.1).
--
-- federation_instances: the other installs whose members joined a space here
-- (host side). A row is written on the first successful space.join from that
-- install, never on a bare handshake. The peer endpoint reads it on every
-- handshake: a `blocked` instance is refused (4403).
CREATE TABLE IF NOT EXISTS federation_instances (
  instance_id text PRIMARY KEY,
  public_key text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  first_seen timestamptz DEFAULT now() NOT NULL,
  last_seen timestamptz DEFAULT now() NOT NULL,
  blocked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  blocked_at timestamptz
);
--> statement-breakpoint
ALTER TABLE federation_instances DROP CONSTRAINT IF EXISTS federation_instances_status_chk;
--> statement-breakpoint
ALTER TABLE federation_instances ADD CONSTRAINT federation_instances_status_chk CHECK (status IN ('active', 'blocked'));
--> statement-breakpoint
ALTER TABLE federation_instances DROP CONSTRAINT IF EXISTS federation_instances_id_chk;
--> statement-breakpoint
ALTER TABLE federation_instances ADD CONSTRAINT federation_instances_id_chk CHECK (instance_id ~ '^[a-z2-7]{26}$');
--> statement-breakpoint

-- A remote member's role is at most editor (§7.1): `owner` with a remote user
-- is refused here as well as by the role PATCH, the same way
-- `guest_scope_is_valid` guards a scope through a function in a CHECK.
CREATE OR REPLACE FUNCTION workspace_member_is_remote(uid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = uid AND kind = 'remote')
$$;
--> statement-breakpoint
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_remote_owner_chk;
--> statement-breakpoint
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_remote_owner_chk CHECK (role <> 'owner' OR NOT workspace_member_is_remote(user_id));
--> statement-breakpoint

-- Note edit proposals of a remote member (§7.3) have no session: they are
-- keyed by `proposer_key` (`remote:<user id>`). One pending proposal per
-- note and proposer, whichever of the two names it.
ALTER TABLE note_edit_proposals ADD COLUMN IF NOT EXISTS proposer_key text;
--> statement-breakpoint
DROP INDEX IF EXISTS note_edit_proposals_pending_uidx;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS note_edit_proposals_pending_key_uidx ON note_edit_proposals(note_id, (coalesce(session_id::text, proposer_key))) WHERE status = 'pending';
--> statement-breakpoint

-- Audit actions of joining and leaving from another install, and of
-- blocking an instance (§10).
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_joined_remote';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'space_left_remote';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'federation_instance_blocked';
--> statement-breakpoint
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'federation_instance_unblocked';
