import { createHash } from 'node:crypto';
import { pluginProtectionRepository } from '@/db/repositories/plugin-protection-repository';
import type { PluginManifest, PluginHostScope } from '@/shared/plugin-package';
import type { PluginProtectionApproval, PluginProtectionView } from '@/shared/plugin-protection';
import { defaultMaxProtection } from './permissions';
import { effectiveMaxProtection, grantedHostScopes } from './service';

type Package = Pick<
  typeof import('@/db/schema/plugin-packages').pluginPackages.$inferSelect,
  'name' | 'manifest' | 'contentHash' | 'approvedHostScopes'
>;
const bounded = new Set<PluginHostScope>(['repos:collect', 'connections:read']);
const unbounded = new Set<PluginHostScope>(['web:read', 'model:complete', 'agent:run', 'mail:send']);
/** A configurable ceiling applies only to the protected host view and chat. */
export function configurableProtectionMaximum(m: PluginManifest, scopes: readonly PluginHostScope[]): 1 | 2 | 3 | 4 {
  if (m.network?.length || scopes.some((s) => unbounded.has(s))) return 1;
  return scopes.some((s) => bounded.has(s)) ? 2 : 4;
}
export function approvedProtectionLevel(row: Package, approval: PluginProtectionApproval | null): 1 | 2 | 3 | 4 {
  const scopes = grantedHostScopes(row);
  if (!approval || approval.contentHash !== row.contentHash) return effectiveMaxProtection(row.manifest, scopes);
  return Math.min(approval.level, configurableProtectionMaximum(row.manifest, scopes)) as 1 | 2 | 3 | 4;
}
/** Re-resolve on every operation; a package upgrade invalidates the old approval. */
export async function packageProtectionLevel(row: Package): Promise<1 | 2 | 3 | 4> {
  return approvedProtectionLevel(row, await pluginProtectionRepository.get(row.name));
}
export async function protectionView(row: Package): Promise<PluginProtectionView> {
  const approval = await pluginProtectionRepository.get(row.name);
  const configurableMaximum = configurableProtectionMaximum(row.manifest, grantedHostScopes(row));
  return {
    contentHash: row.contentHash ?? '',
    declaredLevel: defaultMaxProtection(row.manifest),
    allowedLevel: approvedProtectionLevel(row, approval),
    configurableMaximum,
    approval,
    needsReview: !!approval && approval.contentHash !== row.contentHash,
    explanation:
      configurableMaximum === 1
        ? 'This package can send data beyond named connections. Its current capabilities support Public data only.'
        : configurableMaximum === 2
          ? 'Internal data can be approved for selected connections. Chat and the Octipus protected view are available; custom plugin pages stay Public-only.'
          : 'Data stays in the sandbox and approved host reads. Use chat or the Octipus protected view for protected data.',
  };
}
/** Pin trust to the actual destination, not just a connection name that can be edited. */
export function trustedProtectionConnection(
  approval: PluginProtectionApproval,
  profile: { id: string; http?: { origin: string; pathPrefix: string } | null },
): boolean {
  return approval.connections.some(
    (c) => c.id === profile.id && c.origin === profile.http?.origin && c.pathPrefix === profile.http?.pathPrefix,
  );
}

/** A policy revision invalidates tokens and process memory on every instance. */
export function protectionApprovalStamp(approval: PluginProtectionApproval | null): string | undefined {
  return approval
    ? createHash('sha256')
        .update(
          JSON.stringify([
            approval.contentHash,
            approval.level,
            approval.connections.map((c) => [c.id, c.origin, c.pathPrefix]).sort((a, b) => a[0].localeCompare(b[0])),
            approval.approvedBy,
            approval.approvedAt,
          ]),
        )
        .digest('hex')
    : undefined;
}
