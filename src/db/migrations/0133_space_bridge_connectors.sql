-- Group-channel bridge and space connectors (docs/plans/coworking-spec.md §9.4, §9.5, S5).
--
-- A group channel bound to a space: `group_channels.workspace_id` names the
-- space (shared workspaces only, checked on write by the bridge service), and
-- every platform thread of the channel maps to one room of that space in
-- `group_channel_rooms`. Room sessions carry no `group_channel_id`: the
-- per-member unique index on sessions stays as it is. A purged space detaches
-- the channel (the enrolment outlives the space); a deleted room drops its
-- mapping.
ALTER TABLE group_channels ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_channels_workspace_idx ON group_channels(workspace_id) WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS group_channel_rooms (
  group_channel_id uuid NOT NULL REFERENCES group_channels(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_channel_id, thread_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS group_channel_rooms_session_uniq ON group_channel_rooms(session_id);
--> statement-breakpoint
-- Space secrets (§9.5): their own vault scope, keyed by the space. The value
-- is not used by any statement of this batch (a new enum value cannot be used
-- in the transaction that adds it); the check below compares as text.
ALTER TYPE "vault_scope" ADD VALUE IF NOT EXISTS 'space';
--> statement-breakpoint
ALTER TABLE vault DROP CONSTRAINT IF EXISTS vault_space_workspace_chk;
--> statement-breakpoint
ALTER TABLE vault ADD CONSTRAINT vault_space_workspace_chk CHECK (scope::text <> 'space' OR workspace_id IS NOT NULL);
