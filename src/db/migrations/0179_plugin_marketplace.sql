-- The plugin marketplace (docs/PLUGIN-PACKAGES.md#marketplace).
--
-- plugin_packages.origin: where the installed version came from (provenance):
-- { source: 'marketplace' | 'registry:<name>' | 'url' | 'directory' | 'bundled' | 'agent',
--   registry?, url?, listingVersion?, indexGeneratedAt? }. Null for a package
-- installed before provenance was recorded.
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS origin jsonb;
--> statement-breakpoint
-- The last accepted signed index of each registry, by its URL: generatedAt
-- only moves forward (a replayed older index is refused).
CREATE TABLE IF NOT EXISTS plugin_registry_state (
  registry_url text PRIMARY KEY,
  last_generated_at timestamptz NOT NULL,
  last_index_sha256 text NOT NULL,
  last_signed_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Revocations learnt from the marketplace's signed index. They only
-- accumulate: a later index that drops one does not lift it. An admin may
-- clear one (audited); a cleared row is kept, and an index that still lists
-- the revocation revokes it again.
CREATE TABLE IF NOT EXISTS plugin_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('package', 'key')),
  name text,
  version text,
  key_id text,
  reason text NOT NULL DEFAULT '',
  registry_url text NOT NULL,
  signed_by_key text NOT NULL,
  index_generated_at timestamptz NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by uuid REFERENCES users(id) ON DELETE SET NULL,
  clear_reason text,
  CONSTRAINT plugin_revocations_shape_chk CHECK (
    (kind = 'package' AND name IS NOT NULL AND version IS NOT NULL AND key_id IS NULL)
    OR (kind = 'key' AND key_id IS NOT NULL AND name IS NULL AND version IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS plugin_revocations_active_package_uq
  ON plugin_revocations (name, version) WHERE kind = 'package' AND cleared_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS plugin_revocations_active_key_uq
  ON plugin_revocations (key_id) WHERE kind = 'key' AND cleared_at IS NULL;
--> statement-breakpoint
-- New versions admins were told about (the daily update check): once per version.
CREATE TABLE IF NOT EXISTS plugin_update_notices (
  name text NOT NULL,
  version text NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
--> statement-breakpoint
-- The marketplace's last accepted keys.json (root-signed list of signing
-- keys), kept with its signature: re-verified against the built-in root keys
-- whenever it is read, so installed marketplace packages keep verifying while
-- the marketplace is unreachable. `version` only moves forward.
CREATE TABLE IF NOT EXISTS plugin_marketplace_keys (
  registry_url text PRIMARY KEY,
  version integer NOT NULL,
  generated_at timestamptz NOT NULL,
  body text NOT NULL,
  signature text NOT NULL,
  sha256 text NOT NULL,
  signed_by_root text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The content hash of each name@version as first listed by each registry: a
-- later index claiming another hash for the same version (a published
-- version silently replaced) is refused.
CREATE TABLE IF NOT EXISTS plugin_listing_pins (
  registry_url text NOT NULL,
  name text NOT NULL,
  version text NOT NULL,
  content_hash text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (registry_url, name, version)
);
