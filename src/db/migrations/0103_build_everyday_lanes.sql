-- The `agents` lane served the coder and the weather question from one model
-- binding, so a strong model could never be put on coding without paying for
-- everything else. It splits into `build` (artefact work, where a weak model
-- ships plausible junior output nobody catches) and `everyday` (chat, lookups,
-- classification, triage — wrong answers are visible at once).
--
-- Every existing binding is copied to BOTH new lanes rather than guessed into
-- one: an unbound lane fails loud, and an upgrade must not take a working
-- install down. The operator then moves `everyday` to something cheap, which is
-- the whole point of the split. `writing`, `chat` and `voice` fold into
-- `everyday` (voice retires with the telephony module), and the old keys are
-- dropped so what is stored matches the registry rather than relying on the
-- alias table forever.
UPDATE model_config
   SET topic_roles = (topic_roles - 'agents' - 'writing' - 'chat' - 'voice')
     || jsonb_build_object('build', topic_roles->>'agents')
     || jsonb_build_object('everyday', COALESCE(topic_roles->>'agents', topic_roles->>'chat', topic_roles->>'writing', topic_roles->>'voice'))
 WHERE topic_roles ? 'agents';
--> statement-breakpoint
-- Rows bound to one of the folded lanes but never to `agents`: everyday only.
UPDATE model_config
   SET topic_roles = (topic_roles - 'writing' - 'chat' - 'voice')
     || jsonb_build_object('everyday', COALESCE(topic_roles->>'chat', topic_roles->>'writing', topic_roles->>'voice'))
 WHERE NOT (topic_roles ? 'agents')
   AND (topic_roles ? 'writing' OR topic_roles ? 'chat' OR topic_roles ? 'voice');
--> statement-breakpoint
-- Per-topic extras (executorModel, temperature, maxTokens) follow their lane.
-- `topic` is unique, so the agents row is renamed to `build` and copied to
-- `everyday` only where nothing is there already.
INSERT INTO topics_config (topic, executor_model, temperature, max_tokens)
SELECT 'everyday', executor_model, temperature, max_tokens FROM topics_config WHERE topic = 'agents'
ON CONFLICT (topic) DO NOTHING;
--> statement-breakpoint
UPDATE topics_config SET topic = 'build' WHERE topic = 'agents';
--> statement-breakpoint
DELETE FROM topics_config WHERE topic IN ('writing', 'chat', 'voice')
   AND EXISTS (SELECT 1 FROM topics_config t WHERE t.topic = 'everyday');
