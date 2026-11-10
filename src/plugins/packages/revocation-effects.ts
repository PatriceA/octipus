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
import { type PluginRevocationRow, pluginPackages } from '@/db/schema/plugin-packages';
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

/** Stop and report what new revocations cover. */
export async function applyNewRevocations(added: readonly PluginRevocationRow[]): Promise<void> {
  if (added.length === 0) return;
  const { clearRegistryCache } = await import('./remote');
  clearRegistryCache();
  const rows = await getDb().select().from(pluginPackages);
  const { readSignatureFile } = await import('./signature');
  const { packageDir } = await import('./service');
  const keyOf = new Map<string, string | null>();
  for (const row of rows) keyOf.set(row.name, (await readSignatureFile(packageDir(row.name)).catch(() => null))?.file.keyId ?? null);
  const stopped = new Set<string>();
  for (const r of added) {
    const affected = rows.filter((row) => (r.kind === 'package' ? row.name === r.name && row.version === r.version : keyOf.get(row.name) === r.keyId));
    for (const row of affected) {
      stopped.add(row.name);
      await auditRepository.log({
        userId: SYSTEM_USER_ID, action: 'settings_changed', resourceType: 'plugin_package', resourceId: row.name,
        details: { op: 'revoked_online', version: row.version, kind: r.kind, keyId: r.keyId, reason: r.reason, enabled: row.enabled },
      }).catch((err: unknown) => coreLogger.error({ err, pkg: row.name }, 'plugin marketplace: revocation audit row could not be written'));
    }
    const what = r.kind === 'package' ? `${r.name} ${r.version}` : `the signing key ${r.keyId}`;
    const names = affected.map((row) => `${row.name} ${row.version}`);
    await notifyAdmins('plugin_revoked', `Plugin revoked: ${what}`,
      `The Octipus marketplace revoked ${what}${r.reason ? `: ${r.reason}` : ''}. ${names.length > 0 ? `Installed here: ${names.join(', ')}. It does not start any more.` : 'Nothing installed here is affected.'}`,
      { kind: r.kind, name: r.name, version: r.version, keyId: r.keyId, affected: names });
  }
  if (stopped.size === 0) return;
  const { getMCPBridge, PLUGIN_SERVER_PREFIX } = await import('@/mcp/bridge');
  const { revokePluginTokens } = await import('./host-api');
  for (const name of stopped) {
    revokePluginTokens(name);
    await getMCPBridge().disconnect(`${PLUGIN_SERVER_PREFIX}${name}`).catch((err: unknown) => coreLogger.error({ err, pkg: name }, 'plugin marketplace: could not stop a revoked package'));
  }
  const { syncPluginServers } = await import('./service');
  await syncPluginServers().catch((err: unknown) => coreLogger.error({ err }, 'plugin marketplace: could not resync after a revocation'));
}
