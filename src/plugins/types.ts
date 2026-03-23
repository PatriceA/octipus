import type { Logger } from '@/utils/logger';

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  main: string;
  tools: PluginToolDef[];
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

export interface PluginModule {
  name: string;
  initialize?(context: PluginContext): Promise<void>;
  tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  shutdown?(): Promise<void>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  module: PluginModule;
  directory: string;
}
