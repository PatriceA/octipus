-- Review and QA get their own lane. Not because review is a different subject —
-- that reasoning is how this system once had twenty-seven topics — but because
-- it is the one place you deliberately want a DIFFERENT model from the one that
-- did the work. A second opinion from the model that wrote the code shares the
-- blind spot that produced it.
--
-- Seeded from `build` so nothing is unbound on upgrade: until the operator binds
-- something else, review runs exactly where it ran before. Binding a different
-- model there is then a one-line choice, which is the entire point.
UPDATE model_config
   SET topic_roles = topic_roles || jsonb_build_object('verify', topic_roles->>'build')
 WHERE topic_roles ? 'build' AND NOT (topic_roles ? 'verify');
--> statement-breakpoint
INSERT INTO topics_config (topic, executor_model, temperature, max_tokens)
SELECT 'verify', executor_model, temperature, max_tokens FROM topics_config WHERE topic = 'build'
ON CONFLICT (topic) DO NOTHING;
