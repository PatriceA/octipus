-- Mail and calendar scopes of the plugin host API
-- (docs/PLUGIN-PACKAGES.md#mail-and-calendar).
--
-- mail_messages.plugin_source: a draft or message a plugin package composed,
-- { plugin, tool }. Provenance only.
--
-- plugin_items: what a package created in the user's mail and calendars, so
-- it may change or send those and nothing else (a Mail module draft:
-- provider 'mail', item_id the message id; a calendar event: provider
-- 'google' or 'microsoft', the provider's event id). Uninstalling the
-- package, or deleting the user, deletes the rows; an upgrade to another
-- signer or source deletes them too (src/plugins/packages/service.ts).
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS plugin_source jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS plugin_items (
  package_name text NOT NULL REFERENCES plugin_packages(name) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mail_draft', 'calendar_event')),
  provider text NOT NULL CHECK (provider IN ('mail', 'google', 'microsoft')),
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (package_name, kind, provider, item_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plugin_items_user_idx ON plugin_items (user_id);
