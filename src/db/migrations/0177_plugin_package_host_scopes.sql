-- Plugin package host API scopes (docs/PLUGIN-PACKAGES.md#host-api).
-- approved_host_scopes: the scopes of the manifest's `host` an admin approved,
-- as a JSON array of strings. Null: never approved. A scope a later version
-- adds is not in it, so enabling that version asks for it again.
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS approved_host_scopes jsonb;
