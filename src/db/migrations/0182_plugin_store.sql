-- The per-user plugin store (docs/PLUGIN-PACKAGES.md#store).
--
-- Small JSON values a plugin package keeps through the host API, per key,
-- separately for each user and each workspace: the host answers a call for
-- the user on its token, in the workspace the call ran in, only, so a package
-- can never reach another user's entries, and what a user's call keeps in a
-- shared space is readable in that space only. There is no row without a
-- user: no store shared across users. workspace_id NULL: the user's personal
-- workspace.
--
-- size_bytes: 128 bytes of overhead, the key, and the value as the database
-- serialises it (octet_length(value::text)), counted against the package's
-- quota per user. protection_level: the call's level when the entry was
-- written (never lowered by an overwrite); reading it raises the call's
-- level to it. version: 1 on insert, +1 on every write (compare-and-set with
-- ifVersion).
--
-- Uninstalling the package (its plugin_packages row), deleting the user or
-- the workspace deletes the rows; a user leaving a space deletes theirs of
-- that space (src/core/spaces/service.ts).
CREATE TABLE IF NOT EXISTS plugin_store (
  package_name text NOT NULL REFERENCES plugin_packages(name) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  protection_level smallint NOT NULL DEFAULT 1 CHECK (protection_level BETWEEN 1 AND 4),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS plugin_store_key_uq ON plugin_store (package_name, user_id, workspace_id, key) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plugin_store_user_idx ON plugin_store (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS plugin_store_workspace_idx ON plugin_store (workspace_id) WHERE workspace_id IS NOT NULL;
--> statement-breakpoint
-- What each (package, user, workspace) keeps: a running total, updated in the
-- same transaction as every write and delete of plugin_store, so the quota
-- check reads a few rows instead of summing every entry.
CREATE TABLE IF NOT EXISTS plugin_store_usage (
  package_name text NOT NULL REFERENCES plugin_packages(name) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  entries integer NOT NULL DEFAULT 0 CHECK (entries >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS plugin_store_usage_uq ON plugin_store_usage (package_name, user_id, workspace_id) NULLS NOT DISTINCT;
