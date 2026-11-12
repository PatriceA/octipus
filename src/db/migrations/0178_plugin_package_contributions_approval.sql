-- Plugin package contributions approval (docs/PLUGIN-PACKAGES.md#approving-contributions).
-- approved_contributions_hash: the contributions hash an admin approved
-- (sha256 over the canonical JSON of the manifest's commands, schedules,
-- events, prompt and context, plus the prompt file's bytes). Null: never
-- approved. Install and upgrade clear it; contributions bind only while it
-- equals the package's current contributions hash.
ALTER TABLE plugin_packages ADD COLUMN IF NOT EXISTS approved_contributions_hash text;
