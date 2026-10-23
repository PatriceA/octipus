-- Modules (docs/MODULES.md): an install from before modules keeps every
-- feature it had, so every module starts on. A new install (no users yet
-- when migrations run) gets no row: the core only, until the onboarding or
-- an admin switches modules on.
INSERT INTO "settings" ("key", "value", "value_type", "category", "description", "default_value")
SELECT 'modules.enabled',
       '["business","mail","scan-folders","protection","inbox","research","reader","recall","people","artifacts","voice","channels"]',
       'string_array',
       'modules',
       'The modules that are on (Settings → Modules). Empty: the core only.',
       '[]'
WHERE EXISTS (SELECT 1 FROM "users")
ON CONFLICT ("key") DO NOTHING;
