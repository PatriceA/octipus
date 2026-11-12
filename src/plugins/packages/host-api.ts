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
  PLUGIN_HOST_EXTERNAL_SCOPES,
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
  /**
   * That tool's declared effect. A scope of `PLUGIN_HOST_START_SCOPES`
   * (`agent:run`) starts something only for a `write` or `external` tool;
   * unset counts as `read`.
   */
  effect?: PluginToolEffect;
  expiresAt: number;
  /**
   * The highest protection level of what this call has read through the host
   * API so far (documents, tasks): a `model:complete` of the same call runs at
   * that content level. Unset: nothing above level 1 read.
   */
  readLevel?: number;
  /**
   * The package's `model:complete` calls may run on a CLI lane: it declares
   * `model.trustedInput` and an admin approved `model:cli-tools`
   * (docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes). Unset: refused there.
   */
  modelCliTools?: true;
  /**
   * This call has sent a message (`mail:send`): one approved call sends one
   * message (docs/PLUGIN-PACKAGES.md#mail-and-calendar).
   */
  mailSent?: true;
}

/**
 * Record that the call of `grant` read content at `level`: its `model:complete`
 * runs at the highest, and the package's level for this user is kept across
 * calls (./read-level.ts), so a later call cannot write it out at a lower one.
 */
export async function noteHostRead(grant: HostTokenGrant, level: number | null | undefined): Promise<void> {
  const l = typeof level === 'number' && Number.isFinite(level) ? level : 4;
  if (l > (grant.readLevel ?? 1)) grant.readLevel = l;
  const { recordReadLevel } = await import('./read-level');
  await recordReadLevel(grant.plugin, grant.userId, l);
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

/**
 * Revoke every token of a package (it was disabled, upgraded or removed, or
 * its approval changed), and stop its background agent runs (`agent:run`):
 * they were started under the approval that just went.
 */
export function revokePluginTokens(plugin: string): void {
  for (const [key, grant] of live) if (grant.plugin === plugin) live.delete(key);
  for (const run of runs.values()) if (run.plugin === plugin) run.stop('The plugin was disabled, upgraded or removed, or its approval changed');
}

// ── Background agent runs (`agent:run`, src/plugins/packages/host-agent.ts) ──
// Kept here, beside the tokens, because the token issuer consults them: a tool
// call made inside a plugin's background run gets no host token (nobody
// started that call by hand), and revoking a package's tokens stops its runs.

interface LiveRun { plugin: string; userId: string; sessionId: string; stop: (reason: string) => void }
const runs = new Map<string, LiveRun>();

/** Register a running background run (its job id); `stop` ends it. */
export function trackPluginRun(jobId: string, run: LiveRun): void {
  runs.set(jobId, run);
}

export function untrackPluginRun(jobId: string): void {
  runs.delete(jobId);
}

/** Stop one running background run in this process (its job id); false when it does not run here. */
export function stopPluginRun(jobId: string, reason: string): boolean {
  const run = runs.get(jobId);
  if (!run) return false;
  run.stop(reason);
  return true;
}

/** Whether `sessionId` is the session of a running plugin background run. */
export function isPluginRunSession(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false;
  for (const run of runs.values()) if (run.sessionId === sessionId) return true;
  return false;
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
 * approved; for a `read` tool only the read scopes, and the scopes that act
 * outside Octipus (`mail:send`) for an `external` tool only.
 */
export function grantableScopes(
  declared: readonly PluginHostScope[] | undefined,
  approved: readonly PluginHostScope[] | null | undefined,
  effect: PluginToolEffect,
): PluginHostScope[] {
  const ok = new Set(approved ?? []);
  return (declared ?? []).filter((s) => ok.has(s)
    && (effect !== 'read' || !PLUGIN_HOST_WRITE_SCOPES.includes(s))
    && (effect === 'external' || !PLUGIN_HOST_EXTERNAL_SCOPES.includes(s)));
}

/**
 * The built-in tool action a scope stands for: the user's rules on it apply.
 * `notify` reaches only the user, `model:complete` runs on the user's own
 * model lane and `agent:run` is an agent whose every tool call meets the
 * user's rules; none has one. `web:read` is the web tool's page fetch: a user
 * whose rules deny `websearch.fetch` does not get it.
 */
export const SCOPE_TOOL_ACTION: Record<PluginHostScope, { toolId: string; action: string } | null> = {
  'notes:read': { toolId: 'notes', action: 'read' },
  'notes:write': { toolId: 'notes', action: 'write' },
  'tasks:read': { toolId: 'tasks', action: 'read' },
  'tasks:write': { toolId: 'tasks', action: 'write' },
  'documents:read': { toolId: 'documents', action: 'read' },
  // The documents tool's own write action (it creates a document); a user whose rules deny it does not get the scope.
  'documents:write': { toolId: 'documents', action: 'export_document' },
  notify: null,
  'web:read': { toolId: 'websearch', action: 'fetch' },
  'model:complete': null,
  // The run is the host's own agent: each of its tool calls goes through the user's rules itself.
  'agent:run': null,
  // The package's own data for this user (docs/PLUGIN-PACKAGES.md#store): no built-in tool stands for it.
  'store:read': null,
  'store:write': null,
  // Mail and calendar reach more than one source (the Mail module's mailboxes,
  // the connected Google or Microsoft 365 account), each with a tool of its own:
  // the source's module and the user's rules on that tool's action are checked
  // per request (src/plugins/packages/host-sources.ts).
  'mail:read': null,
  'mail:draft': null,
  'mail:send': null,
  'calendar:read': null,
  'calendar:write': null,
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
export type HostCallKind = 'agent' | 'command' | 'page' | 'dashboard';

/**
 * What started a call, when it is one a user started themselves, or null:
 *
 * - `page`: the page bridge, a signed-in user on the package's page
 *   (`metadata.source = 'plugin-page'`);
 * - `dashboard`: a widget of the package's dashboard a signed-in user opened
 *   (`plugin-dashboard`, a read tool only);
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
  // A dashboard the signed-in user opened: its widget's read tool, as that user.
  if (source === 'plugin-dashboard') return 'dashboard';
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
  // Only a call the user started: never a schedule, an event or a context call,
  // nor a call an agent makes inside a plugin's background run (agent:run).
  if (hostCallKind(context) === null || isPluginRunSession(context.sessionId)) return null;
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
    effect,
    ...(binding.modelCliTools && scopes.includes('model:complete') ? { modelCliTools: true as const } : {}),
  }, ttl);
  coreLogger.debug({ pkg: binding.package, tool: toolName, scopes }, 'Plugin host API token issued for a call');
  const meta: PluginHostCallMeta = { url: HOST_API_URL, token, expiresAt: new Date(expiresAt).toISOString(), scopes };
  return { meta: { [PLUGIN_HOST_META_KEY]: meta }, release: () => revokeHostToken(token) };
}
