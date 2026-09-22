-- Roles become editable data, not only code.
--
-- The table already held a role's tools, lane and prompt; what it could not
-- express is everything the file config carries beside those — which is why a
-- role could be adjusted but never created. Four columns close the gap:
--
--   core_tool_ids   the lazy-discovery core set (must be a subset of tool_ids)
--   read_only       strips the file-mutating handlers, the way architecture,
--                   review and qa are stripped in code — a permission boundary,
--                   not prose
--   critical_rules  the numbered "# Critical Rules" block appended to the prompt
--   description     the one line the MODEL reads when choosing a role to spawn.
--                   Nothing selects a role from a lane — a role resolves TO a
--                   lane — so this description is how a new role gets picked at
--                   all, and a role without one is invisible to delegation.
--
-- `is_system` already distinguishes a seeded role from a user's; only the
-- latter may be deleted.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS core_tool_ids jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN IF NOT EXISTS read_only boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN IF NOT EXISTS critical_rules jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE roles ADD COLUMN IF NOT EXISTS description text;
