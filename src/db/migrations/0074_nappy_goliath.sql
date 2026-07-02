ALTER TABLE "presets" ADD COLUMN "topic" text DEFAULT 'agents' NOT NULL;--> statement-breakpoint

-- ── Topic consolidation (docs/plans/topic-consolidation.md Phase 3) ─────────
-- Topics collapse from 27 to 7 model lanes: the 16 worker-role topics fold
-- into 'agents', the 5 per-feature background topics into 'background', and
-- 'simple'/'local' into 'chat'. Reads of retired names are aliased in code
-- (RETIRED_TOPIC_ALIASES), so retired keys left on model rows are inert.
-- This migration elects the binding each new lane inherits:
--   agents/background primary  = the model that was primary for the most
--                                 retired topics of that lane (ties: prefer
--                                 the one covering 'general' / any, then name)
--   agents/background backup   = same election over 'backup' bindings
--   per-role differences       = pinned as model_preference on that role's
--                                 system expert, preserving old behaviour
-- 'chat', 'voice', 'vision', 'ocr', 'embedding' keep their existing bindings.

-- agents primary election (topic_roles + legacy topics[] both count as a vote)
WITH role_topics(t) AS (
  VALUES ('general'),('coding'),('research'),('architecture'),('review'),
         ('communication'),('design'),('devops'),('security'),('data'),
         ('ai'),('qa'),('finance'),('automation'),('pm'),('writing')
),
votes AS (
  SELECT mc.id,
         count(*) AS cnt,
         max((rt.t = 'general')::int) AS has_general
  FROM model_config mc
  JOIN role_topics rt
    ON (mc.topic_roles->>rt.t = 'primary' OR rt.t = ANY(mc.topics))
  WHERE mc.is_enabled = true
  GROUP BY mc.id
),
winner AS (
  SELECT id FROM votes ORDER BY cnt DESC, has_general DESC, id LIMIT 1
)
UPDATE model_config
SET topic_roles = coalesce(topic_roles, '{}'::jsonb) || '{"agents":"primary"}'::jsonb,
    topics = CASE WHEN 'agents' = ANY(topics) THEN topics ELSE topics || '{agents}' END
WHERE id IN (SELECT id FROM winner)
  AND NOT EXISTS (SELECT 1 FROM model_config w2 WHERE w2.topic_roles->>'agents' = 'primary');--> statement-breakpoint

-- agents backup election
WITH role_topics(t) AS (
  VALUES ('general'),('coding'),('research'),('architecture'),('review'),
         ('communication'),('design'),('devops'),('security'),('data'),
         ('ai'),('qa'),('finance'),('automation'),('pm'),('writing')
),
votes AS (
  SELECT mc.id, count(*) AS cnt, max((rt.t = 'general')::int) AS has_general
  FROM model_config mc
  JOIN role_topics rt ON mc.topic_roles->>rt.t = 'backup'
  WHERE mc.is_enabled = true
  GROUP BY mc.id
),
winner AS (SELECT id FROM votes ORDER BY cnt DESC, has_general DESC, id LIMIT 1)
UPDATE model_config
SET topic_roles = coalesce(topic_roles, '{}'::jsonb) || '{"agents":"backup"}'::jsonb
WHERE id IN (SELECT id FROM winner)
  AND topic_roles->>'agents' IS NULL
  AND NOT EXISTS (SELECT 1 FROM model_config w2 WHERE w2.topic_roles->>'agents' = 'backup');--> statement-breakpoint

-- Role topics whose old primary is NOT the agents winner keep their model via
-- the system expert's model_preference (only when no preference is set).
UPDATE presets p
SET model_preference = mc.model_id
FROM model_config mc
WHERE p.is_system = true
  AND p.model_preference IS NULL
  AND mc.is_enabled = true
  AND mc.topic_roles->>p.role = 'primary'
  AND coalesce(mc.topic_roles->>'agents', '') <> 'primary';--> statement-breakpoint

-- background primary election across the 5 retired per-feature topics
WITH bg_topics(t) AS (
  VALUES ('memory_extraction'),('knowledge_review'),('evaluation'),
         ('summarization'),('tool_translation')
),
votes AS (
  SELECT mc.id, count(*) AS cnt
  FROM model_config mc
  JOIN bg_topics bt
    ON (mc.topic_roles->>bt.t = 'primary' OR bt.t = ANY(mc.topics))
  WHERE mc.is_enabled = true
  GROUP BY mc.id
),
winner AS (SELECT id FROM votes ORDER BY cnt DESC, id LIMIT 1)
UPDATE model_config
SET topic_roles = coalesce(topic_roles, '{}'::jsonb) || '{"background":"primary"}'::jsonb,
    topics = CASE WHEN 'background' = ANY(topics) THEN topics ELSE topics || '{background}' END
WHERE id IN (SELECT id FROM winner)
  AND NOT EXISTS (SELECT 1 FROM model_config w2 WHERE w2.topic_roles->>'background' = 'primary');--> statement-breakpoint

-- background backup election
WITH bg_topics(t) AS (
  VALUES ('memory_extraction'),('knowledge_review'),('evaluation'),
         ('summarization'),('tool_translation')
),
votes AS (
  SELECT mc.id, count(*) AS cnt
  FROM model_config mc
  JOIN bg_topics bt ON mc.topic_roles->>bt.t = 'backup'
  WHERE mc.is_enabled = true
  GROUP BY mc.id
),
winner AS (SELECT id FROM votes ORDER BY cnt DESC, id LIMIT 1)
UPDATE model_config
SET topic_roles = coalesce(topic_roles, '{}'::jsonb) || '{"background":"backup"}'::jsonb
WHERE id IN (SELECT id FROM winner)
  AND topic_roles->>'background' IS NULL
  AND NOT EXISTS (SELECT 1 FROM model_config w2 WHERE w2.topic_roles->>'background' = 'backup');--> statement-breakpoint

-- topics_config extras: the 'general' row seeds the 'agents' lane; the first
-- configured retired background row seeds 'background'. Retired rows stay in
-- place (inert — lookups canonicalize to the lane row).
INSERT INTO topics_config (topic, executor_model, temperature, max_tokens)
SELECT 'agents', executor_model, temperature, max_tokens
FROM topics_config WHERE topic = 'general'
ON CONFLICT (topic) DO NOTHING;--> statement-breakpoint

INSERT INTO topics_config (topic, executor_model, temperature, max_tokens)
SELECT 'background', executor_model, temperature, max_tokens
FROM topics_config
WHERE topic IN ('memory_extraction','knowledge_review','evaluation','summarization','tool_translation')
  AND (executor_model IS NOT NULL OR temperature IS NOT NULL OR max_tokens IS NOT NULL)
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (topic) DO NOTHING;
