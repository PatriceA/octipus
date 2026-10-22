import type { McpExposureConfig } from './mcp-exposure';

export interface MCPServer extends McpExposureConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for a local stdio server. */
  cwd?: string;
  /** Per-request timeout for slow local MCP tools, in milliseconds. */
  requestTimeoutMs?: number;
  /** Some stdio servers use stderr for routine logs rather than failures. */
  stderrAsError?: boolean;
  /**
   * Largest result (characters) handed to the model as is; a larger one becomes
   * a JSON envelope with the exact copy saved (default 65,536). Paging tools
   * always get at least their own page (src/core/tool-output-spill.ts).
   */
  maxResultChars?: number;
  /** Per-tool `maxResultChars`, by exact tool name. */
  toolMaxResultChars?: Record<string, number>;
  /** Operator trusts this server's readOnlyHint and octipus/recovery outcome metadata. */
  trustRecoveryHints?: boolean;
  isEnabled: boolean;
  /**
   * What the server offers, in a sentence. Lists the server in the
   * `MCP SERVERS` system-prompt section (src/mcp/servers-section.ts); without
   * it the first line of the server's own `instructions` is used.
   */
  description?: string;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  sseUrl?: string;
  postUrl?: string;
  headers?: Record<string, string>;
}
