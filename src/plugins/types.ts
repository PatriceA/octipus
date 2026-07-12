import type { PluginManifest } from '@octipus/plugin-sdk';
import type { Logger } from '@/utils/logger';

// The manifest contract (plugin.json shape) is owned by the published
// @octipus/plugin-sdk package so authors and the host validate against the same
// definition (WS3). Re-exported here so existing app imports keep working.
export type {
  PluginCapabilities,
  PluginCommandDef,
  PluginManifest,
  PluginToolDef,
  PluginToolParam,
} from '@octipus/plugin-sdk';

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
