/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): the shapes the server and the web
 * share. Dependency-free so `web/` imports it as is; the manifest is parsed
 * and checked in src/plugins/packages/manifest.ts.
 */
import type { FieldDef } from './record-fields';

/** The manifest file at a package's root. */
export const PLUGIN_MANIFEST_FILE = 'octipus-plugin.json';

/** The manifest contract this host reads (`apiVersion`, same MAJOR, MINOR not newer). */
export const PLUGIN_PACKAGE_API_VERSION = '1.0.0';

/**
 * What a tool does, as its package declares it. The host decides the
 * permission from it, and the declaration can only make a tool stricter:
 *
 * - `read`: reads only. Default ALLOW.
 * - `write`: changes data in the system it connects to. Default ASK.
 * - `external`: an effect outside the organisation — a payment, a message to
 *   a person, a post. Always ASK: a permission rule cannot lower it, and an
 *   unattended run is refused.
 *
 * A tool the package does not declare is hidden and refused.
 */
export const PLUGIN_TOOL_EFFECTS = ['read', 'write', 'external'] as const;
export type PluginToolEffect = (typeof PLUGIN_TOOL_EFFECTS)[number];

export interface PluginToolDecl {
  effect: PluginToolEffect;
  /** One line shown at install time. */
  description?: string;
}

/** A credential the package needs, stored in the vault and handed to it as an environment variable of the same name. */
export interface PluginSecretDecl {
  /** The environment variable name, e.g. `FINAPI_CLIENT_SECRET`. */
  key: string;
  label: string;
  help?: string;
  required?: boolean;
}

export interface PluginManifest {
  /** Lower-case package name, e.g. `finapi`. */
  name: string;
  version: string;
  apiVersion: string;
  /** Shown in the plugin list. */
  title: string;
  description: string;
  publisher?: string;
  homepage?: string;
  /** How the host starts the package: a local MCP server over stdio, in the package directory. */
  server: {
    command: string;
    args?: string[];
    /** Per-request timeout for slow tools, in milliseconds. */
    requestTimeoutMs?: number;
  };
  /** Every tool the package offers and what it does. */
  tools: Record<string, PluginToolDecl>;
  /** Hosts the package talks to. Shown at install; the sandbox gets network only when there is at least one. */
  network?: string[];
  /**
   * The highest protection level (1-4, docs/plans/business-os.md C6) of data
   * the package may see. Recorded now; enforced by the privacy gateway.
   */
  maxProtection?: 1 | 2 | 3 | 4;
  /** Non-secret settings, handed to the package as `OCTIPUS_SETTING_<KEY>`. */
  settings?: FieldDef[];
  secrets?: PluginSecretDecl[];
}

/** An installed package as the API returns it. */
export interface PluginPackageView {
  name: string;
  version: string;
  manifest: PluginManifest;
  enabled: boolean;
  settings: Record<string, string | number | boolean>;
  /** Which declared secrets have a value in the vault (never the values). */
  secretsSet: string[];
  /** Why the package is not running, when it should be. */
  problem: string | null;
  /** Whether its MCP server is connected right now. */
  connected: boolean;
  installedBy: string | null;
  installedAt: string;
  updatedAt: string;
}
