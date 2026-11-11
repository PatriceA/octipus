import type { McpExposureConfig } from './mcp-exposure';
import type { PluginHostScope, PluginToolEffect } from './plugin-package';

/**
 * The plugin package a server runs (docs/PLUGIN-PACKAGES.md). Set only on the
 * servers the plugin service gives the bridge; never stored with the MCP
 * servers an operator configures.
 */
export interface PluginBinding {
  package: string;
  version: string;
  /** What each declared tool does; an undeclared tool is hidden and refused. */
  tools: Record<string, PluginToolEffect>;
  /**
   * The highest protection level of the conversation its tools may be called
   * from (docs/PROTECTION-LEVELS.md, C6d): the manifest's `maxProtection`,
   * else 1 for a package with network access and 4 for one without.
   */
  maxProtection: 1 | 2 | 3 | 4;
  /**
   * The host API scopes it may be handed (docs/PLUGIN-PACKAGES.md#host-api):
   * those the manifest declares and an admin approved. Each call gets a token
   * for these, narrowed to the tool's effect and the calling user.
   */
  hostScopes?: PluginHostScope[];
  /**
   * Its `model:complete` calls may run on a CLI lane (a model with its own
   * tools): the manifest declares `model.trustedInput` and an admin approved
   * `model:cli-tools` (docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes).
   */
  modelCliTools?: true;
}

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
  /** Operator-configured named credential connection; never a plaintext value. */
  credentialConnection?: string;
  /** A plugin package's server (see `PluginBinding`). */
  plugin?: PluginBinding;
  /** Hand a stdio server only its `env` and a minimal host environment. */
  isolatedEnv?: boolean;
  /**
   * Run a stdio server in the shell sandbox with `root` as its only writable
   * directory, or with `readOnlyRoot` read-only and `writable` as the
   * writable ones. `egress` limits its network to those hosts through a proxy
   * (src/security/egress-proxy.ts), its socket under `runDir`; with
   * `hostApi`, the proxy also forwards `http://octipus-host.internal/api/plugin-host/…`
   * to the host's own API at that address (docs/PLUGIN-PACKAGES.md#host-api).
   */
  sandbox?: {
    /** Overrides `security.shellSandbox` for this server (a plugin package's: `plugins.sandbox`). */
    mode?: 'required' | 'off';
    root: string; allowNetwork: boolean; readOnlyRoot?: boolean; writable?: string[];
    egress?: { label: string; hosts: string[]; runDir?: string; hostApi?: { host: string; port: number } };
  };
}
