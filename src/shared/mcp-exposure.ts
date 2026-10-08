/**
 * How an MCP server's tools reach the model — after pi's MCP exposure modes.
 * Shared by the bridge (`src/mcp/`) and the MCP page (`web/app/mcp/`), so the
 * effective exposure the UI shows is computed by the same function the bridge
 * dispatches with.
 *
 * - `direct`   — declared to the model as its own tool (`mcp__<server>__<tool>`),
 *                with its full schema, on every request. For small, frequently
 *                used tool sets.
 * - `deferred` — the default: listed by `mcp_list_tools` and called through
 *                `mcp_call_tool`. Nothing is declared until the model asks.
 * - `codemode` — kept out of `mcp_list_tools`; codemode scripts call it as
 *                `tools.mcp__<server>__<tool>(args)`, so neither its schema nor
 *                its results enter the conversation. A worker without codemode
 *                (small model, remote room) treats it as `deferred`.
 * - `hidden`   — unreachable: not listed, and the bridge refuses the call.
 *
 * Exposure decides what the model SEES. Every call, whichever way it arrives,
 * still passes the same permission pipeline.
 */

export const MCP_EXPOSURES = ['direct', 'deferred', 'codemode', 'hidden'] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** The exposure of a server that sets none. Unchanged from before exposure existed. */
export const DEFAULT_MCP_EXPOSURE: McpExposure = 'deferred';

export interface McpExposureConfig {
  exposure?: McpExposure;
  /**
   * Per-tool overrides. Keys are exact tool names or patterns where `*` matches
   * any characters. An exact name wins over patterns; among patterns the first
   * match in insertion order wins.
   */
  toolExposure?: Record<string, McpExposure>;
}

export function isMcpExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && (MCP_EXPOSURES as readonly string[]).includes(value);
}

function patternMatches(pattern: string, name: string): boolean {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(name);
}

/** The exposure one tool of a server actually gets. */
export function resolveToolExposure(server: McpExposureConfig, toolName: string): McpExposure {
  const overrides = server.toolExposure ?? {};
  const exact = overrides[toolName];
  if (exact) return exact;
  for (const [pattern, exposure] of Object.entries(overrides)) {
    if (pattern.includes('*') && patternMatches(pattern, toolName)) return exposure;
  }
  return server.exposure ?? DEFAULT_MCP_EXPOSURE;
}

/**
 * Reject a malformed exposure config with a specific message (fail loud at the
 * boundary). Returns null when valid.
 */
export function exposureConfigError(config: { exposure?: unknown; toolExposure?: unknown }): string | null {
  if (config.exposure !== undefined && !isMcpExposure(config.exposure)) {
    return `exposure must be one of ${MCP_EXPOSURES.join(', ')}; got ${JSON.stringify(config.exposure)}`;
  }
  if (config.toolExposure !== undefined) {
    if (!config.toolExposure || typeof config.toolExposure !== 'object' || Array.isArray(config.toolExposure)) {
      return 'toolExposure must be an object mapping tool names or * patterns to an exposure';
    }
    for (const [key, value] of Object.entries(config.toolExposure)) {
      if (!key.trim()) return 'toolExposure keys must be non-empty tool names or patterns';
      if (!isMcpExposure(value)) {
        return `toolExposure["${key}"] must be one of ${MCP_EXPOSURES.join(', ')}; got ${JSON.stringify(value)}`;
      }
    }
  }
  return null;
}
