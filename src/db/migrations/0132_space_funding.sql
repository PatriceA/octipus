-- Space funding, space budgets and room modes (docs/plans/coworking-spec.md
-- §9.1–§9.3, S5).
--
-- `agent_funding` says who pays for the agent in a space (`fundingFor`):
-- `own` (every member for their own turns; nothing unprompted), `unattended`
-- (members pay their own turns, the sponsor pays unprompted work) or
-- `sponsored` (the sponsor pays everything, members under a per-member cap).
-- `sponsor_user_id` is the owner who pays; `sponsor_models` the names of the
-- sponsor's own model rows that sponsored turns may run on.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_funding text NOT NULL DEFAULT 'unattended';
--> statement-breakpoint
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_agent_funding_chk;
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_agent_funding_chk CHECK (agent_funding IN ('own','unattended','sponsored'));
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS sponsor_user_id uuid;
--> statement-breakpoint
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_sponsor_user_id_fk;
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_sponsor_user_id_fk
  FOREIGN KEY (sponsor_user_id) REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS sponsor_models jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- Space budgets: `space` caps everything the sponsor pays in the space,
-- `space_member` caps each member's sponsored spend there (one row, applied
-- to every member). scope_ref is the space id; user_id is the owner who
-- wrote the budget, author only, so the budget survives their account.
ALTER TABLE spend_budgets DROP CONSTRAINT IF EXISTS spend_budgets_scope_kind_check;
--> statement-breakpoint
ALTER TABLE spend_budgets ADD CONSTRAINT spend_budgets_scope_kind_check
  CHECK (scope_kind IN ('user','role','workspace','group_channel','space','space_member'));
--> statement-breakpoint
ALTER TABLE spend_budgets ALTER COLUMN user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE spend_budgets DROP CONSTRAINT IF EXISTS spend_budgets_user_id_chk;
--> statement-breakpoint
ALTER TABLE spend_budgets ADD CONSTRAINT spend_budgets_user_id_chk
  CHECK (user_id IS NOT NULL OR scope_kind IN ('space','space_member'));
--> statement-breakpoint
ALTER TABLE spend_budgets DROP CONSTRAINT IF EXISTS spend_budgets_user_id_fkey;
--> statement-breakpoint
ALTER TABLE spend_budgets DROP CONSTRAINT IF EXISTS spend_budgets_user_id_users_id_fk;
--> statement-breakpoint
ALTER TABLE spend_budgets ADD CONSTRAINT spend_budgets_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The key no longer cascades: a user's own budgets go with their account
-- here, before the SET NULL would leave them without a user.
CREATE OR REPLACE FUNCTION delete_personal_spend_budgets() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN DELETE FROM spend_budgets WHERE user_id = OLD.id AND scope_kind NOT IN ('space','space_member'); RETURN OLD; END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS spend_budgets_personal_cleanup ON users;
--> statement-breakpoint
CREATE TRIGGER spend_budgets_personal_cleanup BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION delete_personal_spend_budgets();
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS spend_budgets_space_uniq
  ON spend_budgets(scope_kind, scope_ref, period) WHERE scope_kind IN ('space','space_member');
--> statement-breakpoint
-- The per-member cap is checked statelessly from cost_log; its warning and
-- pause notices are stamped here once per member and period.
CREATE TABLE IF NOT EXISTS space_member_notices (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period text NOT NULL CHECK (period IN ('day','month')),
  warned_at timestamptz,
  paused_at timestamptz,
  PRIMARY KEY (workspace_id, user_id, period)
);
--> statement-breakpoint
-- Room modes (§9.3): `listen` and `proactive` rooms, with the gate, quiet
-- hours and caps of group channels (src/channels/group-listen.ts).
CREATE TABLE IF NOT EXISTS room_modes (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'mention' CHECK (mode IN ('mention','listen','proactive')),
  quiet_hours_start smallint CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end smallint CHECK (quiet_hours_end BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'UTC',
  max_unprompted_per_day smallint NOT NULL DEFAULT 8 CHECK (max_unprompted_per_day BETWEEN 1 AND 100),
  min_minutes_between smallint NOT NULL DEFAULT 60 CHECK (min_minutes_between BETWEEN 0 AND 1440),
  last_unprompted_at timestamptz,
  unprompted_day text,
  unprompted_count smallint NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_modes_unprompted_idx ON room_modes(mode) WHERE mode <> 'mention';
--> statement-breakpoint
-- A member's 👍 / 👎 on one of the agent's unprompted room posts.
CREATE TABLE IF NOT EXISTS room_feedback (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value smallint NOT NULL CHECK (value IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS room_feedback_session_idx ON room_feedback(session_id);
--> statement-breakpoint
-- "My work": open tasks assigned to a member, across their spaces.
CREATE INDEX IF NOT EXISTS tasks_assignee_user_idx ON tasks(assignee_ref, status) WHERE assignee_kind = 'user';
