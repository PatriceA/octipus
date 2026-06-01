import type { Logger } from '@/utils/logger';

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  main: string;
  tools: PluginToolDef[];
  /**
   * Secrets the plugin needs, mapping a `config` key to the name of a system
   * secret in the vault. The loader resolves each from the vault and injects
   * the value into [PluginContext.config]. Secrets are NEVER read from `.env` —
   * the vault is the source of truth.
   */
  secrets?: Record<string, string>;
}

export interface PluginToolDef {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
    default?: unknown;
  }>;
}

export interface PluginContext {
  logger: Logger;
  config: Record<string, unknown>;
}

/**
 * Per-call context passed to a plugin tool handler. `config` holds the plugin's
 * declared secrets, resolved from the vault for the CALLING user at call time
 * (user scope first, then system fallback). Never sourced from `.env`.
 */
export interface PluginToolContext {
  config: Record<string, unknown>;
}

export interface PluginModule {
  name: string;
  initialize?(context: PluginContext): Promise<void>;
  tools: Record<
    string,
    (args: Record<string, unknown>, ctx?: PluginToolContext) => Promise<unknown>
  >;
  shutdown?(): Promise<void>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  directory: string;
}
