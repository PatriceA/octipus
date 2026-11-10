/**
 * Online revocation (docs/PLUGIN-PACKAGES.md#online-revocation): the package
 * versions the marketplace's signed index revokes, and the signing keys its
 * root-signed keys.json revokes, kept in the database so they hold while the
 * marketplace is unreachable and across restarts.
 *
 * **Scope.** Both apply to marketplace trust only: packages installed from
 * the marketplace (`origin.source === 'marketplace'`), installs from it, and
 * its index. Never to `plugins.trustedPublishers`, a directory install, a URL
 * install or another registry: a marketplace key cannot stop what the admin
 * trusted by other means (`plugins.revokedKeys` is the admin's own lever for
 * that).
 *
 * **Signers.** Each revocation records the key that signed what it came from.
 * A package revocation whose signer is revoked since (by keys.json, or
 * `plugins.revokedKeys`) is flagged `signerRevoked` and no longer enforced,
 * unless an index signed by a key still trusted lists it again (it is then
 * re-asserted under that key). A leaked signing key therefore cannot leave
 * revocations behind that outlive it.
 *
 * They only accumulate otherwise. A later index that no longer lists one does
 * not lift it (a replayed older index, or a tampered mirror, must never
 * un-revoke). An admin can clear one (`clearRevocation`, audited), except the
 * revocation of a root key; the row stays as history, and an index that
 * still lists the revocation revokes it again.
 *
 * Which index may revoke what is decided before anything gets here
 * (./marketplace.ts, ./marketplace-keys-file.ts); this module stores and
 * answers.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { type PluginRevocationRow, pluginRevocations } from '@/db/schema/plugin-packages';
import { currentMarketplace } from './marketplace-config';

export interface RevocationInput {
  kind: 'package' | 'key';
  name?: string;
  version?: string;
  keyId?: string;
  reason: string;
}

export interface RevocationSource {
  registryUrl: string;
  /** The key id that signed the index (or, for a key revocation, the root that signed keys.json) it came from. */
  signedByKey: string;
  indexGeneratedAt: Date;
}

/** A revocation with whether it is enforced now. */
export interface RevocationState {
  row: PluginRevocationRow;
  /** Its signer is revoked now: a package revocation then no longer counts until a trusted key re-asserts it. */
  signerRevoked: boolean;
  /** In force: not cleared, and (a package revocation) its signer not revoked. */
  enforced: boolean;
}

/** Every revocation not cleared. */
async function uncleared(): Promise<PluginRevocationRow[]> {
  return getDb().select().from(pluginRevocations).where(isNull(pluginRevocations.clearedAt));
}

/** Key ids the marketplace's keys.json revoked (not cleared). Marketplace trust only. */
export async function revokedKeyIds(): Promise<string[]> {
  const rows = await getDb().select({ keyId: pluginRevocations.keyId }).from(pluginRevocations)
    .where(and(eq(pluginRevocations.kind, 'key'), isNull(pluginRevocations.clearedAt)));
  return rows.map((r) => r.keyId).filter((k): k is string => typeof k === 'string');
}

/** Signers whose revocations no longer count: keys revoked by keys.json, and `plugins.revokedKeys`. */
function revokedSigners(rows: readonly PluginRevocationRow[]): Set<string> {
  const out = new Set<string>(getConfig().plugins?.revokedKeys ?? []);
  for (const r of rows) if (r.kind === 'key' && r.keyId) out.add(r.keyId);
  return out;
}

function stateOf(row: PluginRevocationRow, signers: ReadonlySet<string>): RevocationState {
  // A key revocation (from keys.json, signed by a root) is never undone this way: it only takes trust away.
  const signerRevoked = row.kind === 'package' && signers.has(row.signedByKey);
  return { row, signerRevoked, enforced: row.clearedAt === null && !signerRevoked };
}

/** The revocations in force: not cleared, and not from a revoked signer. */
export async function activeRevocations(): Promise<PluginRevocationRow[]> {
  const rows = await uncleared();
  const signers = revokedSigners(rows);
  return rows.filter((r) => stateOf(r, signers).enforced);
}

/** The revocation in force of `name@version`, or null. It applies to marketplace packages only (the caller checks the origin). */
export async function packageRevocation(name: string, version: string): Promise<PluginRevocationRow | null> {
  const [row] = await getDb().select().from(pluginRevocations).where(and(
    eq(pluginRevocations.kind, 'package'), eq(pluginRevocations.name, name), eq(pluginRevocations.version, version), isNull(pluginRevocations.clearedAt),
  )).limit(1);
  if (!row) return null;
  const signers = revokedSigners(await getDb().select().from(pluginRevocations)
    .where(and(eq(pluginRevocations.kind, 'key'), isNull(pluginRevocations.clearedAt))));
  return stateOf(row, signers).enforced ? row : null;
}

/** The revocation in force of a key id, or null. */
export async function keyRevocation(keyId: string): Promise<PluginRevocationRow | null> {
  const [row] = await getDb().select().from(pluginRevocations).where(and(
    eq(pluginRevocations.kind, 'key'), eq(pluginRevocations.keyId, keyId), isNull(pluginRevocations.clearedAt),
  )).limit(1);
  return row ?? null;
}

/**
 * Store revocations (in one statement per kind). One already in force is
 * left as it is, unless its signer is revoked now: it is then re-asserted
 * under this source's key. Returns the rows that are new or re-asserted (for
 * the admins' notification and the effects).
 */
export async function recordRevocations(items: readonly RevocationInput[], source: RevocationSource): Promise<PluginRevocationRow[]> {
  const meta = { reason: '', registryUrl: source.registryUrl, signedByKey: source.signedByKey, indexGeneratedAt: source.indexGeneratedAt };
  const seen = new Set<string>();
  const packages: Array<typeof pluginRevocations.$inferInsert> = [];
  const keys: Array<typeof pluginRevocations.$inferInsert> = [];
  for (const item of items) {
    const id = item.kind === 'package' ? `p\n${item.name}\n${item.version}` : `k\n${item.keyId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (item.kind === 'package' && item.name && item.version) packages.push({ ...meta, kind: 'package', name: item.name, version: item.version, keyId: null, reason: item.reason.slice(0, 500) });
    if (item.kind === 'key' && item.keyId) keys.push({ ...meta, kind: 'key', name: null, version: null, keyId: item.keyId, reason: item.reason.slice(0, 500) });
  }
  const added: PluginRevocationRow[] = [];
  for (let i = 0; i < keys.length; i += 500) added.push(...await getDb().insert(pluginRevocations).values(keys.slice(i, i + 500)).onConflictDoNothing().returning());
  for (let i = 0; i < packages.length; i += 500) added.push(...await getDb().insert(pluginRevocations).values(packages.slice(i, i + 500)).onConflictDoNothing().returning());
  if (packages.length === 0) return added;
  // Re-assert what a revoked signer listed and this (trusted) source lists too.
  const signers = [...revokedSigners(await getDb().select().from(pluginRevocations)
    .where(and(eq(pluginRevocations.kind, 'key'), isNull(pluginRevocations.clearedAt))))].filter((k) => k !== source.signedByKey);
  if (signers.length === 0) return added;
  const fresh = new Set(added.map((r) => r.id));
  for (let i = 0; i < packages.length; i += 500) {
    const pairs = packages.slice(i, i + 500).map((p) => sql`(${p.name}, ${p.version})`);
    const reasserted = await getDb().update(pluginRevocations)
      .set({ signedByKey: source.signedByKey, registryUrl: source.registryUrl, indexGeneratedAt: source.indexGeneratedAt })
      .where(and(
        eq(pluginRevocations.kind, 'package'), isNull(pluginRevocations.clearedAt), inArray(pluginRevocations.signedByKey, signers),
        sql`(${pluginRevocations.name}, ${pluginRevocations.version}) IN (${sql.join(pairs, sql`, `)})`,
      ))
      .returning();
    added.push(...reasserted.filter((r) => !fresh.has(r.id)));
  }
  return added;
}

/** Every revocation, cleared ones too (newest first), with whether it is enforced, for the admin. */
export async function listRevocations(): Promise<RevocationState[]> {
  const rows = await getDb().select().from(pluginRevocations);
  const signers = revokedSigners(rows.filter((r) => r.clearedAt === null));
  return rows.sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime()).map((r) => stateOf(r, signers));
}

export class RevocationClearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevocationClearError';
  }
}

/**
 * Lift one revocation (an admin's decision, audited). The row stays, marked
 * cleared. Returns null when there is no such revocation in force. An index
 * that still lists it revokes it again on its next read. The revocation of a
 * root key is never cleared (`RevocationClearError`): a root is revoked
 * because it is lost or leaked, and only a new build replaces it.
 */
export async function clearRevocation(id: string, actorUserId: string, reason: string): Promise<PluginRevocationRow | null> {
  const [current] = await getDb().select().from(pluginRevocations).where(and(eq(pluginRevocations.id, id), isNull(pluginRevocations.clearedAt))).limit(1);
  if (!current) return null;
  if (current.kind === 'key' && current.keyId) {
    const settings = currentMarketplace();
    if (settings.state === 'ready' && settings.roots.some((r) => r.keyId === current.keyId)) {
      throw new RevocationClearError(`${current.keyId} is a root key of the marketplace; its revocation cannot be cleared`);
    }
  }
  const [row] = await getDb().update(pluginRevocations)
    .set({ clearedAt: new Date(), clearedBy: actorUserId, clearReason: reason.slice(0, 500) })
    .where(and(eq(pluginRevocations.id, id), isNull(pluginRevocations.clearedAt))).returning();
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
