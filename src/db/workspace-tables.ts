/**
 * Every table with a `workspace_id` column, and what each one does when
 * its workspace changes hands or goes away. The single list that
 * workspace transfer (`OrgWorkspaceManager.transfer`), the backfill
 * script (`scripts/backfill-workspace-id.ts`) and the space purge (S1)
 * walk, so a new workspace-scoped table cannot be forgotten by one of
 * them: `workspace-tables.test.ts` reads `information_schema.columns`
 * and fails when a table with a `workspace_id` column is missing here.
 *
 * - `transfer: 'move'` — the rows are the workspace's working state;
 *   transfer reassigns the owner column of the previous owner's rows to
 *   the recipient. `'n/a'` — the row does not follow (it has no owner
 *   column, or it belongs to its user rather than to the workspace).
 * - `purge: 'delete'` — a purged space deletes the rows. `'keep'` —
 *   history that outlives the space.
 * - `ownerColumn` — the column naming the row's owner (or, in a space,
 *   its author). Its SQL type varies (text on some older tables), so
 *   callers compare it to a bound string parameter, never a cast.
 * - `rowFilter` — an extra SQL predicate on the rows that belong to the
 *   workspace (vault: only `scope='workspace'` secrets do; user secrets
 *   are the user's wherever they were created).
 * - `reencrypt` — the row is encrypted under a key derived from its
 *   owner, so moving it must re-encrypt it (vault).
 */

export type WorkspaceTransferAction = 'move' | 'n/a';
export type WorkspacePurgeAction = 'delete' | 'keep';

export interface WorkspaceTable {
  readonly table: string;
  readonly ownerColumn: string | null;
  readonly transfer: WorkspaceTransferAction;
  readonly purge: WorkspacePurgeAction;
  readonly rowFilter?: string;
  readonly reencrypt?: true;
}

export const WORKSPACE_TABLES: readonly WorkspaceTable[] = [
  { table: 'agent_events', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'agents', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  // Keyed by workspace alone (`created_by_user_id` is attribution): they
  // follow the workspace row itself.
  { table: 'artifacts', ownerColumn: null, transfer: 'n/a', purge: 'delete' },
  // A space's audit trail outlives it (no foreign key to workspaces); the
  // actor column stays the actor through a transfer.
  { table: 'audit_log', ownerColumn: 'user_id', transfer: 'n/a', purge: 'keep' },
  { table: 'background_jobs', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  // Retention history of what a cleanup removed.
  { table: 'cleanup_audit_log', ownerColumn: 'user_id', transfer: 'n/a', purge: 'keep' },
  // Billing history: who spent what, where. Outlives the space.
  { table: 'cost_log', ownerColumn: 'user_id', transfer: 'n/a', purge: 'keep' },
  { table: 'documents', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'embeddings', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'hooks', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'knowledge_links', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'memories', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'notes', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  // A user's inbox: it stays with them.
  { table: 'notifications', ownerColumn: 'user_id', transfer: 'n/a', purge: 'delete' },
  // A request belongs to the agent run that raised it, not to the workspace.
  { table: 'permission_requests', ownerColumn: 'user_id', transfer: 'n/a', purge: 'delete' },
  { table: 'pipelines', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'sessions', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  // Space memory (S2): only shared workspaces have it, and they are never
  // transferred; its RESTRICT key makes the purge delete it first.
  { table: 'space_memory', ownerColumn: 'author_user_id', transfer: 'n/a', purge: 'delete' },
  { table: 'swarm_nodes', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'task_state', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'tasks', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'trajectory_runs', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
  { table: 'vault', ownerColumn: 'user_id', transfer: 'move', purge: 'delete', rowFilter: "scope = 'workspace'", reencrypt: true },
  // Space membership and invites (S1): only shared workspaces have them, and
  // shared workspaces are never transferred. The workspace row's own
  // cascade would delete them; purge deletes them like any other row.
  { table: 'workspace_invites', ownerColumn: 'created_by', transfer: 'n/a', purge: 'delete' },
  { table: 'workspace_members', ownerColumn: 'user_id', transfer: 'n/a', purge: 'delete' },
  { table: 'workspace_repos', ownerColumn: 'user_id', transfer: 'move', purge: 'delete' },
];

/** The tables a workspace transfer reassigns, in list order. */
export function workspaceMoveTables(): readonly (WorkspaceTable & { ownerColumn: string })[] {
  return WORKSPACE_TABLES.filter((t) => t.transfer === 'move').map((t) => {
    if (t.ownerColumn === null) throw new Error(`WORKSPACE_TABLES: ${t.table} is 'move' but has no owner column`);
    return { ...t, ownerColumn: t.ownerColumn };
  });
}
