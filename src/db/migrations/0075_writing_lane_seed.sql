-- ── New `writing` model lane ───────────────────────────────────────────────
-- The long-form text roles (research/communication/pm/writing) now route to a
-- distinct `writing` lane (RETIRED_TOPIC_ALIASES in src/models/topics.ts) so
-- they can run on a cheaper/faster model than the `agents` lane. `topicRoles`
-- (jsonb on model_config) is the source of truth for lane→model binding.
--
-- Data-only seed: copy each model's current `agents` role (primary/backup) onto
-- `writing`, so those roles keep resolving the same model they resolve today
-- until an operator rebinds `writing` on the Topics page. Without this the four
-- roles would fail loud ("no model bound to topic 'writing'") on first spawn.
-- Idempotent: skips rows that already carry a `writing` binding.
UPDATE model_config
SET topic_roles = coalesce(topic_roles, '{}'::jsonb)
                  || jsonb_build_object('writing', topic_roles->>'agents')
WHERE topic_roles->>'agents' IN ('primary', 'backup')
  AND topic_roles->>'writing' IS NULL;
