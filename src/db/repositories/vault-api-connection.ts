import {isDeepStrictEqual} from 'node:util';
import { validateExternalUrl } from '@/utils/sanitize';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { vault } from '@/db/schema/vault';
import { apiConnectionSchema, type ApiConnectionConfig } from '@/shared/api-connection';
import { assertNoCredentialTemplates } from '@/security/credential-boundary';
import { readConnectionProfiles } from '@/security/credential-connections';
import { auditRepository } from './audit-repository';

export class VaultConnectionError extends Error {
  constructor(readonly code: 'not_found' | 'duplicate_name' | 'public_destination_required' | 'login_domain_required') { super(code === 'not_found' ? 'Secret not found in this workspace' : code === 'duplicate_name' ? 'Connection name is already in use; choose another name' : code==='login_domain_required'?'Use the login’s saved domain and Login authentication':'This origin is not a verified public destination. Check the server address; an administrator must configure access to internal servers.'); }
}
/** Owner-only HTTP grants. Neither request bodies nor responses contain a credential value. */
export async function saveVaultApiConnection(userId: string, credentialId: string, workspaceId: string | null, input: ApiConnectionConfig | null, options: { allowPrivateOrigins?: boolean } = {}): Promise<ApiConnectionConfig | null> {
  assertNoCredentialTemplates(input);
  const config = input === null ? null : apiConnectionSchema.parse(input);
  const operatorProfiles = await readConnectionProfiles();
  if (config && operatorProfiles.some(p => p.userId === userId && p.id === config.id)) throw new VaultConnectionError('duplicate_name');
  let networkPolicy:'operator'|'public'='public';
  await getDb().transaction(async tx => {
    // Serialize changes to this secret and concurrent grants of the same connection name.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vault-api-secret:${userId}:${credentialId}`}))`);
    if (config) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vault-api-name:${userId}:${config.id}`}))`);
    const ownedCredential = and(eq(vault.id, credentialId), eq(vault.userId, userId), eq(vault.isActive, true),
      or(eq(vault.scope, 'user'), workspaceId ? and(eq(vault.scope, 'workspace'), eq(vault.workspaceId, workspaceId)) : undefined));
    const [entry] = await tx.select({ id: vault.id,credentialType:vault.credentialType,metadata:vault.metadata }).from(vault).where(ownedCredential).limit(1);
    if (!entry) throw new VaultConnectionError('not_found');
    if(config&&((entry.credentialType==='login'&&(!['login','login-token'].includes(config.auth.type)||config.origin!==entry.metadata?.login?.origin))||(entry.credentialType!=='login'&&['login','login-token'].includes(config.auth.type))))throw new VaultConnectionError('login_domain_required');
    if(config){
      const previous=apiConnectionSchema.safeParse(entry.metadata?.apiConnection);
      const withoutTls=(value:ApiConnectionConfig)=>{const {tls,...rest}=value;return rest;};
      // An owner may change certificate trust on a previously approved internal
      // connection, but this cannot grant a new host, path, method or auth flow.
      const retained=entry.metadata?.apiConnectionNetwork==='operator'&&previous.success
        &&isDeepStrictEqual(withoutTls(previous.data),withoutTls(config));
      networkPolicy=options.allowPrivateOrigins||retained?'operator':'public';
      if(networkPolicy==='public'&&!(await validateExternalUrl(config.origin)).valid)throw new VaultConnectionError('public_destination_required');
    }
    if (config) {
      const [other] = await tx.select({ id: vault.id }).from(vault).where(and(eq(vault.userId, userId), eq(vault.isActive, true), or(eq(vault.scope, 'user'), eq(vault.scope, 'workspace')), ne(vault.id, credentialId),
        sql`${vault.metadata}->'apiConnection'->>'id' = ${config.id}`)).limit(1);
      if (other) throw new VaultConnectionError('duplicate_name');
    }
    const changed = await tx.update(vault).set({ metadata: config
      ? sql`jsonb_set(jsonb_set(coalesce(${vault.metadata}, '{}'::jsonb), '{apiConnection}', ${JSON.stringify(config)}::jsonb), '{apiConnectionNetwork}', ${JSON.stringify(networkPolicy)}::jsonb)`
      : sql`coalesce(${vault.metadata}, '{}'::jsonb) - 'apiConnection' - 'apiConnectionNetwork'`, updatedAt: new Date() }).where(ownedCredential).returning({ id: vault.id });
    if (!changed.length) throw new VaultConnectionError('not_found');
  });
  await auditRepository.log({ userId, action: 'credential_updated', resourceType: 'credential', resourceId: credentialId,
    details: config ? { connection: config.id, origin: config.origin, methods: config.methods, authentication:config.auth.type,...(config.auth.type==='login-token'?{authenticationPostEndpoints:[config.auth.loginPath,...(config.auth.refreshPath?[config.auth.refreshPath]:[])]}:{}),tls:config.tls??{mode:'system'}, networkPolicy } : { removed: true } });
  return config;
}
