import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * The personal predicate (docs/plans/coworking-spec.md §5.5, I2): the row is
 * in no workspace, or in a personal one. Every personal read carries it —
 * through `workspaceFilter` here, and on its own in the raw readers outside
 * the repositories — so a personal path never returns a space's rows, for
 * their author and for an admin alike. `column` is a `workspace_id` column
 * (or an aliased one); a NULL workspace is personal.
 *
 * Positive on purpose: a row still naming a workspace that no longer exists
 * (a purged space's row on a table without a foreign key) is nobody's
 * personal row. "Not in a shared workspace" would hand it to its author.
 */
export function notInSharedWorkspace(column: AnyPgColumn | SQL): SQL {
  return sql`(${column} IS NULL OR EXISTS (SELECT 1 FROM workspaces pw WHERE pw.id = ${column} AND pw.kind = 'personal'))`;
}
