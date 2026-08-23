/**
 * Vault key rotation — Phase 1b-2 follow-up.
 *
 * Walks every active vault row at `key_version=1` and rewrites it at
 * version 2 (per-user HKDF DEK). Phase 1b-2 already does this lazily on
 * read; this script forces the migration for cold rows that haven't
 * been touched since the upgrade.
 *
 * Usage:
 *   npx tsx scripts/rotate-vault-keys.ts            # rotate everything
 *   npx tsx scripts/rotate-vault-keys.ts --dry-run  # report only
 *   npx tsx scripts/rotate-vault-keys.ts --batch=50 # tune batch size
 *
 * Required env: MASTER_KEY, JWT_SECRET, SESSION_SECRET, plus
 * DATABASE_URL (external mode) or DATA_DIR (embedded).
 *
 * Safe to re-run — rows already at version 2 are skipped. The script
 * never deletes data; on a decryption failure it logs the row id and
 * continues so the operator can investigate without aborting the
 * whole batch.
 */
import { eq } from 'drizzle-orm';
import { closeDb, getDb, initializeDb, initializeExtensions } from '../src/db/postgres';
import { closeStorage, initializeStorage } from '../src/db/storage';
import { vault } from '../src/db/schema/vault';
import { initializeVault, getVault } from '../src/security/vault';
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
      console.log('Usage: npx tsx scripts/rotate-vault-keys.ts [--dry-run] [--batch=N]');
      process.exit(0);
    }
  }
  return { dryRun, batchSize };
}

async function main() {
  const args = parseArgs(process.argv);
  const mode = (process.env.STORAGE_MODE || 'external') as 'embedded' | 'external';

  if (mode === 'embedded') initializeStorage({ mode: 'embedded' });
  await initializeDb();
  await initializeExtensions();
  await initializeVault();

  const db = getDb();
  const vaultApi = getVault();

  // Count work up-front for progress reporting.
  const v1Rows = await db
    .select({ id: vault.id, userId: vault.userId, scope: vault.scope, name: vault.name, isActive: vault.isActive })
    .from(vault)
    .where(eq(vault.keyVersion, 1));

  const active = v1Rows.filter((r) => r.isActive);
  logger.info(
    { totalV1: v1Rows.length, activeV1: active.length, batchSize: args.batchSize, dryRun: args.dryRun },
    'Vault rotation: candidates identified',
  );

  if (args.dryRun) {
    for (const r of active) {
      logger.info({ id: r.id, userId: r.userId, scope: r.scope, name: r.name }, 'would rotate');
    }
    logger.info({ count: active.length }, 'Dry run complete — no changes written');
    return;
  }

  let rotated = 0;
  let failed = 0;
  // Each `getByName / get` call decrypts and (because of the lazy
  // re-encryption inside vault.get) writes the row back at the current
  // key version. We use `getByName` so we don't need to know the row's
  // id; passing the userId lets the strict scope check pass.
  for (let i = 0; i < active.length; i += args.batchSize) {
    const batch = active.slice(i, i + args.batchSize);
    for (const row of batch) {
      try {
        // The lazy re-encryption path requires a successful decrypt;
        // anything else (key mismatch, corrupted ciphertext) raises.
        const value = await vaultApi.get(row.userId, row.id);
        if (value === null) {
          logger.warn({ id: row.id }, 'rotate: row returned null (expired?)');
          failed++;
          continue;
        }
        rotated++;
      } catch (err) {
        failed++;
        logger.error({ id: row.id, userId: row.userId, err }, 'rotate: decrypt failed — leaving row at v1');
      }
    }
    logger.info(
      { processed: Math.min(i + batch.length, active.length), total: active.length, rotated, failed },
      'rotate: progress',
    );
  }

  // Sanity check: count remaining v1 rows.
  const remaining = await db
    .select({ id: vault.id })
    .from(vault)
    .where(eq(vault.keyVersion, 1));
  logger.info({ rotated, failed, remainingV1: remaining.length }, 'Vault rotation complete');
}

main()
  .then(async () => {
    await closeDb();
    if ((process.env.STORAGE_MODE || 'external') === 'embedded') await closeStorage();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'Vault rotation failed');
    try { await closeDb(); } catch { /* ignore */ }
    process.exit(1);
  });
