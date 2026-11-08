-- The content hash a plugin package was approved with (docs/PLUGIN-PACKAGES.md#content-pinning).
-- Null for packages installed before pinning: their first start records it.
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS content_hash text;
