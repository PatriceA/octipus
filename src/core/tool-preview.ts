/**
 * Extract a compact, human-readable preview string for a tool invocation.
 *
 * Used in agent activity UIs so `bash(command="ls -la")` shows instead of
 * the full JSON blob of all params. Resolution order:
 *
 *   1. Registered `previewFn` (full custom renderer)
 *   2. Registered `previewParam` (name of the key param)
 *   3. Fallback — "{n params}"
 *
 * Result is always truncated to 80 chars with an ellipsis.
 */

import type { ToolHandler } from './agent-base';

const MAX_LEN = 80;

// Static map for tools discovered by name at runtime (built-ins, MCP).
// Extend via `registerToolPreview` at module init.
const previewHints = new Map<string, string>([
  // Built-in / shell
  ['bash', 'command'],
  ['shell', 'command'],
  ['run_command', 'command'],
  ['shell__run_command', 'command'],
  ['shell__run_background', 'command'],
  // Filesystem
  ['read', 'path'],
  ['read_file', 'path'],
  ['write', 'path'],
  ['write_file', 'path'],
  ['edit', 'path'],
  ['filesystem__read', 'path'],
  ['filesystem__write', 'path'],
  ['filesystem__edit', 'path'],
  // Search
  ['grep', 'pattern'],
  ['glob', 'pattern'],
  ['search', 'query'],
  // Web
  ['web_search', 'query'],
  ['web_fetch', 'url'],
  ['websearch__search', 'query'],
  // Swarm / orchestrator meta-tools
  ['spawn_child', 'subtopic'],
  ['escalate_to_different_expert', 'subtopic'],
  ['create_pipeline', 'name'],
  // Knowledge
  ['knowledge__search', 'query'],
  ['knowledge__index', 'path'],
]);

export function registerToolPreview(toolName: string, paramName: string): void {
  previewHints.set(toolName, paramName);
}

function truncate(s: string): string {
  if (s.length <= MAX_LEN) return s;
  return `${s.slice(0, MAX_LEN - 1)}…`;
}

function stringifyParam(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return '[object]'; }
}

/**
 * Build a compact preview for a specific tool call.
 *
 * If a `ToolHandler` is available, pass it for `previewFn`/`previewParam` hints.
 * Otherwise pass `toolName` to hit the static registry.
 */
export function extractToolPreview(
  toolOrName: ToolHandler | string,
  params: Record<string, unknown>,
): string {
  const name = typeof toolOrName === 'string' ? toolOrName : toolOrName.name;
  const handler = typeof toolOrName === 'string' ? undefined : toolOrName;

  if (handler?.previewFn) {
    try { return truncate(handler.previewFn(params)); } catch { /* fall through */ }
  }

  const paramName = handler?.previewParam ?? previewHints.get(name);
  if (paramName) {
    const value = params[paramName];
    const str = stringifyParam(value);
    if (str) return truncate(str);
  }

  // MCP tools often arrive as `mcp__<server>__<tool>` — try the trailing segment.
  if (!paramName && name.includes('__')) {
    const tail = name.split('__').pop()!;
    const hint = previewHints.get(tail);
    if (hint && params[hint] !== undefined) return truncate(stringifyParam(params[hint]));
  }

  const count = Object.keys(params).length;
  return count === 0 ? '' : `${count} param${count === 1 ? '' : 's'}`;
}

/** Formatted call-site string: `toolName(preview)`. */
export function formatToolCall(
  toolOrName: ToolHandler | string,
  params: Record<string, unknown>,
): string {
  const name = typeof toolOrName === 'string' ? toolOrName : toolOrName.name;
  const preview = extractToolPreview(toolOrName, params);
  return preview ? `${name}(${preview})` : `${name}()`;
}
