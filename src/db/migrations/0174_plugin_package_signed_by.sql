-- Signed plugin packages (docs/PLUGIN-PACKAGES.md#signed-packages).
-- signed_by: the trusted publisher whose signature covered the approved content.
-- Null: unsigned, untrusted key, or approved without a signature.
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS signed_by text;
-- signature_hash: sha256 of the octipus-plugin.sig bytes approved with content_hash
-- (the file is outside the content hash). Null: no signature file.
--> statement-breakpoint
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS signature_hash text;
