import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { getVault } from './vault';
import { redactCredentialData } from './credential-redaction';
import { assertNoCredentialTemplates } from './credential-boundary';

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bearer') }).strict(),
  z.object({ type: z.literal('basic'), username: z.string().min(1).optional(), usernameCredential: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict().refine(a => Number(!!a.username) + Number(!!a.usernameCredential) === 1),
  z.object({ type: z.literal('header'), name: z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), prefix: z.string().default('') }).strict(),
]);
export const connectionProfileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  userId: z.string().min(1), workspaceId: z.string().nullable(),
  credential: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  http: z.object({
    origin: z.string().url(), auth: authSchema,
    allowInsecureHttp: z.boolean().default(false),
    pathPrefix: z.string().startsWith('/').default('/'),
    methods: z.array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])).min(1),
    git: z.boolean().default(false),
    repositoryRoots: z.array(z.string()).default([]),
    mcpServers: z.array(z.string()).default([]),
  }).strict().optional(),
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
export async function connectionFor(id: string, caller: ConnectionPrincipal): Promise<ConnectionProfile> {
  const p = (await readConnectionProfiles()).find(p => p.id === id && principalCanUse(p, caller));
  if (!p) throw new Error('Connection unavailable for this user/workspace. Ask the operator to configure a named credential connection.');
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
  const auth = a.type === 'basic' ? { name: 'Authorization', value: `Basic ${Buffer.from(`${a.username ?? resolvedUsername}:${secret}`).toString('base64')}` }
    : a.type === 'bearer' ? { name: 'Authorization', value: `Bearer ${secret}` } : { name: a.name, value: a.prefix + secret };
  if (/[\x00-\x1f\x7f-\uffff]/.test(auth.value)) throw new Error('Invalid connection authentication');
  return auth;
}
/** Fetch is bound to an operator-approved origin. Private/LAN origins are intentional. No redirects. */
export async function authenticatedFetch(p: ConnectionProfile, caller: ConnectionPrincipal, path: string, init: RequestInit = {}, toolId = 'connections', trustedMcpServerId?: string): Promise<{ response: Response; mask: (value: unknown) => unknown; credentialVersion: string }> {
  const url = connectionUrl(p, path);
  const method = (init.method ?? 'GET').toUpperCase();
  if (!p.http!.methods.includes(method as never)) throw new Error('HTTP method is not allowed by this connection');
  const secret = await resolveConnectionCredential(p, caller, toolId, trustedMcpServerId);
  const username = p.http!.auth.type === 'basic' && p.http!.auth.usernameCredential
    ? await resolveConnectionCredential({ ...p, credential: p.http!.auth.usernameCredential }, caller, toolId, trustedMcpServerId) : undefined;
  const auth = connectionAuth(p, secret, username);
  const headers = new Headers(init.headers);
  if (['host', 'authorization', 'cookie', 'proxy-authorization', 'content-length', 'transfer-encoding', 'connection', 'upgrade', auth.name].some(n => headers.has(n))) throw new Error('Authentication and routing headers are controlled by the connection');
  try {
    headers.set(auth.name, auth.value);
    const response = await fetch(url, { ...init, method, headers, redirect: 'manual' });
    return { response, credentialVersion: createHash('sha256').update(JSON.stringify([secret, username])).digest('hex'), mask: value => redactCredentialData(value, [secret, ...(username ? [username] : []), auth.value, auth.value.replace(/^Basic /, '')]) };
  } catch { throw new Error('Authenticated connection request failed (network, TLS, cancellation or timeout); credentials withheld'); }
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
