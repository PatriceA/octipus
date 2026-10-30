import {headerTemplateReferences} from '@/shared/header-template';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AgentContext, MCPServer } from '@/core/types';
import { authenticatedFetch, principalCanUse, readConnectionProfiles, resolveConnectionCredential, type ConnectionPrincipal } from '@/security/credential-connections';
import { redactCredentialData } from '@/security/credential-redaction';
import type { MCPTransport } from './transports/interface';
import { SSETransport } from './transports/sse';
import { StreamableHTTPTransport } from './transports/streamable-http';
import { StdioTransport } from './transports/stdio';

const boundProfiles = new WeakMap<MCPServer, string>();
const boundSecrets = new WeakMap<MCPServer, string>();
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function assertCredentialConnectionAccess(server: MCPServer | undefined, context?: AgentContext): Promise<void> {
  if (!server?.credentialConnection) return;
  const profile = (await readConnectionProfiles()).find(p => p.id === server.credentialConnection);
  if (!profile || !context || !principalCanUse(profile, context)) throw new Error('MCP credential connection is unavailable for this user/workspace');
  if (boundProfiles.has(server) && boundProfiles.get(server) !== digest(JSON.stringify(profile))) throw new Error('MCP credential connection configuration changed; reconnect this server');
  // Revalidate vault tool/agent ACLs on every dispatch, even if a cached transport is already connected.
  const current = await resolveConnectionCredential(profile, { ...context, agentId: context.id }, 'mcp');
  if(server.transport==='sse'||server.transport==='streamable-http'){
    const auth=profile.http?.auth;
    const companions=auth?.type==='header-template'?headerTemplateReferences(auth.template):auth?.type==='basic'&&auth.usernameCredential?[auth.usernameCredential]:[];
    for(const name of new Set(companions))if(name!==profile.credential)await resolveConnectionCredential({...profile,credential:name},{...context,agentId:context.id},'mcp');
  }
  if (boundSecrets.has(server) && boundSecrets.get(server) !== digest(current)) throw new Error('MCP stdio credential rotated; reconnect this trusted server');
}

/** Plaintext exists only in the transport closure / explicitly trusted local server. */
export async function createCredentialTransport(server: MCPServer): Promise<MCPTransport> {
  const p = (await readConnectionProfiles()).find(p => p.id === server.credentialConnection);
  if (!p) throw new Error('MCP credential connection is not configured');
  const caller: ConnectionPrincipal = { userId: p.userId, workspaceId: p.workspaceId, agentId: `mcp:${server.id}` };
  const remote = server.transport === 'sse' || server.transport === 'streamable-http';
  const binding = p.stdio.find(b => b.serverId === server.id && b.command === server.command && JSON.stringify(b.args) === JSON.stringify(server.args ?? []));
  if (remote) {
    if (!p.http?.mcpServers.includes(server.id)) throw new Error('MCP server is not bound to this HTTP credential connection');
    for (const raw of [server.sseUrl, ...(server.transport === 'sse' ? [server.postUrl] : [])]) if (!raw || new URL(raw).origin !== p.http.origin) throw new Error('MCP endpoint does not match its credential connection origin');
  } else if (!binding || server.plugin || !isAbsolute(binding.command) || !isAbsolute(binding.cwd)
    || (server.cwd !== undefined && server.cwd !== binding.cwd) || JSON.stringify(server.env ?? {}) !== JSON.stringify(binding.env)) throw new Error('MCP executable/arguments/cwd/environment do not match the trusted credential binding');
  const initialSecret = await resolveConnectionCredential(p, caller, 'mcp', server.id);
  boundProfiles.set(server, digest(JSON.stringify(p)));
  if (!remote && initialSecret.includes('\0')) throw new Error('MCP environment credential contains unsupported control data');
  if (!remote) boundSecrets.set(server, digest(initialSecret));
  const masks = new Map<string, (value: unknown) => unknown>();
  masks.set('initial', value => redactCredentialData(value, [initialSecret]));
  const mask = (value: unknown): unknown => { for (const apply of masks.values()) value = apply(value); return value; };
  let inner: MCPTransport;
  if (server.transport === 'sse' || server.transport === 'streamable-http') {
    if (!p.http?.mcpServers.includes(server.id)) throw new Error('MCP server is not bound to this HTTP credential connection');
    for (const raw of [server.sseUrl, ...(server.transport === 'sse' ? [server.postUrl] : [])]) {
      if (!raw || new URL(raw).origin !== p.http.origin) throw new Error('MCP endpoint does not match its credential connection origin');
    }
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== p.http!.origin) throw new Error('MCP request left its configured origin');
      const timeout = AbortSignal.timeout(server.requestTimeoutMs ?? 30_000);
      const signal = server.transport === 'sse' && (init?.method ?? 'GET') === 'GET' ? init?.signal
        : init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const { response, mask: currentMask, credentialVersion } = await authenticatedFetch(p, caller, url.pathname + url.search, { ...init, signal }, 'mcp', server.id);
      masks.set(credentialVersion, currentMask);
      return response;
    };
    inner = server.transport === 'sse'
      ? new SSETransport({ sseUrl: server.sseUrl!, postUrl: server.postUrl!, headers: server.headers, request })
      : new StreamableHTTPTransport({ url: server.sseUrl!, headers: server.headers, request });
  } else {
    inner = new StdioTransport({ command: server.command, args: server.args, env: { ...binding!.env, [binding!.envName]: initialSecret }, cwd: binding!.cwd,
      isolatedEnv: true, stderrAsError: server.stderrAsError, sandbox: server.sandbox });
  }
  return {
    connect: () => inner.connect(), send: (message, signal) => inner.send(message, signal), close: () => inner.close(),
    onClose: handler => inner.onClose(handler),
    onError: handler => inner.onError(error => handler(new Error(String(mask(error.message))))),
    onMessage: handler => inner.onMessage(message => {
      try { handler(JSON.stringify(mask(JSON.parse(message)))); }
      catch { throw new Error('MCP credential response could not be safely decoded'); }
    }),
  };
}

export async function canUseCredentialConnection(server: MCPServer, context?: AgentContext): Promise<boolean> {
  try { await assertCredentialConnectionAccess(server, context); return true; } catch { return false; }
}
