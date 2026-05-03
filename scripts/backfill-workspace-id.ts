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
import { isNull } from 'drizzle-orm';
import { eq, sql } from 'drizzle-orm';
import { initializeDb, getDb, executeRaw } from '../src/db/postgres';
import { initializeStorage } from '../src/db/storage';
import { runMigrations } from '../src/db/migrate';
import { documents } from '../src/db/schema/documents';
import { hooks } from '../src/db/schema/hooks';
import { sessions } from '../src/db/schema/sessions';
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

  let totalSessions = 0;
  let totalDocs = 0;
  let totalHooks = 0;

  for (const user of userRows) {
    // Counts of unstamped rows for this user.
    const [{ count: sessionCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(sql`${sessions.userId} = ${user.id}::uuid AND ${sessions.workspaceId} IS NULL`);
    const [{ count: docCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(sql`${documents.userId} = ${user.id} AND ${documents.workspaceId} IS NULL`);
    const [{ count: hookCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(hooks)
      .where(sql`${hooks.userId} = ${user.id}::uuid AND ${hooks.workspaceId} IS NULL`);

    if (sessionCount === 0 && docCount === 0 && hookCount === 0) continue;

    if (args.dryRun) {
      logger.info(
        { userId: user.id, username: user.username, sessions: sessionCount, documents: docCount, hooks: hookCount },
        'would backfill',
      );
      totalSessions += sessionCount;
      totalDocs += docCount;
      totalHooks += hookCount;
      continue;
    }

    // Make sure the user has a default workspace (creates one on
    // first call). The manager handles the partial-unique-index
    // semantics so the row is the canonical default.
    const ws = await mgr.ensureDefaultWorkspace(user.id);

    if (sessionCount > 0) {
      await executeRaw(
        `UPDATE sessions SET workspace_id = '${ws.id}'
         WHERE user_id = '${user.id}' AND workspace_id IS NULL`,
      );
      totalSessions += sessionCount;
    }
    if (docCount > 0) {
      await executeRaw(
        `UPDATE documents SET workspace_id = '${ws.id}'
         WHERE user_id = '${user.id}' AND workspace_id IS NULL`,
      );
      totalDocs += docCount;
    }
    if (hookCount > 0) {
      await executeRaw(
        `UPDATE hooks SET workspace_id = '${ws.id}'
         WHERE user_id = '${user.id}' AND workspace_id IS NULL`,
      );
      totalHooks += hookCount;
    }

    logger.info(
      {
        userId: user.id,
        username: user.username,
        workspaceId: ws.id,
        sessions: sessionCount,
        documents: docCount,
        hooks: hookCount,
      },
      'backfilled',
    );
  }

  // Sanity check: count remaining unstamped rows.
  const [{ count: remainingSessions }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(isNull(sessions.workspaceId));
  const [{ count: remainingDocs }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(isNull(documents.workspaceId));
  const [{ count: remainingHooks }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(hooks)
    .where(isNull(hooks.workspaceId));

  logger.info(
    {
      backfilled: { sessions: totalSessions, documents: totalDocs, hooks: totalHooks },
      remaining: { sessions: remainingSessions, documents: remainingDocs, hooks: remainingHooks },
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
