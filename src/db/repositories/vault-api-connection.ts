import { validateExternalUrl } from '@/utils/sanitize';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { vault } from '@/db/schema/vault';
import { apiConnectionSchema, type ApiConnectionConfig } from '@/shared/api-connection';
import { assertNoCredentialTemplates } from '@/security/credential-boundary';
import { readConnectionProfiles } from '@/security/credential-connections';
import { auditRepository } from './audit-repository';

export class VaultConnectionError extends Error {
  constructor(readonly code: 'not_found' | 'duplicate_name' | 'public_destination_required') { super(code === 'not_found' ? 'Secret not found in this workspace' : code === 'duplicate_name' ? 'Connection name is already in use; choose another name' : 'This origin is not a verified public destination. Check the server address; an administrator must configure access to internal servers.'); }
}
/** Owner-only HTTP grants. Neither request bodies nor responses contain a credential value. */
export async function saveVaultApiConnection(userId: string, credentialId: string, workspaceId: string | null, input: ApiConnectionConfig | null, options: { allowPrivateOrigins?: boolean } = {}): Promise<ApiConnectionConfig | null> {
  assertNoCredentialTemplates(input);
  const config = input === null ? null : apiConnectionSchema.parse(input);
  const operatorProfiles = await readConnectionProfiles();
  if (config && operatorProfiles.some(p => p.userId === userId && p.id === config.id)) throw new VaultConnectionError('duplicate_name');
  await getDb().transaction(async tx => {
    // Serialize changes to this secret and concurrent grants of the same connection name.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vault-api-secret:${userId}:${credentialId}`}))`);
    if (config) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vault-api-name:${userId}:${config.id}`}))`);
    const ownedCredential = and(eq(vault.id, credentialId), eq(vault.userId, userId), eq(vault.isActive, true),
      or(eq(vault.scope, 'user'), workspaceId ? and(eq(vault.scope, 'workspace'), eq(vault.workspaceId, workspaceId)) : undefined));
    const [entry] = await tx.select({ id: vault.id }).from(vault).where(ownedCredential).limit(1);
    if (!entry) throw new VaultConnectionError('not_found');
    if (config && !options.allowPrivateOrigins && !(await validateExternalUrl(config.origin)).valid) throw new VaultConnectionError('public_destination_required');
    if (config) {
      const [other] = await tx.select({ id: vault.id }).from(vault).where(and(eq(vault.userId, userId), eq(vault.isActive, true), or(eq(vault.scope, 'user'), eq(vault.scope, 'workspace')), ne(vault.id, credentialId),
        sql`${vault.metadata}->'apiConnection'->>'id' = ${config.id}`)).limit(1);
      if (other) throw new VaultConnectionError('duplicate_name');
    }
    const changed = await tx.update(vault).set({ metadata: config
      ? sql`jsonb_set(jsonb_set(coalesce(${vault.metadata}, '{}'::jsonb), '{apiConnection}', ${JSON.stringify(config)}::jsonb), '{apiConnectionNetwork}', ${JSON.stringify(options.allowPrivateOrigins ? 'operator' : 'public')}::jsonb)`
      : sql`coalesce(${vault.metadata}, '{}'::jsonb) - 'apiConnection' - 'apiConnectionNetwork'`, updatedAt: new Date() }).where(ownedCredential).returning({ id: vault.id });
    if (!changed.length) throw new VaultConnectionError('not_found');
  });
  await auditRepository.log({ userId, action: 'credential_updated', resourceType: 'credential', resourceId: credentialId,
    details: config ? { connection: config.id, origin: config.origin, methods: config.methods, networkPolicy: options.allowPrivateOrigins ? 'operator' : 'public' } : { removed: true } });
  return config;
}
