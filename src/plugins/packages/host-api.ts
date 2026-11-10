/**
 * The host API of plugin packages (docs/PLUGIN-PACKAGES.md#host-api): the
 * short-lived token a package's tool call carries, and what it may do.
 *
 * A package that declares `host` scopes, and whose scopes an admin approved,
 * gets with every `tools/call` a token in `_meta["octipus/host"]` (the MCP
 * request's own metadata: it works over stdio, where a per-call environment
 * variable cannot). The token is bound to
 *
 * - the package (its name; the host API refuses it for another one, and the
 *   egress proxy stamps the package's label on every request it forwards),
 * - the user who triggered the call (the agent's user, or the signed-in user
 *   of a page) and the workspace the call ran in,
 * - the scopes it may use: declared ∩ approved ∩ what the tool's effect
 *   allows (a `read` tool gets no write scope) ∩ what the user holds (the
 *   scope's module is on and the user's permission rules do not deny the
 *   matching tool action),
 * - an expiry: the call's timeout. It is revoked as soon as the call returns.
 *
 * Tokens live in this process's memory only, as sha256 hashes: they never
 * outlive the call, so nothing is stored. The normal API never accepts them
 * (they are not session or API tokens, and `ocph_` is not the API token
 * prefix).
 */
import { createHash, randomBytes } from 'node:crypto';
import { getConfig } from '@/config';
import type { AgentContext } from '@/core/types';
import type { MCPServer } from '@/shared/mcp-server';
import {
  PLUGIN_HOST_ALIAS,
  PLUGIN_HOST_META_KEY,
  PLUGIN_HOST_SCOPES,
  PLUGIN_HOST_WRITE_SCOPES,
  type PluginHostCallMeta,
  type PluginHostScope,
  type PluginToolEffect,
} from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';

/** The prefix of a host API token. */
export const HOST_TOKEN_PREFIX = 'ocph_';

/**
 * The longest a token lives, whatever the package's `requestTimeoutMs` (up to
 * 600 s): a token held past its own call must not still work during another
 * user's. Revocation at the end of the call still applies first.
 */
export const MAX_TOKEN_TTL_MS = 30_000;
/** Upper bound on live tokens; the oldest go first (each is revoked at the end of its call anyway). */
const MAX_LIVE_TOKENS = 10_000;

export interface HostTokenGrant {
  plugin: string;
  userId: string;
  /** The workspace the call ran in (a space, or the user's own); null: the user's default. */
  workspaceId: string | null;
  /** The session the call ran in, if any: content read through the host API raises its protection level. */
  sessionId: string | null;
  scopes: PluginHostScope[];
  /** The package's `maxProtection`: documents above it are refused. */
  maxProtection: 1 | 2 | 3 | 4;
  /** The tool whose call the token belongs to, for the audit. */
  tool: string;
  expiresAt: number;
}

const live = new Map<string, HostTokenGrant>();

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Mint a token for one call. */
export function mintHostToken(grant: Omit<HostTokenGrant, 'expiresAt'>, ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
  sweep(now);
  if (live.size >= MAX_LIVE_TOKENS) {
    const oldest = live.keys().next().value;
    if (oldest !== undefined) live.delete(oldest);
  }
  const token = `${HOST_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = now + ttlMs;
  live.set(hashOf(token), { ...grant, scopes: [...grant.scopes], expiresAt });
  return { token, expiresAt };
}

/**
 * The grant of a live token, or null (unknown, revoked, expired, or bound
 * to another package than `plugin`).
 */
export function verifyHostToken(token: string, plugin: string, now = Date.now()): HostTokenGrant | null {
  if (!token.startsWith(HOST_TOKEN_PREFIX) || token.length > 200) return null;
  const key = hashOf(token);
  const grant = live.get(key);
  if (!grant) return null;
  if (grant.expiresAt <= now) {
    live.delete(key);
    return null;
  }
  return grant.plugin === plugin ? grant : null;
}

export function revokeHostToken(token: string): void {
  live.delete(hashOf(token));
}

/** Revoke every token of a package (it was disabled, upgraded or removed). */
export function revokePluginTokens(plugin: string): void {
  for (const [key, grant] of live) if (grant.plugin === plugin) live.delete(key);
}

function sweep(now: number): void {
  for (const [key, grant] of live) if (grant.expiresAt <= now) live.delete(key);
}

/** Test-only. */
export function _liveHostTokens(): number {
  return live.size;
}

export function isHostScope(value: unknown): value is PluginHostScope {
  return typeof value === 'string' && (PLUGIN_HOST_SCOPES as readonly string[]).includes(value);
}

/**
 * The scopes a call of a tool with `effect` may be handed: declared and
 * approved, and for a `read` tool only the read scopes.
 */
export function grantableScopes(
  declared: readonly PluginHostScope[] | undefined,
  approved: readonly PluginHostScope[] | null | undefined,
  effect: PluginToolEffect,
): PluginHostScope[] {
  const ok = new Set(approved ?? []);
  return (declared ?? []).filter((s) => ok.has(s) && (effect !== 'read' || !PLUGIN_HOST_WRITE_SCOPES.includes(s)));
}

/**
 * The built-in tool action a scope stands for: the user's rules on it apply.
 * `notify` reaches only the user and `model:complete` runs on the user's own
 * model lane; neither has one. `web:read` is the web tool's page fetch: a user
 * whose rules deny `websearch.fetch` does not get it.
 */
export const SCOPE_TOOL_ACTION: Record<PluginHostScope, { toolId: string; action: string } | null> = {
  'notes:read': { toolId: 'notes', action: 'read' },
  'notes:write': { toolId: 'notes', action: 'write' },
  'tasks:read': { toolId: 'tasks', action: 'read' },
  'tasks:write': { toolId: 'tasks', action: 'write' },
  'documents:read': { toolId: 'documents', action: 'read' },
  notify: null,
  'web:read': { toolId: 'websearch', action: 'fetch' },
  'model:complete': null,
};

/**
 * Of `scopes`, those `userId` holds: the scope's module is on and the user's
 * permission rules do not deny the matching tool action. (An ASK is not a
 * denial: the plugin tool's own effect was what was asked about.)
 */
export async function userHeldScopes(
  userId: string,
  scopes: readonly PluginHostScope[],
  scope?: Pick<AgentContext, 'sessionId' | 'workspaceId'>,
): Promise<PluginHostScope[]> {
  const { isToolOn } = await import('@/core/modules/registry');
  const { getPermissionManager } = await import('@/security/permissions');
  const pm = getPermissionManager();
  const held: PluginHostScope[] = [];
  for (const s of scopes) {
    const ta = SCOPE_TOOL_ACTION[s];
    if (ta) {
      if (!isToolOn(ta.toolId)) continue;
      const check = await pm.check(userId, ta.toolId, ta.action, {}, scope ?? { sessionId: '', workspaceId: null });
      if (check.level === 'DENY') continue;
    }
    held.push(s);
  }
  return held;
}

let portOverride: number | null = null;

/** Where the API listens, when it is not `api.port` (tests listen on an ephemeral port). */
export function setHostApiPort(port: number | null): void {
  portOverride = port;
}

/** The address the egress proxy forwards host API requests to: this server's own API, on loopback when it listens on every interface. */
export function hostApiTarget(): { host: string; port: number } {
  const { host, port } = getConfig().api;
  const loopback = !host || host === '0.0.0.0' || host === '::' || host === 'localhost';
  return { host: loopback ? '127.0.0.1' : host, port: portOverride ?? port };
}

/** The calls that may carry a host API token: each one started by the user it acts for. */
export type HostCallKind = 'agent' | 'command' | 'page';

/**
 * What started a call, when it is one a user started themselves, or null:
 *
 * - `page`: the page bridge, a signed-in user on the package's page
 *   (`metadata.source = 'plugin-page'`);
 * - `command`: a slash command the user typed (`plugin-contribution`, kind `command`);
 * - `agent`: a tool call of the user's own agent in their session
 *   (`trigger = 'user'`, a session, no `metadata.source` of a known
 *   unattended kind).
 *
 * Everything else is null and gets no token: a contribution called by a
 * schedule, an event or the turn-start context (it runs for users who did
 * not ask for it, or as an admin), a contribution kind not known here, a
 * heartbeat, cron, room, remote or listen turn, a call without a session.
 */
export function hostCallKind(context: Pick<AgentContext, 'trigger' | 'sessionId' | 'metadata'>): HostCallKind | null {
  const source = context.metadata?.source;
  if (source === 'plugin-page') return 'page';
  if (source === 'plugin-contribution') return context.metadata?.contribution === 'command' ? 'command' : null;
  if (source !== undefined && UNATTENDED_SOURCES.has(String(source))) return null;
  return context.trigger === 'user' && !!context.sessionId ? 'agent' : null;
}

/** Metadata sources of runs nobody started by hand. */
const UNATTENDED_SOURCES = new Set(['heartbeat', 'cron', 'schedule', 'hook', 'monitor', 'event', 'webhook']);

/** The base URL a package calls the host API at (through its proxy). */
export const HOST_API_URL = `http://${PLUGIN_HOST_ALIAS}`;

/**
 * The `_meta` of one `tools/call` to a package's server: a fresh token for
 * the calling user, or null when the package has no host scopes, the tool
 * is not declared, or nothing is left after narrowing. `release` revokes it.
 * Registered with the bridge by the plugin service (`setPluginCallMeta`).
 */
export async function issueHostCallMeta(
  server: MCPServer,
  toolName: string,
  context: AgentContext | undefined,
): Promise<{ meta: Record<string, unknown>; release: () => void } | null> {
  const binding = server.plugin;
  if (!binding?.hostScopes?.length || !context?.userId) return null;
  // Only a call the user started: never a schedule, an event or a context call.
  if (hostCallKind(context) === null) return null;
  const effect = Object.hasOwn(binding.tools, toolName) ? binding.tools[toolName] : undefined;
  if (!effect) return null;
  const candidates = grantableScopes(binding.hostScopes, binding.hostScopes, effect);
  const scopes = await userHeldScopes(context.userId, candidates, { sessionId: context.sessionId, workspaceId: context.workspaceId ?? null });
  if (scopes.length === 0) return null;
  const ttl = Math.min(server.requestTimeoutMs ?? MAX_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
  const { token, expiresAt } = mintHostToken({
    plugin: binding.package,
    userId: context.userId,
    workspaceId: context.space?.workspaceId ?? context.workspaceId ?? null,
    sessionId: context.sessionId || null,
    scopes,
    maxProtection: binding.maxProtection,
    tool: toolName,
  }, ttl);
  coreLogger.debug({ pkg: binding.package, tool: toolName, scopes }, 'Plugin host API token issued for a call');
  const meta: PluginHostCallMeta = { url: HOST_API_URL, token, expiresAt: new Date(expiresAt).toISOString(), scopes };
  return { meta: { [PLUGIN_HOST_META_KEY]: meta }, release: () => revokeHostToken(token) };
}
