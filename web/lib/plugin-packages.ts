/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): the shapes the API returns and
 * the query keys the admin pages share.
 *
 * Backend: src/api/routes/plugin-packages.ts — GET /api/plugin-packages,
 * GET /api/plugin-packages/registry, POST /api/plugin-packages { path | url, sha256? },
 * PATCH /api/plugin-packages/:name { enabled?, approveContent? }.
 */
export type {
  PluginNetworkStatus,
  PluginPackageView,
  PluginRegistryEntry,
  PluginRegistryListing,
  PluginSignatureStatus,
} from '../../src/shared/plugin-package';

export const PLUGIN_PACKAGES_KEY = ['admin', 'plugin-packages'] as const;
export const PLUGIN_REGISTRY_KEY = ['admin', 'plugin-packages', 'registry'] as const;

/** What POST /api/plugin-packages answers. */
export interface PluginInstallResult {
  name: string;
  version: string;
  enabled: boolean;
  signedBy: string | null;
  warnings?: string[];
}
