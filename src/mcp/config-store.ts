import { createHash } from 'node:crypto';
import type { MCPServerConfigView, MCPServerEdit } from '@/shared/mcp-config';
import { isDeepStrictEqual } from 'node:util';
import type { MCPServer } from '@/core/types';

export class MCPConfigConflict extends Error {}

/** Apply only locally changed fields; preserve external edits and refuse conflicts. */
export function mergeServerConfigs(before: MCPServer[], next: MCPServer[], current: MCPServer[]): MCPServer[] {
  // JSON storage drops optional undefined fields; compare the persisted shape.
  const normalize = (server: MCPServer): MCPServer => structuredClone(Object.fromEntries(
    Object.entries(server).filter(([, value]) => value !== undefined),
  )) as unknown as MCPServer;
  const result = new Map(current.map(server => [server.id, normalize(server)]));
  const previous = new Map(before.map(server => [server.id, normalize(server)]));
  const desired = new Map(next.map(server => [server.id, normalize(server)]));
  const conflict = (id: string) => new MCPConfigConflict(`MCP server '${id}' changed in storage. Reload the server configuration and try again.`);
  for (const old of previous.values()) {
    if (!desired.has(old.id)) {
      const stored = result.get(old.id);
      if (stored && !isDeepStrictEqual(stored, old)) throw conflict(old.id);
      result.delete(old.id);
    }
  }
  for (const server of desired.values()) {
    const old = previous.get(server.id);
    const stored = result.get(server.id);
    if (!old) {
      if (stored && !isDeepStrictEqual(stored, server)) throw conflict(server.id);
      result.set(server.id, structuredClone(server));
      continue;
    }
    const fields = new Set([...Object.keys(old), ...Object.keys(server)]) as Set<keyof MCPServer>;
    for (const key of fields) {
      if (isDeepStrictEqual(old[key], server[key])) continue;
      if (!stored || (!isDeepStrictEqual(stored[key], old[key]) && !isDeepStrictEqual(stored[key], server[key]))) throw conflict(server.id);
      // Assign through a record so a key retains its corresponding value type.
      if (server[key] === undefined) delete stored[key];
      else (stored as unknown as Record<string, unknown>)[key] = structuredClone(server[key]);
    }
  }
  return [...result.values()];
}

export function configRevision(server: MCPServer): string {
  return createHash('sha256').update(JSON.stringify(server)).digest('hex');
}

export function configView(server: MCPServer): MCPServerConfigView {
  const { env, headers, ...publicConfig } = server;
  return { ...publicConfig, revision: configRevision(server), envNames: Object.keys(env ?? {}),
    hasAuthorization: Object.keys(headers ?? {}).some(key => key.toLowerCase() === 'authorization') };
}

export function applyServerEdit(server: MCPServer, edit: MCPServerEdit): MCPServer {
  if (configRevision(server) !== edit.revision) throw new MCPConfigConflict('Server changed. Close and reopen the editor to reload its configuration.');
  const { revision: _revision, authorization, envPatch, ...fields } = edit;
  const next = { ...structuredClone(server), ...fields };
  if (fields.cwd === '') delete next.cwd;
  if (authorization !== undefined) {
    next.headers = Object.fromEntries(Object.entries(next.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'));
    if (authorization !== null && authorization.trim()) next.headers.Authorization = authorization.trim();
  }
  if (envPatch) {
    next.env ??= {};
    for (const [key, value] of Object.entries(envPatch)) {
      if (value === null) delete next.env[key];
      else next.env[key] = value;
    }
  }
  if (!next.transport || next.transport === 'stdio') {
    if (!next.command.trim()) throw new Error('A command or executable path is required');
  } else {
    for (const value of next.transport === 'sse' ? [next.sseUrl, next.postUrl] : [next.sseUrl]) {
      let url: URL;
      try { url = new URL(value ?? ''); } catch { throw new Error('A valid HTTP URL is required'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URLs must use HTTP or HTTPS');
    }
  }
  return next;
}
