-- ── `research` becomes its own model lane ──────────────────────────────────
-- It used to alias to `writing` (RETIRED_TOPIC_ALIASES), which made a model
-- bound to `research` unreachable: the highest-token role in the system — a
-- researcher fans out into children that each re-send a growing context —
-- could not be pinned to a local or cheap model without moving Writing too.
--
-- Two data fixes, both idempotent:

-- 1. Seed the lane from `writing` (its previous home) for any install that has
--    no `research` binding yet, so research keeps resolving the same model it
--    resolves today instead of failing loud on the first spawn after upgrade.
--    An install that already bound `research` (the binding that was inert
--    until now) keeps it — that is the operator's actual intent.
UPDATE model_config
SET topic_roles = coalesce(topic_roles, '{}'::jsonb)
                  || jsonb_build_object('research', topic_roles->>'writing')
WHERE topic_roles->>'writing' IN ('primary', 'backup')
  AND topic_roles->>'research' IS NULL
  -- Scoped to 'primary', not "any research key present": `research` was
  -- directly bindable before topic consolidation, and aliasing never cleaned
  -- the stored keys, so a leftover research *backup* is common. Only a primary
  -- actually serves a spawn (getModelForTopic reads 'primary'; the backup is
  -- consulted only after a primary spawn has already failed), so a backup-only
  -- leftover must not suppress the seed and leave the lane unbound.
  AND NOT EXISTS (
    SELECT 1 FROM model_config other WHERE other.topic_roles->>'research' = 'primary'
  );--> statement-breakpoint

-- 2. Point the system research expert at the new lane. Without this the
--    spawner resolves the EXPERT's lane (`writing`), not the child's role, so
--    the research binding would stay unreachable through the swarm path — the
--    same defect one level up. Only moves experts still sitting on `writing`;
--    an expert an operator has since pointed somewhere else is left alone.
-- (`experts` is the `presets` table — the Drizzle model kept the old name.)
UPDATE presets
SET topic = 'research', updated_at = now()
WHERE role = 'research' AND topic = 'writing';
