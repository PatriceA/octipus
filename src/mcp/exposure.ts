/**
 * Model-facing names for individual MCP tools (`direct` handlers and the
 * `codemode` script tools). See `src/shared/mcp-exposure.ts` for the modes.
 */
import { createHash } from 'node:crypto';

/** Providers accept at most 64 characters of [A-Za-z0-9_-] in a tool name. */
const MAX_TOOL_NAME = 64;

const sanitize = (part: string) => part.replace(/[^A-Za-z0-9_]/g, '_');
const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8);

function hashed(base: string, serverId: string, toolName: string): string {
  const suffix = `_${shortHash(`${serverId}\u0000${toolName}`)}`;
  return `${base.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
}

/** One tool of one server, as `mcpToolNames` names it. */
export interface McpToolRef {
  serverId: string;
  toolName: string;
}

/** Map key for a tool: server ids and tool names are free text, so join on NUL. */
export const mcpToolKey = (ref: McpToolRef) => `${ref.serverId}\u0000${ref.toolName}`;

/**
 * `mcp__<server>__<tool>` for every tool of every connected server, keyed by
 * `mcpToolKey`. Characters outside [A-Za-z0-9_] become `_`. A name that then
 * collides with any other — within one server (`a-b` / `a.b`) or across two
 * whose ids sanitise alike (`my-srv` / `my_srv`) — or runs past 64 characters
 * gets a hash suffix, so no handler or script tool silently replaces another.
 */
export function mcpToolNames(refs: McpToolRef[]): Map<string, string> {
  const bases = refs.map((ref) => `mcp__${sanitize(ref.serverId)}__${sanitize(ref.toolName)}`);
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  const out = new Map<string, string>();
  refs.forEach((ref, i) => {
    const base = bases[i];
    const unique = (counts.get(base) ?? 0) === 1 && base.length <= MAX_TOOL_NAME;
    out.set(mcpToolKey(ref), unique ? base : hashed(base, ref.serverId, ref.toolName));
  });
  return out;
}
