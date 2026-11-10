/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): the shapes the API returns and
 * the query keys the admin pages share.
 *
 * Backend: src/api/routes/plugin-packages.ts — GET /api/plugin-packages,
 * GET /api/plugin-packages/registry, GET /api/plugin-packages/bundled,
 * POST /api/plugin-packages { path | url, sha256? | bundled },
 * PATCH /api/plugin-packages/:name { enabled?, approveContent?, approveInProcess?, approveContributions?, approveHostScopes? (host scopes, and model:cli-tools), settings? },
 * PUT /api/plugin-packages/:name/secrets/:key { value | null },
 * DELETE /api/plugin-packages/:name.
 */
export type {
  BundledPluginView,
  MarketplaceListing,
  MarketplacePluginView,
  PluginOrigin,
  PluginPermissionDiff,
  PluginRevocationView,
  PluginUpdateView,
  PluginUsageView,
  PluginContributionsView,
  PluginAgentAuthorship,
  PluginInProcessStatus,
  PluginNetworkStatus,
  PluginModelCliToolsView,
  PluginPackageView,
  PluginRegistryEntry,
  PluginRegistryListing,
  PluginSignatureStatus,
} from '../../src/shared/plugin-package';

export {
  MAX_PLUGIN_SECRET_LENGTH,
  MODEL_CLI_TOOLS_WARNING,
  PLUGIN_MODEL_CLI_TOOLS_APPROVAL as MODEL_CLI_TOOLS_APPROVAL,
} from '../../src/shared/plugin-package';

export type {
  PluginConsentItem,
  PluginConsentResult,
  PluginConsentView,
  PluginDeclarationItem,
  PluginGuidanceWarning,
  PluginInstallPreview,
} from '../../src/shared/plugin-declarations';

export {
  AGENT_RUN_NOTE,
  DOCUMENTS_WRITE_NOTE,
  egressReadWarning,
  EGRESS_SCOPES,
  guidanceTone,
  requiredConsentIds,
} from '../../src/shared/plugin-declarations';
export { foldForSearch, HOST_SCOPE_WORDS } from '../../src/shared/plugin-permissions';

export const PLUGIN_PACKAGES_KEY = ['admin', 'plugin-packages'] as const;
export const PLUGIN_MARKETPLACE_KEY = ['admin', 'plugin-packages', 'marketplace'] as const;
export const PLUGIN_UPDATES_KEY = ['admin', 'plugin-packages', 'updates'] as const;
export const PLUGIN_REVOCATIONS_KEY = ['admin', 'plugin-packages', 'revocations'] as const;
export const MY_PLUGIN_USAGE_KEY = ['plugin-packages', 'my-usage'] as const;

/** A revocation as `GET /api/plugin-packages/revocations` lists it. */
export interface PluginRevocationRow {
  id: string;
  kind: 'package' | 'key';
  name: string | null;
  version: string | null;
  keyId: string | null;
  reason: string;
  registryUrl: string;
  signedByKey: string;
  indexGeneratedAt: string;
  firstSeenAt: string;
  clearedAt: string | null;
  clearedBy: string | null;
  clearReason: string | null;
  /** Marketplace revocations apply to marketplace packages, installs and index only. */
  scope: 'marketplace';
  /** In force now: not cleared, and its signer not revoked since. */
  enforced: boolean;
  /** Its signing key was revoked since: not enforced until a trusted key lists it again. */
  signerRevoked: boolean;
}

/** A running background run of a package (`GET /api/plugin-packages/:name/runs?status=running`). */
export interface PluginRunItem {
  id: string;
  userId: string;
  startedAt: string;
  role: string;
  title: string;
}

/** One entry of `GET /api/plugin-packages/my-usage`. */
export interface MyPluginUsage {
  name: string;
  title: string;
  usage: import('../../src/shared/plugin-package').PluginUsageView;
  runs: PluginRunItem[];
}

/**
 * Text from a listing or a package, for display: no control characters, no
 * bidirectional overrides or isolates, no invisible formatting (zero-width
 * marks, word joiners, soft hyphens, filler letters, tag characters), so a
 * name or title cannot be made to read as something else. The host filters
 * them too; this is the second line.
 */
export function displayText(text: string | null | undefined): string {
  let out = '';
  for (const ch of text ?? '') {
    if (!HIDDEN(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/** Control, bidirectional and invisible formatting code points. */
function HIDDEN(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0xad || c === 0x61c || c === 0x115f || c === 0x1160 || c === 0x17b4 || c === 0x17b5
    || (c >= 0x180b && c <= 0x180e) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f)
    || c === 0x3164 || (c >= 0xfe00 && c <= 0xfe0f) || c === 0xfeff || c === 0xffa0 || (c >= 0xe0000 && c <= 0xe007f);
}

/** Which registry a card comes from, as the trust label: the registry, never the free-text publisher. */
export function registryLabel(registry: string): string {
  return registry === 'marketplace' ? 'Octipus marketplace' : `Registry: ${registry}`;
}

/** Where an installed package came from, in words. */
export function originLabel(origin: { source: string; registry?: string | null } | null): string {
  if (!origin) return 'installed before provenance was recorded';
  if (origin.source === 'marketplace') return 'From the Octipus marketplace';
  if (origin.source.startsWith('registry:')) return `From the registry ${origin.source.slice('registry:'.length)}`;
  if (origin.source === 'agent') return 'Authored by an agent';
  if (origin.source === 'bundled') return 'Shipped with Octipus';
  if (origin.source === 'url') return 'From a URL';
  return 'From a directory';
}

/**
 * The image map of a listing's README: an image the README names is shown
 * only when it is one of the listing's own assets (its icon or a
 * screenshot), and then only through the proxy URL the host returned for it.
 * Nothing here builds a URL: it only looks up the ones given.
 */
export function listingImages(proxied: ReadonlyArray<string | null>): (src: string) => string | null {
  const byOriginal = new Map<string, string>();
  for (const url of proxied) {
    if (!url || !url.startsWith('/api/plugin-packages/marketplace/asset?')) continue;
    const original = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('url');
    if (original) byOriginal.set(original, url);
  }
  return (src) => byOriginal.get(src) ?? null;
}
export const PLUGIN_REGISTRY_KEY = ['admin', 'plugin-packages', 'registry'] as const;
export const PLUGIN_BUNDLED_KEY = ['admin', 'plugin-packages', 'bundled'] as const;

/** What POST /api/plugin-packages answers. */
export interface PluginInstallResult {
  name: string;
  version: string;
  enabled: boolean;
  signedBy: string | null;
  warnings?: string[];
}
