/**
 * The highest protection level a package has read for a user, kept across
 * calls (docs/PLUGIN-PACKAGES.md#protection-levels).
 *
 * A call's own `readLevel` (./host-api.ts) covers that call only: a package
 * could read a level-2 document in one call and write it into a note or a
 * task (which have no protection level) in the next, laundering it down to
 * level 1. So what a package read is remembered per package and user, in the
 * key-value store (`kv_store`, so it holds across restarts and instances),
 * and every host API request starts from it:
 *
 * - notes and tasks have no protection level, so a package that has read
 *   above level 1 is refused there (a boundary: what `maxProtection`
 *   declares, enforced at runtime);
 * - documents it writes are stored at no lower than that level;
 * - its `model:complete` calls run at that content level.
 *
 * It is reset when the package is disabled, upgraded or uninstalled: its
 * memory of what it read goes with the process state of that version.
 */
import { and, like, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { kvStore } from '@/db/schema/kv';

const PREFIX = 'plugin-read-level:';

const keyOf = (pkg: string, userId: string) => `${PREFIX}${pkg}:${userId}`;

/** The highest level `pkg` has read for `userId` (1 when nothing above 1). */
export async function readLevelOf(pkg: string, userId: string): Promise<number> {
  const [row] = await getDb().select({ value: kvStore.value }).from(kvStore).where(sql`${kvStore.key} = ${keyOf(pkg, userId)}`).limit(1);
  const level = row ? Number.parseInt(row.value, 10) : 1;
  return Number.isInteger(level) && level >= 1 && level <= 4 ? level : 4;
}

/** Remember that `pkg` read content at `level` for `userId` (keeps the highest). */
export async function recordReadLevel(pkg: string, userId: string, level: number): Promise<void> {
  if (!(level > 1)) return;
  const value = String(Math.min(4, Math.ceil(level)));
  await getDb().insert(kvStore).values({ key: keyOf(pkg, userId), value, expiresAt: null })
    .onConflictDoUpdate({ target: kvStore.key, set: { value: sql`GREATEST(${kvStore.value}::int, ${value}::int)::text` } });
}

/** Forget what `pkg` read, for every user (disabled, upgraded or uninstalled). */
export async function resetReadLevels(pkg: string): Promise<void> {
  await getDb().delete(kvStore).where(and(like(kvStore.key, `${PREFIX}${pkg.replace(/[%_\\]/g, '\\$&')}:%`)));
}
