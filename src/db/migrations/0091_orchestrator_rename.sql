-- Retire the last persisted uses of "orchestrator".
--
-- Phase 9 of the rebuild deleted the routing hop: the root of a run is an
-- ordinary `general`-role agent, not a separate orchestrating layer. The name
-- survived in three places the database owns, and a name that outlives the
-- thing it describes is how the next reader learns something false.
--
-- All three are renames, not rewrites: no row changes meaning, and the
-- application code in this same commit reads only the new names.

-- 1. The swarm node kind. RENAME VALUE keeps every existing row valid; adding
--    'root' and backfilling would leave two live values for one concept.
ALTER TYPE "swarm_node_kind" RENAME VALUE 'orchestrator' TO 'root';
--> statement-breakpoint

-- 2. The pipeline's root agent.
ALTER TABLE "pipelines" RENAME COLUMN "orchestrator_agent_id" TO "root_agent_id";
--> statement-breakpoint

-- 3. `hooks.action_config.orchestratorNotify` — a JSON key, so it needs a
--    value rewrite rather than a rename. Only rows that actually carry the key
--    are touched, and the old key is removed in the same expression so a re-run
--    is a no-op rather than a resurrection.
UPDATE "hooks"
SET "action_config" = ("action_config" - 'orchestratorNotify')
                      || jsonb_build_object('notifyRoot', "action_config" -> 'orchestratorNotify')
WHERE "action_config" ? 'orchestratorNotify';
--> statement-breakpoint

-- 4. The `settings` rows themselves. The `orchestrator.*` namespace was folded
--    into `agent.*` once there was no orchestrator to name it after. Config
--    loading normalizes the old shape at boot either way, but a stale key here
--    would still be what the Settings page shows and edits, so the row is the
--    thing that has to move.
--
--    `ON CONFLICT DO NOTHING` on the key's unique index is not available to an
--    UPDATE, so rows whose new key already exists are deleted rather than
--    renamed: an install that has both was already reading the new one.
DELETE FROM "settings" o
WHERE o."key" LIKE 'orchestrator.%'
  AND EXISTS (
    SELECT 1 FROM "settings" n
    WHERE n."key" = 'agent.' || CASE split_part(o."key", '.', 2)
      WHEN 'mode' THEN 'promptTier'
      WHEN 'routerSmallModelMaxParams' THEN 'smallModelMaxParams'
      WHEN 'orchestratorTimeoutMs' THEN 'turnTimeoutMs'
      WHEN 'orchestratorHookTimeoutMs' THEN 'hookTurnTimeoutMs'
      ELSE split_part(o."key", '.', 2)
    END
  );
--> statement-breakpoint

UPDATE "settings"
SET "key" = 'agent.' || CASE split_part("key", '.', 2)
      WHEN 'mode' THEN 'promptTier'
      WHEN 'routerSmallModelMaxParams' THEN 'smallModelMaxParams'
      WHEN 'orchestratorTimeoutMs' THEN 'turnTimeoutMs'
      WHEN 'orchestratorHookTimeoutMs' THEN 'hookTurnTimeoutMs'
      ELSE split_part("key", '.', 2)
    END,
    "category" = 'agent',
    "value" = CASE WHEN "key" = 'orchestrator.mode' AND "value" = 'router' THEN 'lite' ELSE "value" END
WHERE "key" LIKE 'orchestrator.%';
--> statement-breakpoint

-- The swarm level key follows the node kind renamed in step 1.
UPDATE "settings"
SET "key" = replace("key", 'swarm.levelDefaults.orchestrator.', 'swarm.levelDefaults.root.')
WHERE "key" LIKE 'swarm.levelDefaults.orchestrator.%'
  AND NOT EXISTS (
    SELECT 1 FROM "settings" n
    WHERE n."key" = replace("settings"."key", 'swarm.levelDefaults.orchestrator.', 'swarm.levelDefaults.root.')
  );
