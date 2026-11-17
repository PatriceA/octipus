import type { FieldDef, RecordData } from './record-fields';
import type { PluginCompanionDecl, PluginSecretDecl } from './plugin-package';

/** Declarative selectors; they discover existing authority, never grant it. */
export const PLUGIN_RESOURCE_KINDS = ['environment', 'folder', 'connection', 'http-grants', 'protection'] as const;
export interface PluginResourceField {
  setting: string;
  kind: typeof PLUGIN_RESOURCE_KINDS[number];
  multiple?: boolean;
  connectionKind?: 'http' | 'git';
  presets?: Array<{ label: string; paths: string[] }>;
}
export interface PluginSetupDecl {
  defaults?: RecordData;
  resources?: PluginResourceField[];
  /** Read-only tool returning { ok: boolean, message?: string }. */
  check?: { tool: string; input?: Record<string, unknown> };
}
export interface PluginSetupConfiguration {
  fields: FieldDef[];
  secrets: Array<PluginSecretDecl & { configured: boolean }>;
  resources: PluginResourceField[];
  settings: RecordData;
  maxProtection: number;
  environmentBackends?: string[];
  check: PluginSetupDecl['check'] | null;
  installed: boolean;
  enabled: boolean;
  companions?: PluginCompanionDecl[];
}
export interface PluginSetupResources {
  environments: Array<{ id: string; name: string; backend: string; roots: string[] }>;
  connections: Array<{ id: string; origin: string; pathPrefix: string; git: boolean }>;
}
export interface PluginSetupCheck { ok: boolean; message: string; checkedAt: string }
export interface PluginSetupDraft {
  revision: number;
  contentHash: string;
  settings: RecordData;
  stage: 'configure' | 'review' | 'installed' | 'ready';
  updatedAt: string;
}
