-- Lessons in recall hooks stored before lessons were their own kind
-- (docs/plans/learning-notes-and-skill-discovery.md, "Recall").
--
-- Migration 0200 moved the notes a learning review wrote, and their embedding
-- rows, from purpose 'note' to 'lesson'. A recall hook whose config stored its
-- own `purposes` list before then has no 'lesson' in it, so after the upgrade
-- it would silently stop recalling those notes, which then expire as unused.
-- Every stored recall config (the user's own recall hooks, and the stored
-- change to the built-in 'knowledge-recall') whose list has 'note' and not
-- 'lesson' gets 'lesson' appended: the user who recalled their notes keeps
-- recalling the learning notes among them. A config without a list uses the
-- default, which includes lessons, and is left alone.
--
-- Safe to run twice: a list that has 'lesson' is not matched. It runs once,
-- so a user who unticks Lessons afterwards stays unticked.
UPDATE context_hooks
SET config = jsonb_set(config, '{purposes}', (config -> 'purposes') || '["lesson"]'::jsonb),
    updated_at = now()
WHERE (kind = 'recall' OR builtin = 'knowledge-recall')
  AND jsonb_typeof(config -> 'purposes') = 'array'
  AND (config -> 'purposes') @> '["note"]'::jsonb
  AND NOT ((config -> 'purposes') @> '["lesson"]'::jsonb);
