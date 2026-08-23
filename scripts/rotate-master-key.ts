/**
 * Master-key rotation — Phase 3a follow-up to per-user DEKs.
 *
 * Phase 1b-2 introduced per-user DEKs derived via HKDF from the
 * master key. The keys themselves never live on disk, but the master
 * key sits in env (`MASTER_KEY`) — when that key gets compromised
 * (committed to a public repo, exposed via a leaked .env file, or
 * just rotated on a normal hygiene cadence) every vault row needs to
 * be re-encrypted with a freshly-derived DEK.
 *
 * This script does the rewrite. Each row is decrypted with the OLD
 * master's per-(scope, user) DEK and re-encrypted with the NEW
 * master's DEK. The scope + userId pair stays identical so existing
 * cross-tenant isolation is preserved.
 *
 * Usage:
 *
 *   OLD_MASTER_KEY=... NEW_MASTER_KEY=... \
 *     npx tsx scripts/rotate-master-key.ts
 *
 *   # Dry run (report only, no writes):
 *   OLD_MASTER_KEY=... NEW_MASTER_KEY=... \
 *     npx tsx scripts/rotate-master-key.ts --dry-run
 *
 *   # Custom batch size:
 *   npx tsx scripts/rotate-master-key.ts --batch=200
 *
 * Idempotent — re-running the same (OLD, NEW) pair is safe; rows
 * already encrypted with NEW are reported as `skipped`. Failures on
 * a single row (e.g. the row was inserted between batches with a
 * key version we don't know about) are logged and the batch
 * continues — partial progress is durable because each row is its
 * own UPDATE.
 *
 * Operator runbook:
 *
 *   1. Generate the new key (32 bytes hex):
 *        openssl rand -hex 32
 *   2. Stop the Octipus server (or take a maintenance window).
 *   3. Run this script with both keys in env.
 *   4. Update the deployment's MASTER_KEY env var to NEW.
 *   5. Restart the server.
 *   6. Verify by issuing/reading a vault entry.
 *
 * The script does NOT modify the running env or any deployment
 * state — it only rewrites DB rows. The MASTER_KEY env var swap is
 * intentionally a separate operator step.
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb, initializeDb, initializeExtensions } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { vault } from '../src/db/schema/vault';
import { rotateVaultRowMasterKey } from '../src/security/vault';
import { logger } from '../src/utils/logger';

interface Args {
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let batchSize = 100;
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--batch=')) {
      const n = parseInt(arg.slice('--batch='.length), 10);
      if (!Number.isFinite(n) || n < 1) throw new Error(`invalid --batch: ${arg}`);
      batchSize = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npx tsx scripts/rotate-master-key.ts [--dry-run] [--batch=N]');
      console.log('');
      console.log('Required env: OLD_MASTER_KEY, NEW_MASTER_KEY');
      console.log('              DATABASE_URL (external) or DATA_DIR (embedded)');
      process.exit(0);
    }
  }
  return { dryRun, batchSize };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length < 32) {
    throw new Error(`${name} env var is required and must be ≥32 characters`);
  }
  return v;
}

async function main() {
  const args = parseArgs(process.argv);
  const oldKey = Buffer.from(requireEnv('OLD_MASTER_KEY'));
  const newKey = Buffer.from(requireEnv('NEW_MASTER_KEY'));

  if (Buffer.compare(oldKey, newKey) === 0) {
    throw new Error('OLD_MASTER_KEY and NEW_MASTER_KEY are identical — nothing to rotate');
  }

  // Make sure the cached vault singleton is NOT initialized — the
  // rotation helper takes both keys as args and works even when no
  // master is registered. Initializing the vault would pin the
  // module-level cache to whichever MASTER_KEY happens to be in env,
  // which could mask a misconfiguration.
  if (process.env.MASTER_KEY) {
    logger.warn(
      'MASTER_KEY env var is set; ignoring it. Rotation uses OLD_MASTER_KEY / NEW_MASTER_KEY only.',
    );
  }

  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';
  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeExtensions();

  const db = getDb();
  const allRows = await db.select({ id: vault.id, isActive: vault.isActive }).from(vault);
  const candidates = allRows.filter((r) => r.isActive);
  logger.info(
    { totalRows: allRows.length, activeRows: candidates.length, batchSize: args.batchSize, dryRun: args.dryRun },
    'Master-key rotation: candidates identified',
  );

  if (args.dryRun) {
    logger.info({ count: candidates.length }, 'Dry run complete — no changes written');
    return;
  }

  let rotated = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < candidates.length; i += args.batchSize) {
    const batch = candidates.slice(i, i + args.batchSize);
    for (const row of batch) {
      try {
        const outcome = await rotateVaultRowMasterKey(row.id, oldKey, newKey);
        if (outcome === 'rotated') rotated++;
        else if (outcome === 'skipped') skipped++;
        else failed++;
      } catch (err) {
        failed++;
        logger.error({ id: row.id, err }, 'rotate-master-key: failed to rotate row');
      }
    }
    logger.info(
      { processed: Math.min(i + batch.length, candidates.length), total: candidates.length, rotated, skipped, failed },
      'rotate-master-key: progress',
    );
  }

  logger.info({ rotated, skipped, failed }, 'Master-key rotation complete');
  if (failed > 0) {
    logger.warn(
      'Some rows failed to rotate — they remain readable with OLD_MASTER_KEY. Investigate before swapping the deployment env var.',
    );
  }
}

main()
  .then(async () => {
    await closeDb();
    if ((process.env.STORAGE_MODE || 'external') === 'embedded') await closeStorage();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Master-key rotation failed');
    try { await closeDb(); } catch { /* ignore */ }
    process.exit(1);
  });
