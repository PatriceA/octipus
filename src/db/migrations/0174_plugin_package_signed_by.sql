-- The trusted publisher whose signature covers a plugin package's approved content
-- (docs/PLUGIN-PACKAGES.md#signed-packages). Null: unsigned, untrusted key, or approved without a signature.
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS signed_by text;
