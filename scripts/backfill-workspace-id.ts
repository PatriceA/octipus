/**
 * Phase 4 — workspace_id backfill.
 *
 * Walks every user, ensures they have a default workspace, and stamps
 * their existing sessions / documents / hooks with that workspace id
 * (only rows where `workspace_id IS NULL`).
 *
 * Idempotent — re-running on a fully-backfilled database is a no-op.
 *
 * Usage:
 *   bun run scripts/backfill-workspace-id.ts            # backfill all
 *   bun run scripts/backfill-workspace-id.ts --dry-run  # report only
 *   bun run scripts/backfill-workspace-id.ts --user=<uuid>
 *
 * Required env: MASTER_KEY, JWT_SECRET, SESSION_SECRET, plus
 * DATABASE_URL (external mode) or DATA_DIR (embedded).
 *
 * Run BEFORE flipping `MULTIUSER_ORG_WORKSPACES=true` if you want
 * existing rows to be visible inside each user's default workspace
 * once the runtime starts filtering by workspace_id. Skipping the
 * backfill is also fine — rows with NULL workspace_id continue to
 * be visible across every workspace owned by the user (the
 * "user-level" scope), so nothing breaks; the data just isn't
 * partitioned.
 */
import { eq, sql } from 'drizzle-orm';
import { initializeDb, getDb, executeRaw } from '../src/db/postgres';
import { initializeStorage } from '../src/db/storage';
import { runMigrations } from '../src/db/migrate';
import { users } from '../src/db/schema/users';
import { getOrgWorkspaceManager } from '../src/security/orgs';
import { logger } from '../src/utils/logger';

interface Args {
  dryRun: boolean;
  onlyUser: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let onlyUser: string | null = null;
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--user=')) onlyUser = arg.slice('--user='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: bun run scripts/backfill-workspace-id.ts [--dry-run] [--user=<uuid>]');
      process.exit(0);
    }
  }
  return { dryRun, onlyUser };
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';

  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await runMigrations();

  const db = getDb();
  const mgr = getOrgWorkspaceManager();

  const userRows = args.onlyUser
    ? await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, args.onlyUser))
    : await db.select({ id: users.id, username: users.username }).from(users);

  logger.info({ users: userRows.length, dryRun: args.dryRun }, 'Workspace backfill: starting');

  // Tables to backfill — keyed by table name, with the SQL `user_id`
  // type. Some tables store user_id as text, others as uuid; the
  // executeRaw UPDATE has to match.
  const TABLES: { table: string; uuidUserId: boolean }[] = [
    { table: 'sessions',         uuidUserId: true  },
    { table: 'documents',        uuidUserId: false }, // text
    { table: 'hooks',            uuidUserId: true  },
    { table: 'agents',           uuidUserId: false }, // text
    { table: 'notifications',    uuidUserId: true  },
    { table: 'trajectory_runs',  uuidUserId: true  },
    { table: 'pipelines',        uuidUserId: true  },
    { table: 'embeddings',       uuidUserId: true  },
    { table: 'agent_events',     uuidUserId: false }, // text
    { table: 'swarm_nodes',      uuidUserId: false }, // text
    { table: 'vault',            uuidUserId: false }, // text — only scope='workspace' rows are backfilled
  ];

  const totals: Record<string, number> = {};
  for (const t of TABLES) totals[t.table] = 0;

  for (const user of userRows) {
    // Per-table count of unstamped rows.
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const userClause = t.uuidUserId
        ? `user_id = '${user.id}'::uuid`
        : `user_id = '${user.id}'`;
      // Vault: only backfill workspace-scoped rows.
      const scopeClause = t.table === 'vault' ? `AND scope = 'workspace'` : '';
      const rows = await db.execute(sql`
        SELECT count(*)::int AS c FROM ${sql.identifier(t.table)}
        WHERE ${sql.raw(userClause)} AND workspace_id IS NULL ${sql.raw(scopeClause)}
      `);
      const r = rows as unknown as Array<{ c: number }> | { rows: Array<{ c: number }> };
      const arr = Array.isArray(r) ? r : (r.rows ?? []);
      counts[t.table] = arr[0]?.c ?? 0;
    }
    const grandTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    if (grandTotal === 0) continue;

    if (args.dryRun) {
      logger.info({ userId: user.id, username: user.username, ...counts }, 'would backfill');
      for (const t of TABLES) totals[t.table] += counts[t.table];
      continue;
    }

    const ws = await mgr.ensureDefaultWorkspace(user.id);

    for (const t of TABLES) {
      if (counts[t.table] === 0) continue;
      const userClause = t.uuidUserId
        ? `user_id = '${user.id}'::uuid`
        : `user_id = '${user.id}'`;
      const scopeClause = t.table === 'vault' ? `AND scope = 'workspace'` : '';
      await executeRaw(
        `UPDATE ${t.table} SET workspace_id = '${ws.id}'
         WHERE ${userClause} AND workspace_id IS NULL ${scopeClause}`,
      );
      totals[t.table] += counts[t.table];
    }

    logger.info(
      { userId: user.id, username: user.username, workspaceId: ws.id, ...counts },
      'backfilled',
    );
  }

  // Sanity check: per-table count of remaining unstamped rows.
  const remaining: Record<string, number> = {};
  for (const t of TABLES) {
    const scopeClause = t.table === 'vault' ? `WHERE scope = 'workspace' AND workspace_id IS NULL` : 'WHERE workspace_id IS NULL';
    const rows = await db.execute(sql`SELECT count(*)::int AS c FROM ${sql.identifier(t.table)} ${sql.raw(scopeClause)}`);
    const r = rows as unknown as Array<{ c: number }> | { rows: Array<{ c: number }> };
    const arr = Array.isArray(r) ? r : (r.rows ?? []);
    remaining[t.table] = arr[0]?.c ?? 0;
  }

  logger.info(
    {
      backfilled: totals,
      remaining,
      dryRun: args.dryRun,
    },
    'Workspace backfill: complete',
  );

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Workspace backfill failed');
  process.exit(1);
});
