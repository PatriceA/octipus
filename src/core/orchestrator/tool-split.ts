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

/**
 * Tool groups that are ALWAYS core regardless of a role's `coreToolIds`:
 * - `mcp`: the MCP meta-tools (`mcp_list_tools`/`mcp_call_tool`) are themselves
 *   a discovery surface — hiding them behind another discovery layer is pointless.
 * - `tool_discovery`: the built-in `list_tools`/`describe_tool` entry points.
 */
const ALWAYS_CORE_TOOL_IDS: ReadonlySet<string> = new Set(['mcp', 'tool_discovery']);

/**
 * True when a handler belongs in the long tail (NOT advertised upfront) for the
 * given core set. Ungrouped handlers (no `toolId`) and always-core groups stay
 * core — we only ever hide a handler when we're sure it's a non-core built-in.
 */
export function isLongTailHandler(handler: ToolHandler, coreToolIds: string[]): boolean {
  const id = handler.toolId;
  if (id === undefined) return false;
  if (ALWAYS_CORE_TOOL_IDS.has(id)) return false;
  return !coreToolIds.includes(id);
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
