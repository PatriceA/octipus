-- Which skill registry listing, at which version, a person installed skills
-- from (docs/SKILL-EXCHANGE.md#registries). The Skills page compares it with
-- the registries' newer versions to show an available update; nothing is
-- ever updated from it.
CREATE TABLE IF NOT EXISTS "skill_registry_installs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_key" text NOT NULL,
  "registry" text NOT NULL,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "content_hash" text NOT NULL,
  "skill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "skill_registry_installs_owner_listing_idx" ON "skill_registry_installs" ("owner_key", "registry", "name");
