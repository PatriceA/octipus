-- The per-user plugin store (docs/PLUGIN-PACKAGES.md#store).
--
-- Small JSON values a plugin package keeps through the host API, per key,
-- separately for each user: the host answers a call for the user on its
-- token only, so a package can never reach another user's entries. There is
-- no row without a user: no store shared across users.
--
-- size_bytes: the key and the JSON value in UTF-8 bytes, counted against the
-- package's quota per user. protection_level: the call's read level when the
-- entry was written; reading it raises the call's level to it. version: 1 on
-- insert, +1 on every write (compare-and-set with ifVersion).
--
-- Uninstalling the package (its plugin_packages row) or deleting the user
-- deletes the rows.
CREATE TABLE IF NOT EXISTS plugin_store (
  package_name text NOT NULL REFERENCES plugin_packages(name) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  protection_level smallint NOT NULL DEFAULT 1 CHECK (protection_level BETWEEN 1 AND 4),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plugin_store_key_uq UNIQUE (package_name, user_id, key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plugin_store_user_idx ON plugin_store (user_id);
