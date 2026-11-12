-- In-process plugins (docs/PLUGIN-PACKAGES.md#runtimes): the extra approval to
-- run a plugin's code in the server process, recorded with the content hash it
-- covers. It holds only while in_process_approved_hash equals content_hash;
-- approving other content clears it.
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS in_process_approved_hash text;
--> statement-breakpoint
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS in_process_approved_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS in_process_approved_at timestamp with time zone;
