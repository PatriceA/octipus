/**
 * Space purge (docs/plans/coworking-spec.md §5.8, D15, I9).
 *
 * `purgeSpace` is the only code that deletes a shared workspace, and only one
 * archived for at least `spaces.purgeAfterArchiveDays` (no writes and no agent
 * runs since, so nothing races it). In one transaction it:
 *
 *   1. deletes the rows keyed by the space's sessions that no cascading key
 *      reaches (agents, tool actions, run events, approvals, …), whatever
 *      their own `workspace_id` says;
 *   2. deletes, for every `WORKSPACE_TABLES` entry whose purge action is
 *      `delete`, the rows with this `workspace_id` — sessions last, since
 *      other rows still point at them;
 *   3. counts what is left in those tables and aborts when anything is;
 *   4. writes the `space_purged` audit row and deletes the workspace row
 *      (its members and invites cascade).
 *
 * `keep` tables (audit log, cost log, cleanup history) have no foreign key to
 * workspaces, so their rows survive with the id. Nothing of the space ever
 * falls back to a member's personal scope.
 *
 * After commit the space's directories are removed. A failure there is
 * logged and left to `sweepPurgedSpaceFiles` (hourly, cron-runner), which
 * removes every space directory whose workspace row no longer exists.
 */
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { workspaces } from '@/db/schema/organizations';
import { WORKSPACE_TABLES } from '@/db/workspace-tables';
import { requireCan, SpaceError } from '@/security/space-access';
import { SPACES_DIR, spaceDirectories } from '@/security/workspace-fs';
import { coreLogger, securityLogger } from '@/utils/logger';
import { getMembership, type SpaceActor, writeSpaceAudit } from './service';

/**
 * Tables keyed by a session (or a run's root session) whose rows a deleted
 * session does not take along: no foreign key, or one that does not cascade.
 * The column is compared as text: its type differs from table to table.
 */
export const SESSION_KEYED_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'agent_approvals', column: 'session_id' },
  { table: 'agent_events', column: 'session_id' },
  { table: 'agents', column: 'session_id' },
  { table: 'hooks', column: 'session_id' },
  { table: 'permission_requests', column: 'session_id' },
  { table: 'pipelines', column: 'session_id' },
  { table: 'run_events', column: 'run_id' },
  { table: 'swarm_nodes', column: 'root_session_id' },
  { table: 'task_state', column: 'session_id' },
  { table: 'tool_actions', column: 'session_id' },
  { table: 'trajectory_runs', column: 'root_session_id' },
  { table: 'verification_evidence', column: 'session_id' },
];

export interface PurgeResult {
  workspaceId: string;
  /** Rows deleted per table. */
  deleted: Record<string, number>;
  /** Directories that could not be removed now (the sweep retries them). */
  leftoverDirectories: string[];
}

/** `tx.execute` returns a row array (postgres-js) or `{ rows }` (PGlite). */
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error('purgeSpace: unexpected query result shape');
}

/** Delete a space and everything in it, for good (owner only). */
export async function purgeSpace(actor: SpaceActor, workspaceId: string): Promise<PurgeResult> {
  const deleted: Record<string, number> = {};
  await getDb().transaction(async (tx) => {
    requireCan(await getMembership(actor.userId, workspaceId, tx), 'manage_space');
    const [space] = await tx
      .select({ archivedAt: workspaces.archivedAt })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, 'shared')))
      .for('update');
    if (!space) throw new SpaceError('not_found', 'Space not found');
    if (!space.archivedAt) throw new SpaceError('not_purgeable', 'Archive the space before deleting it');
    const days = getConfig().spaces.purgeAfterArchiveDays;
    if (Date.now() - space.archivedAt.getTime() < days * 24 * 3600_000) {
      throw new SpaceError('not_purgeable', `A space can be deleted ${days} day(s) after it was archived`);
    }

    const spaceSessions = sql`(SELECT id::text FROM sessions WHERE workspace_id = ${workspaceId})`;
    for (const t of SESSION_KEYED_TABLES) {
      const result = await tx.execute(sql`
        DELETE FROM ${sql.identifier(t.table)} WHERE ${sql.identifier(t.column)}::text IN ${spaceSessions} RETURNING 1
      `);
      deleted[t.table] = (deleted[t.table] ?? 0) + rows(result).length;
    }

    const purged = WORKSPACE_TABLES.filter((t) => t.purge === 'delete');
    const ordered = [...purged.filter((t) => t.table !== 'sessions'), ...purged.filter((t) => t.table === 'sessions')];
    for (const t of ordered) {
      const result = await tx.execute(sql`DELETE FROM ${sql.identifier(t.table)} WHERE workspace_id = ${workspaceId} RETURNING 1`);
      deleted[t.table] = (deleted[t.table] ?? 0) + rows(result).length;
    }

    for (const t of purged) {
      const left = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t.table)} WHERE workspace_id = ${workspaceId}`);
      const n = Number(rows<{ n: number }>(left)[0]?.n ?? 0);
      if (n > 0) throw new Error(`purgeSpace: ${n} row(s) of ${t.table} still name space ${workspaceId}; aborting`);
    }

    await writeSpaceAudit(tx, {
      actorId: actor.userId,
      action: 'space_purged',
      workspaceId,
      details: { deleted },
    });
    await tx.delete(workspaces).where(and(eq(workspaces.id, workspaceId), eq(workspaces.kind, 'shared')));
  });
  securityLogger.warn({ workspaceId, by: actor.userId, deleted }, 'Space purged');

  const leftoverDirectories: string[] = [];
  const dirs = spaceDirectories(workspaceId);
  for (const dir of [dirs.root, dirs.documents]) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      coreLogger.error({ err, workspaceId, dir }, 'Purged space directory not removed; the hourly sweep retries it');
      leftoverDirectories.push(dir);
    }
  }
  return { workspaceId, deleted, leftoverDirectories };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove every space directory (files and uploads) whose workspace row no
 * longer exists: the retry for a purge whose directory removal failed.
 * Returns the directories removed; failures are logged and retried next time.
 */
export async function sweepPurgedSpaceFiles(): Promise<string[]> {
  const config = getConfig();
  const parents = [
    join(config.workspace.rootPath || './workspace', SPACES_DIR),
    join(config.workspace.documentsPath || './workspace/documents', SPACES_DIR),
  ];
  const candidates = new Set<string>();
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && UUID_RE.test(entry.name)) candidates.add(entry.name);
    }
  }
  if (candidates.size === 0) return [];
  const ids = [...candidates];
  const existing = await getDb().execute(sql`SELECT id::text AS id FROM workspaces WHERE id::text IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  const alive = new Set(rows<{ id: string }>(existing).map((r) => r.id));
  const removed: string[] = [];
  for (const id of ids) {
    if (alive.has(id)) continue;
    const dirs = spaceDirectories(id);
    for (const dir of [dirs.root, dirs.documents]) {
      if (!existsSync(dir)) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch (err) {
        coreLogger.error({ err, workspaceId: id, dir }, 'Space directory sweep failed; retrying next time');
      }
    }
  }
  if (removed.length > 0) coreLogger.info({ removed }, 'Removed directories of purged spaces');
  return removed;
}
