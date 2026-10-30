import { fetchGuarded } from '@/utils/sanitize';
import { connectionAuthSchema, apiConnectionSchema, publicConnectionHeadersSchema, connectionTlsSchema } from '@/shared/api-connection';
import { CertificatePinMismatchError, certificateVerificationCode, fetchWithCertificatePin } from './connection-tls';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { getVault } from './vault';
import { redactCredentialData } from './credential-redaction';
import { assertNoCredentialTemplates } from './credential-boundary';

export const connectionProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  userId: z.string().min(1), workspaceId: z.string().nullable(),
  credential: z.string().min(1),
  http: z.object({
    origin: z.string().url(), auth: connectionAuthSchema,
    headers: publicConnectionHeadersSchema.optional(),
    tls: connectionTlsSchema.optional(),
    allowInsecureHttp: z.boolean().default(false),
    networkPolicy: z.enum(['operator', 'public']).default('operator'),
    pathPrefix: z.string().startsWith('/').default('/'),
    methods: z.array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1),
    git: z.boolean().default(false),
    repositoryRoots: z.array(z.string()).default([]),
    mcpServers: z.array(z.string()).default([]),
  }).strict().superRefine((http,ctx)=>{
    if(http.tls?.mode==='pinned'&&(new URL(http.origin).protocol!=='https:'||http.networkPolicy!=='operator'))ctx.addIssue({code:'custom',message:'Certificate trust requires an operator-approved HTTPS connection'});
  }).optional(),
  // A local server is an explicitly trusted executable, not an arbitrary shell.
  stdio: z.array(z.object({ serverId: z.string(), command: z.string(), args: z.array(z.string()), envName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), cwd: z.string(), env: z.record(z.string(), z.string()).default({}) }).strict()).default([]),
}).strict();
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
export interface ConnectionPrincipal { userId: string; workspaceId?: string | null; agentId?: string; space?: unknown }

/** Operator-owned configuration, never read from the agent-writable workspace. No secret values. */
export async function readConnectionProfiles(): Promise<ConnectionProfile[]> {
  const path = process.env.OCTIPUS_CONNECTIONS_FILE || join(homedir(), '.octipus', 'credential-connections.json');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Untrusted connection configuration');
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    assertNoCredentialTemplates(data);
    const parsed = z.array(connectionProfileSchema).parse(data);
    if (new Set(parsed.map(p => p.id)).size !== parsed.length) throw new Error('Duplicate connection id');
    for (const p of parsed) if (p.http) {
      const u = new URL(p.http.origin);
      if (u.origin !== p.http.origin || u.username || u.password || !['https:', 'http:'].includes(u.protocol)
        || (u.protocol === 'http:' && !p.http.allowInsecureHttp)) throw new Error('Invalid connection origin');
      if (p.http.auth.type === 'header' && /^(?:host|cookie|content-length|transfer-encoding|connection|proxy-authorization)$/i.test(p.http.auth.name)) throw new Error('Invalid credential header');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Configuration is diagnostic metadata too: never echo invalid field values.
    throw new Error('Credential connection configuration is invalid or not operator-owned');
  }
}
export function principalCanUse(p: ConnectionProfile, caller: ConnectionPrincipal): boolean {
  return !caller.space && p.userId === caller.userId && (p.workspaceId === null || p.workspaceId === caller.workspaceId);
}
/** Personal HTTP grants saved by the credential owner through the vault UI. */
export async function readAvailableConnectionProfiles(caller: ConnectionPrincipal): Promise<ConnectionProfile[]> {
  if (caller.space) return [];
  const profiles = (await readConnectionProfiles()).filter(p => principalCanUse(p, caller));
  for (const row of await getVault().list(caller.userId, { workspaceId: caller.workspaceId })) {
    const parsed = apiConnectionSchema.safeParse(row.metadata?.apiConnection);
    if (!parsed.success) continue;
    const c = parsed.data;
    profiles.push(connectionProfileSchema.parse({ id: c.id, userId: caller.userId,
      workspaceId: row.scope === 'workspace' ? row.workspaceId : null, credential: row.name, http: { origin:c.origin, pathPrefix:c.pathPrefix, auth:c.auth, ...(c.headers ? {headers:c.headers} : {}), ...(c.tls?{tls:c.tls}:{}), methods:c.methods, allowInsecureHttp:c.allowInsecureHttp, networkPolicy:row.metadata?.apiConnectionNetwork === 'operator' ? 'operator' : 'public' } }));
  }
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('Connection name is configured more than once; choose a unique name in Secrets');
  return profiles;
}
export async function connectionFor(id: string, caller: ConnectionPrincipal): Promise<ConnectionProfile> {
  const p = (await readAvailableConnectionProfiles(caller)).find(p => p.id === id);
  if (!p) throw new Error('Connection unavailable for this user/workspace. Open Secrets → Connect API for this token to approve a server, authentication, path and allowed requests; an administrator must configure internal servers.');
  return p;
}
export async function resolveConnectionCredential(p: ConnectionProfile, caller: ConnectionPrincipal, toolId = 'connections', trustedMcpServerId?: string): Promise<string> {
  if (!principalCanUse(p, caller)) throw new Error('Connection access denied');
  const trustedMcpTransport = toolId === 'mcp' && !!trustedMcpServerId && (p.http?.mcpServers.includes(trustedMcpServerId) || p.stdio.some(b => b.serverId === trustedMcpServerId));
  const value = await getVault().getByNameAuthorized({ userId: caller.userId, workspaceId: p.workspaceId, toolId, agentId: caller.agentId }, p.credential, { trustedMcpTransport });
  if (!value) throw new Error('Connection credential unavailable, expired or denied by vault policy');
  return value;
}
export function connectionUrl(p: ConnectionProfile, path: string): URL {
  if (!p.http) throw new Error('Connection does not support HTTP');
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n\0]/.test(path)) throw new Error('Use an origin-relative request path');
  const url = new URL(path, p.http.origin);
  const prefix = p.http.pathPrefix.replace(/\/$/, '');
  let decoded: string;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new Error('Invalid request path'); }
  if (url.origin !== p.http.origin || url.username || url.password || url.hash || /[\\\0]/.test(decoded)
    || decoded.split('/').some(part => part === '..' || part === '.') || /%(?:2e|2f|5c|25)/i.test(decoded)
    || (prefix && decoded !== prefix && !decoded.startsWith(`${prefix}/`))) throw new Error('Request is outside the configured connection path');
  return url;
}
export function connectionAuth(p: ConnectionProfile, secret: string, resolvedUsername?: string): { name: string; value: string } {
  if (!p.http) throw new Error('Connection does not support HTTP');
  const a = p.http.auth;
  if(a.type==='login')throw new Error('Saved logins must be resolved by their domain-bound consumer');
  const auth = a.type === 'basic-token' ? { name: 'Authorization', value: `Basic ${Buffer.from(`${secret}:`).toString('base64')}` } : a.type === 'basic' ? { name: 'Authorization', value: `Basic ${Buffer.from(`${a.username ?? resolvedUsername}:${secret}`).toString('base64')}` }
    : a.type === 'bearer' ? { name: 'Authorization', value: `Bearer ${secret}` } : { name: a.name, value: a.prefix + secret };
  if (/[\x00-\x1f\x7f-\uffff]/.test(auth.value)) throw new Error('Invalid connection authentication');
  return auth;
}
/** Fetch is bound to an operator-approved origin. Private/LAN origins are intentional. No redirects. */
export async function authenticatedFetch(p: ConnectionProfile, caller: ConnectionPrincipal, path: string, init: RequestInit = {}, toolId = 'connections', trustedMcpServerId?: string): Promise<{ response: Response; mask: (value: unknown) => unknown; credentialVersion: string }> {
  if (!principalCanUse(p, caller)) throw new Error('Connection access denied');
  const url = connectionUrl(p, path);
  const method = (init.method ?? 'GET').toUpperCase();
  if (!p.http!.methods.includes(method as never)) throw new Error('HTTP method is not allowed by this connection');
  if(p.http!.tls?.mode==='pinned'&&(url.protocol!=='https:'||p.http!.networkPolicy!=='operator'))throw new Error('Certificate trust requires an operator-approved HTTPS connection');
  const login=p.http!.auth.type==='login'?await getVault().getLoginAuthorized({...caller,workspaceId:p.workspaceId,toolId},p.credential,url.origin):null;
  if(p.http!.auth.type==='login'&&!login)throw new Error('Login unavailable, expired, denied, or bound to a different domain');
  const secret = login?.password??await resolveConnectionCredential(p, caller, toolId, trustedMcpServerId);
  const username = login?.username??(p.http!.auth.type === 'basic' && p.http!.auth.usernameCredential
    ? await resolveConnectionCredential({ ...p, credential: p.http!.auth.usernameCredential }, caller, toolId, trustedMcpServerId) : undefined);
  if(login?.username.includes(':'))throw new Error('This username cannot be used for HTTP Basic authentication');
  const auth = login?{name:'Authorization',value:`Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`}:connectionAuth(p, secret, username);
  const headers = new Headers(init.headers);
  if (['host', 'authorization', 'cookie', 'proxy-authorization', 'content-length', 'transfer-encoding', 'connection', 'upgrade', auth.name].some(n => headers.has(n))) throw new Error('Authentication and routing headers are controlled by the connection');
  for (const [name, value] of Object.entries(p.http!.headers ?? {})) {
    if (name.toLowerCase() === auth.name.toLowerCase() || (headers.has(name) && headers.get(name) !== value.trim())) throw new Error('Configured public headers cannot be overridden');
    headers.set(name, value);
  }
  try {
    headers.set(auth.name, auth.value);
    const request = { ...init, method, headers, redirect: 'manual' as const };
    const response = p.http!.tls?.mode==='pinned' ? await fetchWithCertificatePin(url,request,p.http!.tls.certificateSha256)
      : p.http!.networkPolicy === 'public' ? await fetchGuarded(url.toString(), request) : await fetch(url, request);
    return { response, credentialVersion: createHash('sha256').update(JSON.stringify([secret, username])).digest('hex'), mask: value => redactCredentialData(value, [secret, ...(username ? [username] : []), auth.value, auth.value.replace(/^Basic /, '')]) };
  } catch(error) {
    if(error instanceof CertificatePinMismatchError)throw new Error(error.message);
    const code=certificateVerificationCode(error);
    if(code)throw new Error(`TLS certificate verification failed (${code}). Inspect and approve this server's certificate in Secrets → Connect API, or install a valid certificate. Credentials withheld.`);
    throw new Error('Authenticated connection request failed (network, TLS, cancellation or timeout); credentials withheld');
  }
}
export async function readBoundedResponse(response: Response, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Connection response exceeded the supported size');
      parts.push(value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
