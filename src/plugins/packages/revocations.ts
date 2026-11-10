/**
 * Online revocation (docs/PLUGIN-PACKAGES.md#online-revocation): the package
 * versions and keys the marketplace's signed index revokes, kept in the
 * database so they hold while the marketplace is unreachable and across
 * restarts.
 *
 * They only accumulate. A later index that no longer lists one does not lift
 * it (a replayed older index, or a tampered mirror, must never un-revoke). An
 * admin can clear one (`clearRevocation`, audited); the row stays as history,
 * and an index that still lists the revocation revokes it again.
 *
 * Which index may revoke what is decided before anything gets here
 * (./marketplace.ts, `acceptMarketplaceRevocations`); this module only stores
 * and answers.
 */
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { type PluginRevocationRow, pluginRevocations } from '@/db/schema/plugin-packages';

export interface RevocationInput {
  kind: 'package' | 'key';
  name?: string;
  version?: string;
  keyId?: string;
  reason: string;
}

export interface RevocationSource {
  registryUrl: string;
  /** The key id that signed the index the revocation came from. */
  signedByKey: string;
  indexGeneratedAt: Date;
}

/** The revocations in force (not cleared). */
export async function activeRevocations(): Promise<PluginRevocationRow[]> {
  return getDb().select().from(pluginRevocations).where(isNull(pluginRevocations.clearedAt));
}

/** Key ids the marketplace revoked (in force). */
export async function revokedKeyIds(): Promise<string[]> {
  const rows = await getDb().select({ keyId: pluginRevocations.keyId }).from(pluginRevocations)
    .where(and(eq(pluginRevocations.kind, 'key'), isNull(pluginRevocations.clearedAt)));
  return rows.map((r) => r.keyId).filter((k): k is string => typeof k === 'string');
}

/** The revocation in force of `name@version`, or null. */
export async function packageRevocation(name: string, version: string): Promise<PluginRevocationRow | null> {
  const [row] = await getDb().select().from(pluginRevocations).where(and(
    eq(pluginRevocations.kind, 'package'), eq(pluginRevocations.name, name), eq(pluginRevocations.version, version), isNull(pluginRevocations.clearedAt),
  )).limit(1);
  return row ?? null;
}

/** The revocation in force of a key id, or null. */
export async function keyRevocation(keyId: string): Promise<PluginRevocationRow | null> {
  const [row] = await getDb().select().from(pluginRevocations).where(and(
    eq(pluginRevocations.kind, 'key'), eq(pluginRevocations.keyId, keyId), isNull(pluginRevocations.clearedAt),
  )).limit(1);
  return row ?? null;
}

/**
 * Store revocations; one already in force is left as it is. Returns the rows
 * that are new (for the admins' notification).
 */
export async function recordRevocations(items: readonly RevocationInput[], source: RevocationSource): Promise<PluginRevocationRow[]> {
  const added: PluginRevocationRow[] = [];
  for (const item of items) {
    const rows = await getDb().insert(pluginRevocations).values({
      kind: item.kind,
      name: item.kind === 'package' ? item.name ?? null : null,
      version: item.kind === 'package' ? item.version ?? null : null,
      keyId: item.kind === 'key' ? item.keyId ?? null : null,
      reason: item.reason.slice(0, 500),
      registryUrl: source.registryUrl,
      signedByKey: source.signedByKey,
      indexGeneratedAt: source.indexGeneratedAt,
    }).onConflictDoNothing().returning();
    added.push(...rows);
  }
  return added;
}

/** Every revocation, cleared ones too (newest first), for the admin. */
export async function listRevocations(): Promise<PluginRevocationRow[]> {
  const rows = await getDb().select().from(pluginRevocations);
  return rows.sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
}

/**
 * Lift one revocation (an admin's decision, audited). The row stays, marked
 * cleared. Returns null when there is no such revocation in force. An index
 * that still lists it revokes it again on its next read.
 */
export async function clearRevocation(id: string, actorUserId: string, reason: string): Promise<PluginRevocationRow | null> {
  const where: SQL[] = [eq(pluginRevocations.id, id), isNull(pluginRevocations.clearedAt)];
  const [row] = await getDb().update(pluginRevocations)
    .set({ clearedAt: new Date(), clearedBy: actorUserId, clearReason: reason.slice(0, 500) })
    .where(and(...where)).returning();
  if (!row) return null;
  await auditRepository.log({
    userId: actorUserId,
    action: 'settings_changed',
    resourceType: 'plugin_package',
    resourceId: row.name ?? row.keyId ?? row.id,
    details: { op: 'revocation_cleared', id: row.id, kind: row.kind, name: row.name, version: row.version, keyId: row.keyId, revokedFor: row.reason, reason: row.clearReason },
  });
  return row;
}
