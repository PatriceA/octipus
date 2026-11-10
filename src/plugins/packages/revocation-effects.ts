/**
 * What happens on this host when a revocation first reaches it
 * (docs/PLUGIN-PACKAGES.md#online-revocation): the packages it covers are
 * stopped (their server disconnected, their tokens and runs revoked; the
 * start guard refuses their next start), each is audited, and the admins are
 * told. Also the admins' notification path the marketplace uses.
 */
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import { type PluginPackageRow, type PluginRevocationRow, pluginPackages } from '@/db/schema/plugin-packages';
import { SYSTEM_USER_ID } from '@/security/principal';
import { coreLogger } from '@/utils/logger';

/** Notify every active admin (the existing notification path), never failing the caller. */
export async function notifyAdmins(type: string, title: string, body: string, metadata: Record<string, unknown> = {}): Promise<void> {
  let admins: Array<{ id: string }>;
  try {
    admins = await userRepository.listAdmins();
  } catch (err) {
    coreLogger.error({ err, type }, 'plugin marketplace: could not list the admins to notify');
    return;
  }
  const { getNotificationService } = await import('@/core/notification-service');
  for (const admin of admins) {
    await getNotificationService().notify(admin.id, type, title.slice(0, 200), body.slice(0, 2000), metadata, { workspaceId: null })
      .catch((err: unknown) => coreLogger.warn({ err, type }, 'plugin marketplace: could not notify an admin'));
  }
}

/** Most revocations named in one notification; the rest are counted. */
const NOTIFY_LIST_MAX = 10;

/**
 * The installed packages `revocations` cover: marketplace packages only
 * (`origin.source === 'marketplace'`), by version (a package revocation) or
 * by the key that signed them (a key revocation).
 */
async function affectedBy(revocations: readonly PluginRevocationRow[]): Promise<Array<{ revocation: PluginRevocationRow; rows: PluginPackageRow[] }>> {
  const rows = (await getDb().select().from(pluginPackages)).filter((row) => row.origin?.source === 'marketplace');
  if (rows.length === 0) return revocations.map((revocation) => ({ revocation, rows: [] }));
  const { readSignatureFile } = await import('./signature');
  const { packageDir } = await import('./service');
  const keyOf = new Map<string, string | null>();
  if (revocations.some((r) => r.kind === 'key')) {
    for (const row of rows) keyOf.set(row.name, (await readSignatureFile(packageDir(row.name)).catch(() => null))?.file.keyId ?? null);
  }
  return revocations.map((r) => ({
    revocation: r,
    rows: rows.filter((row) => (r.kind === 'package' ? row.name === r.name && row.version === r.version : keyOf.get(row.name) === r.keyId)),
  }));
}

/**
 * Revocations whose effects ran in this process (by id). Every instance runs
 * them: the one that stored a revocation at once (`applyNewRevocations`),
 * the others on their next index read or cron tick (`catchUpRevocations`),
 * so each instance stops its own servers, tokens and runs.
 */
const appliedHere = new Set<string>();

/** Stop, in this process, what the named packages run: their tokens and background runs, their servers, loaded in-process modules. */
async function stopHere(names: ReadonlySet<string>): Promise<void> {
  if (names.size === 0) return;
  const { getMCPBridge, PLUGIN_SERVER_PREFIX } = await import('@/mcp/bridge');
  const { revokePluginTokens } = await import('./host-api');
  for (const name of names) {
    revokePluginTokens(name);
    await getMCPBridge().disconnect(`${PLUGIN_SERVER_PREFIX}${name}`).catch((err: unknown) => coreLogger.error({ err, pkg: name }, 'plugin marketplace: could not stop a revoked package'));
  }
  // The start guard refuses them from now on; an in-process module is re-checked and unloaded on this sync.
  const { syncPluginServers } = await import('./service');
  await syncPluginServers().catch((err: unknown) => coreLogger.error({ err }, 'plugin marketplace: could not resync after a revocation'));
}

/**
 * Stop and report what new (or re-asserted) revocations cover: each affected
 * package is audited, the admins get ONE notification for the lot (a count,
 * the first few named), and this process stops what they cover.
 */
export async function applyNewRevocations(added: readonly PluginRevocationRow[]): Promise<void> {
  if (added.length === 0) return;
  const { clearRegistryCache } = await import('./remote');
  clearRegistryCache();
  for (const r of added) appliedHere.add(r.id);
  const affected = await affectedBy(added);
  const stopped = new Set<string>();
  for (const { revocation: r, rows } of affected) {
    for (const row of rows) {
      stopped.add(row.name);
      await auditRepository.log({
        userId: SYSTEM_USER_ID, action: 'settings_changed', resourceType: 'plugin_package', resourceId: row.name,
        details: { op: 'revoked_online', version: row.version, kind: r.kind, keyId: r.keyId, reason: r.reason, enabled: row.enabled, signedByKey: r.signedByKey },
      }).catch((err: unknown) => coreLogger.error({ err, pkg: row.name }, 'plugin marketplace: revocation audit row could not be written'));
    }
  }
  const what = (r: PluginRevocationRow) => (r.kind === 'package' ? `${r.name} ${r.version}` : `the signing key ${r.keyId}`);
  const names = [...new Set(affected.flatMap((a) => a.rows.map((row) => `${row.name} ${row.version}`)))];
  const listed = added.slice(0, NOTIFY_LIST_MAX).map((r) => `${what(r)}${r.reason ? ` (${r.reason})` : ''}`);
  const more = added.length > NOTIFY_LIST_MAX ? `, and ${added.length - NOTIFY_LIST_MAX} more` : '';
  const title = added.length === 1 ? `Plugin revoked: ${what(added[0])}` : `Plugin marketplace: ${added.length} revocations`;
  await notifyAdmins('plugin_revoked', title,
    `The Octipus marketplace revoked ${listed.join('; ')}${more}. ${names.length > 0 ? `Installed here: ${names.join(', ')}. They do not start any more.` : 'Nothing installed here is affected.'}`,
    {
      count: added.length, affected: names,
      revocations: added.slice(0, NOTIFY_LIST_MAX).map((r) => ({ kind: r.kind, name: r.name, version: r.version, keyId: r.keyId })),
      ...(added.length === 1 ? { kind: added[0].kind, name: added[0].name, version: added[0].version, keyId: added[0].keyId } : {}),
    });
  await stopHere(stopped);
}

/**
 * Apply, in this process, the revocations in force whose effects have not
 * run here yet (another instance stored them, or this process just started).
 * No audit row and no notification: the instance that stored them did that.
 * Called on every marketplace index read and from the cron tick. Returns how
 * many were caught up.
 */
export async function catchUpRevocations(): Promise<number> {
  const { activeRevocations } = await import('./revocations');
  const enforced = await activeRevocations();
  const ids = new Set(enforced.map((r) => r.id));
  // One no longer enforced (cleared, or its signer revoked) runs again if it comes back.
  for (const id of [...appliedHere]) if (!ids.has(id)) appliedHere.delete(id);
  const pending = enforced.filter((r) => !appliedHere.has(r.id));
  if (pending.length === 0) return 0;
  for (const r of pending) appliedHere.add(r.id);
  const stopped = new Set((await affectedBy(pending)).flatMap((a) => a.rows.map((row) => row.name)));
  if (stopped.size > 0) {
    const { clearRegistryCache } = await import('./remote');
    clearRegistryCache();
    coreLogger.info({ count: pending.length, stopped: [...stopped] }, 'plugin marketplace: revocations stored by another instance applied here');
  }
  await stopHere(stopped);
  return pending.length;
}

/** Test-only: forget which revocations ran here (a fresh process). */
export function _resetAppliedRevocations(): void {
  appliedHere.clear();
}
