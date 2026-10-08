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

/**
 * `mcp__<server>__<tool>` for each of one server's tools, keyed by the tool's
 * real name. Characters outside [A-Za-z0-9_] become `_`; a name that then
 * collides with another of the server's tools, or runs past 64 characters,
 * gets a hash suffix so every tool keeps a distinct, stable name.
 */
export function mcpToolNames(serverId: string, toolNames: string[]): Map<string, string> {
  const bases = toolNames.map((tool) => `mcp__${sanitize(serverId)}__${sanitize(tool)}`);
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  const out = new Map<string, string>();
  toolNames.forEach((tool, i) => {
    const base = bases[i];
    out.set(tool, (counts.get(base) ?? 0) > 1 || base.length > MAX_TOOL_NAME ? hashed(base, serverId, tool) : base);
  });
  return out;
}
