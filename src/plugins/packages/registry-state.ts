/**
 * Rollback protection for signed registry indexes
 * (docs/PLUGIN-PACKAGES.md#online-revocation): each registry's `generatedAt`
 * only moves forward. An index older than the last one accepted from the
 * same registry URL — a replay of an old, validly signed index that lacks a
 * later revocation or carries a since-fixed version — is refused, and so is
 * a different index with the same `generatedAt`, or one dated more than a day
 * ahead of this host's clock (it would lock out every honest index until then).
 *
 * The check and the advance are one statement (a conditional upsert), so two
 * concurrent reads cannot both pass an older index.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { pluginRegistryState } from '@/db/schema/plugin-packages';

/** How far ahead of this host's clock an index may be dated. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export class IndexRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexRollbackError';
  }
}

/**
 * Accept `generatedAt` (with the sha256 of the exact index bytes and the key
 * that signed it) as the registry's newest, or throw `IndexRollbackError`
 * saying why not.
 *
 * `distrustedKeys` are keys revoked now (including by the index being
 * accepted): a last index signed by one of them holds nothing back. Without
 * that, a leaked key could sign an index dated a day ahead and so lock out,
 * for that day, the index the backup key signs to revoke it.
 */
export async function acceptIndexTime(
  registryUrl: string, generatedAt: Date, indexSha256: string, signedBy: string,
  distrustedKeys: readonly string[] = [], now = new Date(),
): Promise<void> {
  if (Number.isNaN(generatedAt.getTime())) throw new IndexRollbackError('The index has no readable generatedAt');
  if (generatedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new IndexRollbackError(`The index is dated ${generatedAt.toISOString()}, more than a day ahead of this host's clock; refused`);
  }
  const db = getDb();
  const at = generatedAt.toISOString();
  const distrusted = distrustedKeys.length > 0
    ? sql` OR ${pluginRegistryState.lastSignedBy} IN (${sql.join(distrustedKeys.map((k) => sql`${k}`), sql`, `)})`
    : sql``;
  const accepted = await db.insert(pluginRegistryState)
    .values({ registryUrl, lastGeneratedAt: generatedAt, lastIndexSha256: indexSha256, lastSignedBy: signedBy, updatedAt: now })
    .onConflictDoUpdate({
      target: pluginRegistryState.registryUrl,
      set: { lastGeneratedAt: generatedAt, lastIndexSha256: indexSha256, lastSignedBy: signedBy, updatedAt: now },
      setWhere: sql`${pluginRegistryState.lastGeneratedAt} < ${at}::timestamptz
        OR (${pluginRegistryState.lastGeneratedAt} = ${at}::timestamptz AND ${pluginRegistryState.lastIndexSha256} = ${indexSha256})${distrusted}`,
    })
    .returning({ registryUrl: pluginRegistryState.registryUrl });
  if (accepted.length > 0) return;
  const [last] = await db.select().from(pluginRegistryState).where(sql`${pluginRegistryState.registryUrl} = ${registryUrl}`).limit(1);
  const lastAt = last?.lastGeneratedAt.toISOString() ?? 'unknown';
  if (last && last.lastGeneratedAt.getTime() === generatedAt.getTime()) {
    throw new IndexRollbackError(`The index has the same generatedAt (${lastAt}) as the last one accepted, but different content; refused`);
  }
  throw new IndexRollbackError(`The index was generated at ${at}, before the last one accepted from this registry (${lastAt}): an older index is never accepted again (a rollback); refused`);
}

/** The last accepted `generatedAt` of a registry URL, or null. */
export async function lastIndexTime(registryUrl: string): Promise<Date | null> {
  const [row] = await getDb().select().from(pluginRegistryState).where(sql`${pluginRegistryState.registryUrl} = ${registryUrl}`).limit(1);
  return row?.lastGeneratedAt ?? null;
}
