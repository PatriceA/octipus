/**
 * Installing a package from a registry by name (docs/PLUGIN-PACKAGES.md#marketplace):
 * `POST /api/plugin-packages { registry, name, version? }` and
 * `octi plugin install <name>`.
 *
 * The listing is taken from the registry's verified index (the marketplace's:
 * signed by a signing key its root-signed keys.json endorses), then the
 * tarball is installed like any remote install (sha256 before unpacking,
 * the strict tar reader, the staged copy) with what the listing promised
 * checked on the staged copy:
 *
 * - name and version;
 * - the content hash (`contentHash`);
 * - the permissions, recomputed from the downloaded manifest
 *   (`computePermissions`), deeply equal to the listing's: a listing can
 *   never understate what a package asks for;
 * - for the marketplace, a valid signature by one of its endorsed signing
 *   keys (its keys alone), and the `package` runtime (the sandbox).
 *
 * Any difference refuses the install, with an audit row. A version revoked,
 * or written for a plugin API this host does not read, is refused. A version
 * that needs a newer Octipus (`minOctipus`) installs only with the admin's
 * `allowIncompatible`. Everything else is guidance (`guidance`), never a
 * refusal. The package lands disabled, as every install.
 */
import { getDb } from '@/db/postgres';
import { pluginPackages } from '@/db/schema/plugin-packages';
import { type PluginGuidanceWarning, permissionsGuidance } from '@/shared/plugin-declarations';
import { eq } from 'drizzle-orm';
import { getAppVersion } from '@/utils/version';
import type { IndexEntry } from './index-v2';
import { apiVersionProblem } from './manifest';
import { MARKETPLACE_REGISTRY } from './marketplace-config';
import { compatibility, newestInstallable, originSource, revokedVersions, sourceByName } from './marketplace';
import { downloadPackage, readIndex, remoteInstallOptions } from './remote';
import { compareVersions, type InstallOptions, installFromDirectory, PluginPackageError, sourceClass } from './service';
import type { PluginPackageRow } from '@/db/schema/plugin-packages';

export interface RegistryInstallRequest {
  /** `marketplace`, or a registry name of `plugins.registries`. */
  registry: string;
  name: string;
  /** A listed version; default: the newest that can be installed here. */
  version?: string;
  upgrade?: boolean;
  allowSignerChange?: boolean;
  allowDowngrade?: boolean;
  /** The admin consents to taking the package from another source than the installed version's (audited). */
  allowSourceChange?: boolean;
  /** The admin consents to installing a version that asks for a newer Octipus (`minOctipus`). */
  allowIncompatible?: boolean;
}

/** A registry listing resolved for an install: the entry, how to install it, and the guidance. */
export interface ResolvedRegistryInstall {
  entry: IndexEntry;
  /** The install options: what the listing promised, the provenance, whose keys count, the runtime. */
  options: InstallOptions;
  /** Set when the version needs a newer Octipus (`minOctipus`): the admin's call, not a boundary. */
  incompatible: string | null;
  /** The tarball must be on the registry's origin, redirects included (a strict registry: the marketplace). */
  sameOrigin: boolean;
  guidance: PluginGuidanceWarning[];
}

/**
 * Find the listing to install and check what is a boundary (a revoked
 * version, another plugin API, an in-process plugin from the marketplace, a
 * strict registry's listing without permissions or content hash). A version
 * that needs a newer Octipus comes back as `incompatible`.
 */
export async function resolveRegistryInstall(req: RegistryInstallRequest): Promise<ResolvedRegistryInstall> {
  const found = await sourceByName(req.registry);
  if ('error' in found) throw new PluginPackageError('invalid', found.error);
  const { source, hooks } = found;
  const result = await readIndex(source, hooks);
  if (!result.fetched) throw new PluginPackageError('invalid', `The registry ${req.registry} cannot be read: ${result.error ?? 'unknown error'}`);
  const listed = result.fetched.index.entries.filter((e) => e.name === req.name);
  if (listed.length === 0) throw new PluginPackageError('not_found', `${req.registry} does not list ${req.name}`);
  // The marketplace's revocations apply to installs from it only.
  const revoked = req.registry === MARKETPLACE_REGISTRY ? await revokedVersions() : new Map<string, string>();
  const appVersion = getAppVersion();
  let entry: IndexEntry | null;
  if (req.version !== undefined) {
    entry = listed.find((e) => e.version === req.version) ?? null;
    if (!entry) throw new PluginPackageError('not_found', `${req.registry} does not list ${req.name} ${req.version} (it lists ${listed.map((e) => e.version).join(', ')})`);
  } else {
    entry = newestInstallable(listed, revoked, appVersion)
      ?? [...listed].sort((a, b) => compareVersions(b.version, a.version)).find((e) => !revoked.has(`${e.name}@${e.version}`) && (e.apiVersion === null || apiVersionProblem(e.apiVersion) === null)) ?? null;
    if (!entry) throw new PluginPackageError('invalid', `No version of ${req.name} in ${req.registry} can be installed here (every one is revoked or written for another plugin API)`);
  }
  const reason = revoked.get(`${entry.name}@${entry.version}`);
  if (reason) throw new PluginPackageError('invalid', `${entry.name} ${entry.version} is revoked by the marketplace (${reason}); not installed`);
  const compat = compatibility(entry, appVersion);
  let incompatible: string | null = null;
  if (!compat.ok) {
    // Only minOctipus is the admin's call; another plugin API, or an in-process plugin from the marketplace, is a boundary.
    const onlyVersion = entry.minOctipus !== null && compareVersions(appVersion, entry.minOctipus) < 0
      && compatibility({ ...entry, minOctipus: null }, appVersion).ok;
    if (!onlyVersion) throw new PluginPackageError('invalid', `${compat.reason}; not installed`);
    incompatible = compat.reason ?? `Needs Octipus ${entry.minOctipus} or newer`;
  }
  const marketplace = req.registry === MARKETPLACE_REGISTRY;
  if (source.strict && (entry.permissions === null || entry.contentHash === null)) {
    throw new PluginPackageError('invalid', `The listing of ${entry.name} ${entry.version} states no permissions or content hash; not installed`);
  }
  const [current] = await getDb().select({ origin: pluginPackages.origin, version: pluginPackages.version }).from(pluginPackages).where(eq(pluginPackages.name, entry.name)).limit(1);
  const origin = {
    source: originSource(req.registry), registry: marketplace ? 'Octipus' : req.registry, url: entry.url,
    listingVersion: entry.version, indexGeneratedAt: result.fetched.index.generatedAt?.toISOString() ?? null,
  };
  const options = remoteInstallOptions(entry.url, {
    name: entry.name, version: entry.version,
    upgrade: req.upgrade, allowSignerChange: req.allowSignerChange, allowDowngrade: req.allowDowngrade,
    registry: {
      expectListing: { contentHash: entry.contentHash, permissions: entry.permissions },
      origin,
      ...(marketplace ? { trustOnly: source.publishers, requireRuntime: 'package' as const } : {}),
      allowSourceChange: req.allowSourceChange,
    },
  });
  const guidance: PluginGuidanceWarning[] = [
    ...(entry.permissions ? permissionsGuidance(entry.permissions) : [{ code: 'no_permissions_listed', message: 'This registry does not list what the package asks for (index v1); read what it declares before you agree.' }]),
    ...(entry.deprecated ? [{ code: 'deprecated', message: `Deprecated: ${entry.deprecated}` }] : []),
    ...(incompatible ? [{ code: 'incompatible', message: incompatible }] : []),
    ...(current && sourceClass(current.origin) !== sourceClass(origin) ? [{ code: 'source_change', message: `The source changed from ${sourceClass(current.origin)} to ${sourceClass(origin)} (recorded in the audit log)` }] : []),
  ];
  return { entry, options, incompatible, guidance, sameOrigin: source.strict === true };
}

/** Install `name` from a registry. Returns the row, the signature warnings, and the guidance for the admin. */
export async function installFromRegistry(
  actorUserId: string, req: RegistryInstallRequest,
): Promise<PluginPackageRow & { warnings: string[]; guidance: PluginGuidanceWarning[]; listing: IndexEntry }> {
  const resolved = await resolveRegistryInstall(req);
  if (resolved.incompatible && req.allowIncompatible !== true) {
    throw new PluginPackageError('conflict', `${resolved.incompatible}. Confirm to install it anyway (allowIncompatible: true)`);
  }
  const { entry } = resolved;
  const download = await downloadPackage(entry.url, entry.sha256, { sameOrigin: resolved.sameOrigin });
  let row: PluginPackageRow & { warnings: string[] };
  try {
    row = await installFromDirectory(download.root, actorUserId, resolved.options);
  } finally {
    await download.cleanup();
  }
  const guidance: PluginGuidanceWarning[] = [
    ...resolved.guidance,
    { code: 'review_before_enabling', message: 'Installed disabled: review what it declares, approve it and enable it on the Plugin packages page.' },
  ];
  return { ...row, guidance, listing: entry };
}
