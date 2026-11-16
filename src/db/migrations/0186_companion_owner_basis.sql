-- Owner words behind Companion writes ("Because you said…").
ALTER TABLE companion_goals ADD COLUMN IF NOT EXISTS owner_inputs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE companion_actions ADD COLUMN IF NOT EXISTS basis jsonb;
-- Goals saved before this change keep their saved request, outcome and criteria
-- as the owner's words: background coordination can cite only those.
UPDATE companion_goals g SET owner_inputs = (
  SELECT jsonb_agg(jsonb_build_object('text', v.text, 'origin', 'form', 'at', to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
  FROM (SELECT g.request AS text UNION ALL SELECT g.outcome UNION ALL SELECT jsonb_array_elements_text(g.acceptance_criteria)) v
) WHERE g.owner_inputs = '[]'::jsonb;
