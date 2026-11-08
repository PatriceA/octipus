/**
 * Lazy tool discovery — partition a role's tool handlers into a "core" set
 * (advertised with full JSON schema on every request) and a "long tail"
 * (reachable only via the `list_tools` / `describe_tool` meta-tools).
 *
 * Pure: no model/DB access, no mutation of the input array. The gating decision
 * (which roles/models actually use lazy mode) lives in the worker-spawner;
 * this module only knows how to split a flat handler list given a core set.
 *
 * See docs/plans/lazy-tool-discovery.md.
 */

import type { ToolHandler } from '@/core/agent-base';
import { isIntentGatedGroup } from './tool-intent';

/**
 * Tool groups that are ALWAYS core regardless of a role's `coreToolIds`:
 * - `mcp`: the MCP meta-tools (`mcp_list_tools`/`mcp_call_tool`) are themselves
 *   a discovery surface — hiding them behind another discovery layer is pointless.
 * - `tool_discovery`: the built-in `list_tools`/`describe_tool` entry points.
 */
/** Group id of the `list_tools`/`describe_tool` handlers `buildToolDiscoveryHandlers` adds. */
export const TOOL_DISCOVERY_TOOL_ID = 'tool_discovery';

const ALWAYS_CORE_TOOL_IDS: ReadonlySet<string> = new Set(['mcp', TOOL_DISCOVERY_TOOL_ID]);

/**
 * True when a handler belongs in the long tail (NOT advertised upfront) for the
 * given core set. Ungrouped handlers (no `toolId`) and always-core groups stay
 * core — we only ever hide a handler when we're sure it's a non-core built-in.
 */
export function isLongTailHandler(handler: ToolHandler, coreToolIds: string[]): boolean {
  // Checked before the toolId rules: a meta-tool has no toolId, so without this
  // it would be core forever no matter what the core set says.
  if (handler.discoverOnly === true) return true;
  const id = handler.toolId;
  if (id === undefined) return false;
  if (ALWAYS_CORE_TOOL_IDS.has(id)) return false;
  return !coreToolIds.includes(id);
}

/**
 * `handlers` with the groups named in `groupOrder` first, in that order, and
 * everything else after them in its original order. Stable within a group.
 *
 * Groups first because what follows them varies between turns on its own: MCP
 * servers reconnect or change what they expose, the inline-UI tool follows the
 * client, some meta-tools exist only on some turns. In front, any of those
 * would shift every group tool behind it. See `ToolAdvertisement.groupOrder`.
 * `orderForCache` applies it to the sticky tier only, after the tools every
 * user of the install shares.
 */
export function orderByGroup(handlers: ToolHandler[], groupOrder: readonly string[]): ToolHandler[] {
  const rank = new Map(groupOrder.map((id, i) => [id, i]));
  const grouped = handlers
    .map((h, i) => ({ h, i, r: h.toolId === undefined ? undefined : rank.get(h.toolId) }))
    .filter((x): x is { h: ToolHandler; i: number; r: number } => x.r !== undefined)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.h);
  const rest = handlers.filter((h) => h.toolId === undefined || !rank.has(h.toolId));
  return [...grouped, ...rest];
}

/**
 * Where a tool sits in the tool block, for prompt caching across the users of
 * one install (C3, C7). Tools are the first bytes of a request, so a tool that
 * differs between two users, or changes while a conversation runs, ends the
 * prefix they can share at its position:
 *
 *  - `shared`: the install's built-ins, the meta-tools, the MCP meta-tools
 *    (`MCP_META_TOOL_NAMES`) and the discovery and self-report tools: the
 *    same bytes for every user of a role on this install.
 *  - `variable`: what differs per user or session, or changes at runtime.
 *    Connector tools (per user), the inline-UI tool (per user and client),
 *    direct MCP tools (`mcp__<server>__<tool>`: servers connect, reconnect
 *    and change what they expose; plugin packages run as `plugin-*` MCP
 *    servers and are enabled and disabled at runtime), extension tools (`ext_*`, loaded and unloaded at
 *    runtime) and plugin containers (`plugin-*`).
 *  - `sticky`: on the lazy path, the groups the message selects
 *    (`isIntentGatedGroup`). They differ between conversations and grow
 *    during one, so they go last, in the order the conversation first used
 *    them: a group used later is appended at the tail.
 */
export type ToolCacheTier = 'shared' | 'variable' | 'sticky';

/**
 * The MCP bridge's meta-tools (`getLazyToolHandlers`, `resourceHandlers`):
 * fixed names, descriptions and schemas that name no server, so they are the
 * same bytes for every user whatever is connected. The bridge registers them
 * all or none, on whether any server of the install is connected — install-
 * wide state, not per user. In a space session `withoutPersonalOnlyTools`
 * drops `mcp_list_resources`, as it drops other personal-only tools; that
 * differs by session kind, not by user. `src/mcp/exposure.test.ts` holds the
 * bridge to this list and to constant definitions.
 */
export const MCP_META_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp_list_tools', 'mcp_call_tool', 'mcp_list_resources', 'mcp_read_resource', 'mcp_get_prompt', 'mcp_read_result',
]);

/** Tools offered only while some per-thread state holds (open taken tasks). */
const CONDITIONAL_TOOLS = new Set(['complete_taken_task']);

export function toolCacheTier(handler: ToolHandler, lazy: boolean): ToolCacheTier {
  const id = handler.toolId;
  if (CONDITIONAL_TOOLS.has(handler.name)) return 'variable';
  if (id === 'mcp') return MCP_META_TOOL_NAMES.has(handler.name) ? 'shared' : 'variable';
  if (id === 'connector' || id === 'inline-ui' || id?.startsWith('ext_') || id?.startsWith('plugin-')) return 'variable';
  if (lazy && isIntentGatedGroup(id)) return 'sticky';
  return 'shared';
}

/**
 * `handlers` as [shared] [variable] [sticky] (`toolCacheTier`), stable within
 * each tier; the sticky tier follows `groupOrder` (first-advertised) when one
 * is given. `sharedCount` is how many leading tools are shared: the provider
 * puts the tool block's cache breakpoint on the last loaded one of them
 * (`markToolsCacheBreakpoint`), so that entry is the same bytes for every
 * user of the install.
 *
 * Only the order changes, never the set.
 */
export function orderForCache(
  handlers: ToolHandler[],
  options: { lazy: boolean; groupOrder?: readonly string[] },
): { tools: ToolHandler[]; sharedCount: number } {
  const tiers: Record<ToolCacheTier, ToolHandler[]> = { shared: [], variable: [], sticky: [] };
  for (const handler of handlers) tiers[toolCacheTier(handler, options.lazy)].push(handler);
  const sticky = options.groupOrder?.length ? orderByGroup(tiers.sticky, options.groupOrder) : tiers.sticky;
  return { tools: [...tiers.shared, ...tiers.variable, ...sticky], sharedCount: tiers.shared.length };
}

export interface SplitTools {
  core: ToolHandler[];
  longTail: ToolHandler[];
}

/**
 * Partition handlers into core/longTail. `coreToolIds === undefined` ⇒ no
 * opt-in: everything is core, long tail empty (byte-for-byte current behavior).
 */
export function splitRoleTools(
  handlers: ToolHandler[],
  coreToolIds: string[] | undefined,
): SplitTools {
  if (coreToolIds === undefined) {
    return { core: [...handlers], longTail: [] };
  }
  const core: ToolHandler[] = [];
  const longTail: ToolHandler[] = [];
  for (const handler of handlers) {
    if (isLongTailHandler(handler, coreToolIds)) {
      longTail.push(handler);
    } else {
      core.push(handler);
    }
  }
  return { core, longTail };
}
