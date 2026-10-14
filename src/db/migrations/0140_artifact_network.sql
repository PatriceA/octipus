-- What an artifact's page may reach (docs/plans/inline-ui-spec.md D15).
--
-- `default`: today's embed policy (the app's origin, the gateway, https
-- images). `none`: nothing — images only from data: and blob:, no fetch, no
-- socket, no live refresh. An interactive answer saved as an artifact is a
-- static copy and gets `none`.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS network text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_network_chk;
--> statement-breakpoint
ALTER TABLE artifacts ADD CONSTRAINT artifacts_network_chk CHECK (network IN ('default','none'));
