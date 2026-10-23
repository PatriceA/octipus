-- The email inbox and live artifacts become modules (docs/MODULES.md).
-- An install that already has users had them as part of the core: they stay
-- on there. A new install (no users yet) leaves them off.
UPDATE "settings"
SET "value" = (
  SELECT jsonb_agg(DISTINCT m.module)::text
  FROM jsonb_array_elements_text("value"::jsonb || '["inbox","artifacts"]'::jsonb) AS m(module)
), "updated_at" = now()
WHERE "key" = 'modules.enabled' AND "value" ~ '^\s*\[' AND EXISTS (SELECT 1 FROM "users");
--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "value_type", "category", "description", "default_value")
SELECT 'modules.enabled', '["inbox","artifacts"]', 'string_array', 'modules',
       'The modules that are on (Settings → Modules). Empty: the core only.', '[]'
WHERE EXISTS (SELECT 1 FROM "users")
ON CONFLICT ("key") DO NOTHING;
