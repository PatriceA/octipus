/**
 * Phase 4 — workspace_id backfill.
 *
 * Walks every user, ensures they have a default workspace, and stamps
 * their user-level rows (`workspace_id IS NULL`) of every table that
 * WORKSPACE_TABLES (`src/db/workspace-tables.ts`) marks `move` — the
 * tables whose rows are a workspace's working state — with that
 * workspace id. Vault: only `scope='workspace'` secrets. Notes: a
 * user-level note whose slug the default workspace already uses stays
 * user-level (the slug names one note per workspace).
 *
 * Idempotent — re-running on a fully-backfilled database is a no-op.
 *
 * Usage:
 *   npx tsx scripts/backfill-workspace-id.ts            # backfill all
 *   npx tsx scripts/backfill-workspace-id.ts --dry-run  # report only
 *   npx tsx scripts/backfill-workspace-id.ts --user=<uuid>
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
import { initializeDb, getDb } from '../src/db/postgres';
import { initializeStorage } from '../src/db/storage';
import { runMigrations } from '../src/db/migrate';
import { users } from '../src/db/schema/users';
import { workspaceMoveTables } from '../src/db/workspace-tables';
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
      console.log('Usage: npx tsx scripts/backfill-workspace-id.ts [--dry-run] [--user=<uuid>]');
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

  // The same list workspace transfer walks. `user_id` is text on some
  // tables and uuid on others, so it is compared to a bound parameter.
  const TABLES = workspaceMoveTables();
  // Per-table predicate on the rows to stamp, for a given target workspace.
  const extraClause = (t: (typeof TABLES)[number], wsId: string | null) => {
    const parts = [];
    if (t.rowFilter) parts.push(sql` AND ${sql.raw(t.rowFilter)}`);
    if (t.table === 'notes' && wsId) {
      parts.push(sql` AND NOT EXISTS (SELECT 1 FROM notes taken WHERE taken.workspace_id = ${wsId} AND taken.user_id = notes.user_id AND taken.slug = notes.slug)`);
    }
    return sql.join(parts, sql``);
  };

  const totals: Record<string, number> = {};
  for (const t of TABLES) totals[t.table] = 0;

  for (const user of userRows) {
    // Per-table count of unstamped rows.
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS c FROM ${sql.identifier(t.table)}
        WHERE ${sql.identifier(t.ownerColumn)} = ${user.id} AND workspace_id IS NULL${extraClause(t, null)}
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
      const updated = await db.execute(sql`
        UPDATE ${sql.identifier(t.table)} SET workspace_id = ${ws.id}
        WHERE ${sql.identifier(t.ownerColumn)} = ${user.id} AND workspace_id IS NULL${extraClause(t, ws.id)}
        RETURNING 1
      `);
      const r = updated as unknown as unknown[] | { rows: unknown[] };
      totals[t.table] += Array.isArray(r) ? r.length : (r.rows ?? []).length;
    }

    logger.info(
      { userId: user.id, username: user.username, workspaceId: ws.id, ...counts },
      'backfilled',
    );
  }

  // Sanity check: per-table count of remaining unstamped rows.
  const remaining: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = await db.execute(sql`SELECT count(*)::int AS c FROM ${sql.identifier(t.table)} WHERE workspace_id IS NULL${extraClause(t, null)}`);
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
