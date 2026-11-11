/**
 * One install consent, item by item, bound to the content
 * (docs/PLUGIN-PACKAGES.md#installing-and-managing).
 *
 * `previewInstall` downloads and verifies a package exactly as an install
 * does (the same staging code: the signature, the listing's permissions and
 * content hash, revocation, runtime, the tree) and keeps the checked copy in
 * a preview area outside the plugin store, without installing it. It answers
 * with what the package declares, item by item (`declarationItems`), the
 * guidance for each, and for an upgrade which items are unchanged from the
 * installed version and covered by its consent (`carried`).
 *
 * `installPreview` installs that copy only if the admin agreed to every item
 * that is not carried, the copy still hashes to the content hash they saw,
 * the declarations recomputed from it are the ones they saw, and the
 * installed version is still the one the preview compared against. The
 * install re-runs every check on a fresh copy, and records every approval
 * the items stand for (content, contributions hash, host scopes, in-process,
 * model:cli-tools) in the same transaction as the row, for that content hash.
 * One audit row (`consent`) lists the ids agreed to.
 *
 * Previews are single-use, expire after `PREVIEW_TTL_MS`, belong to the admin
 * who made them, and live on this server process: the staged copy is a
 * directory on this instance's disk, so storing the preview in the database
 * would not make it installable elsewhere. An install must reach the
 * instance that made the preview (sticky sessions behind a load balancer);
 * one that reaches another instance is refused (fails closed) and the admin
 * previews again.
 *
 * `consentView` / `consentToInstalled` do the same for a package already
 * installed (an agent's, or one installed before this flow): the
 * declarations of its files as they are, agreed to and enabled in one write;
 * what its recorded approvals already cover for those files is carried.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getConfig } from '@/config';
import type { PluginPackageRow } from '@/db/schema/plugin-packages';
import {
  consentItems,
  declarationItems,
  type PluginConsentItem,
  type PluginConsentResult,
  type PluginConsentView,
  type PluginDeclarationItem,
  type PluginGuidanceWarning,
  type PluginInstallPreview,
  permissionsGuidance,
  requiredConsentIds,
} from '@/shared/plugin-declarations';
import {
  declaresTrustedModelInput,
  PLUGIN_MODEL_CLI_TOOLS_APPROVAL,
  type PluginHostApproval,
  type PluginManifest,
  type PluginOrigin,
  pluginRuntime,
} from '@/shared/plugin-package';
import { diffPermissions } from '@/shared/plugin-permissions';
import { coreLogger } from '@/utils/logger';
import { contributionsHashOf, hasContributions } from './contributions/approval';
import { hashPackageContent } from './integrity';
import { packagePermissions } from './permissions';
import { hostEnforcement, pluginSandboxPlan } from './sandbox-policy';
import {
  audit,
  configure,
  describeUpgradeChange,
  findRow,
  type InstallOptions,
  inProcessApproved,
  installFromDirectory,
  missingConfiguration,
  modelTrustWarnings,
  packageDir,
  PluginPackageError,
  type StagedPackage,
  stagePackage,
  upgradeChanges,
} from './service';

/** How long a preview may be installed. */
export const PREVIEW_TTL_MS = 15 * 60_000;
/** Most previews held at once (each one is a staged package on disk). */
export const MAX_PREVIEWS = 20;

/** What a preview is made from: exactly one source, as `POST /api/plugin-packages` takes it. */
export type PreviewSource =
  | { registry: string; name: string; version?: string }
  | { url: string; sha256?: string; name?: string; version?: string }
  | { path: string }
  | { bundled: string };

interface Preview {
  id: string;
  actorUserId: string;
  expiresAt: number;
  /** The preview's own directory; the staged package is `pkgDir`, inside it. */
  dir: string;
  pkgDir: string;
  options: InstallOptions;
  manifest: PluginManifest;
  contentHash: string;
  /** The base declarations (without `change:*` items), as shown. */
  base: PluginDeclarationItem[];
  items: PluginConsentItem[];
  /** The installed version compared against, or null. */
  baseline: { contentHash: string | null } | null;
  view: PluginInstallPreview;
}

const previews = new Map<string, Preview>();
let swept = false;

/** Where previews are staged: beside the plugin store, never in it. */
export function previewsRoot(): string {
  return join(resolve(getConfig().workspace.rootPath), 'plugin-previews');
}

async function dropPreview(p: Preview): Promise<void> {
  previews.delete(p.id);
  await rm(p.dir, { recursive: true, force: true }).catch((err: unknown) => coreLogger.warn({ err, dir: p.dir }, 'Could not remove a plugin install preview'));
}

/** Remove expired previews, and (once per process) preview directories older than the TTL that no preview holds. */
async function sweep(now = Date.now()): Promise<void> {
  for (const p of [...previews.values()]) if (p.expiresAt <= now) await dropPreview(p);
  if (swept) return;
  swept = true;
  const root = previewsRoot();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name);
    const info = await stat(dir).catch(() => null);
    if (info && now - info.mtimeMs > PREVIEW_TTL_MS) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Test-only: forget every preview (their directories are removed). */
export async function _resetPreviewsForTesting(): Promise<void> {
  for (const p of [...previews.values()]) await dropPreview(p);
  swept = false;
}

/** Test-only: a held preview, to change what it remembers. */
export function _previewForTesting(id: string): { base: PluginDeclarationItem[]; expiresAt: number; pkgDir: string } | null {
  return previews.get(id) ?? null;
}

/** The declarations of a package directory: the base items, from its permissions and manifest, as this host runs a package of `origin`. */
async function baseItems(manifest: PluginManifest, dir: string, origin: PluginOrigin | null | undefined): Promise<PluginDeclarationItem[]> {
  return declarationItems(await packagePermissions(manifest, dir), manifest, hostEnforcement(origin));
}

/**
 * Refuse a consent that would leave a package plugin able to run where its
 * sandbox is required and no runner works (./sandbox-policy.ts): a boundary,
 * not an item to agree to.
 */
function refuseWithoutSandbox(manifest: PluginManifest, origin: PluginOrigin | null | undefined): void {
  if (pluginRuntime(manifest) !== 'package') return;
  const plan = pluginSandboxPlan(origin);
  if (plan.problem) throw new PluginPackageError('incomplete', `${manifest.name} cannot be installed or agreed to here. ${plan.problem}`);
}

/**
 * Which of the installed version's items its consent covered: a host scope
 * or model:cli-tools approved, contributions approved, the in-process
 * approval for its content, and the rest when it was enabled or agreed to at
 * all. Nothing, when its files no longer hash to what was approved.
 */
async function coveredBy(row: PluginPackageRow): Promise<(id: string) => boolean> {
  const now = await hashPackageContent(packageDir(row.name), row).catch(() => null);
  if (row.contentHash === null || now !== row.contentHash) return () => false;
  const scopes = new Set(row.approvedHostScopes ?? []);
  const agreed = row.enabled || row.approvedHostScopes !== null || row.approvedContributionsHash !== null || inProcessApproved(row);
  return (id) => {
    if (id.startsWith('host:')) return (scopes as Set<string>).has(id.slice('host:'.length));
    if (id === PLUGIN_MODEL_CLI_TOOLS_APPROVAL) return (scopes as Set<string>).has(PLUGIN_MODEL_CLI_TOOLS_APPROVAL);
    if (id === 'prompt' || id === 'context' || /^(command|schedule|event):/.test(id)) return row.approvedContributionsHash !== null;
    if (id === 'in-process') return inProcessApproved(row);
    return agreed;
  };
}

/** The install options of a preview source, its guidance, and a version that needs a newer Octipus. */
async function resolveSource(source: PreviewSource): Promise<{ options: InstallOptions; guidance: PluginGuidanceWarning[]; incompatible: string | null; download?: { url: string; sha256?: string; sameOrigin?: boolean }; dir?: string }> {
  if ('registry' in source) {
    const { resolveRegistryInstall } = await import('./registry-install');
    const resolved = await resolveRegistryInstall({ registry: source.registry, name: source.name, version: source.version });
    return { options: resolved.options, guidance: resolved.guidance, incompatible: resolved.incompatible, download: { url: resolved.entry.url, sha256: resolved.entry.sha256, sameOrigin: resolved.sameOrigin } };
  }
  if ('url' in source) {
    const { remoteInstallOptions } = await import('./remote');
    return { options: remoteInstallOptions(source.url, { name: source.name, version: source.version }), guidance: [], incompatible: null, download: { url: source.url, sha256: source.sha256 } };
  }
  if ('bundled' in source) {
    const { bundledDir, installedFromBundle } = await import('./bundled');
    const dir = bundledDir(source.bundled);
    if (!dir) throw new PluginPackageError('not_found', `No bundled plugin named ${JSON.stringify(source.bundled)}`);
    const row = await findRow(source.bundled);
    if (row && !await installedFromBundle(row, dir)) {
      throw new PluginPackageError('conflict', `The name ${source.bundled} is taken by another package, not the bundled one; uninstall it first`);
    }
    return { options: { expect: { name: source.bundled }, source: `bundled:${source.bundled}`, origin: { source: 'bundled' } }, guidance: [], incompatible: null, dir };
  }
  return { options: {}, guidance: [], incompatible: null, dir: source.path };
}

/** A `change:*` item: what an upgrade changes that the admin agrees to like a declaration. */
function changeItem(id: string, label: string, detail: string, guidance: string): PluginDeclarationItem {
  return { id: `change:${id}`, kind: 'change', label, detail, guidance };
}

/**
 * Download (or copy), verify and stage a package for the admin's consent.
 * Everything an install refuses is refused here, the same way; the rest is
 * listed for consent.
 */
export async function previewInstall(source: PreviewSource, actorUserId: string): Promise<PluginInstallPreview> {
  await sweep();
  if (previews.size >= MAX_PREVIEWS) {
    const oldest = [...previews.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
    if (oldest) await dropPreview(oldest);
  }
  const resolved = await resolveSource(source);
  const id = randomUUID();
  const dir = join(previewsRoot(), `${process.pid}-${randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let staged: StagedPackage;
  let options: InstallOptions;
  try {
    let root = resolved.dir;
    let cleanup: (() => Promise<void>) | null = null;
    if (resolved.download) {
      const { downloadPackage } = await import('./remote');
      const download = await downloadPackage(resolved.download.url, resolved.download.sha256, { sameOrigin: resolved.download.sameOrigin === true });
      root = download.root;
      cleanup = download.cleanup;
    }
    try {
      // Name and version are pinned to what was staged: the install must stage the same package.
      staged = await stagePackage(root as string, actorUserId, resolved.options, dir, () => join(dir, 'package'));
    } finally {
      await cleanup?.();
    }
    options = { ...resolved.options, expect: { name: staged.manifest.name, version: staged.manifest.version } };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const { manifest, contentHash, signature } = staged;
  const origin: PluginOrigin = options.origin ?? { source: 'directory' };
  const permissions = await packagePermissions(manifest, staged.dir);
  const base = declarationItems(permissions, manifest, hostEnforcement(origin));
  const current = await findRow(manifest.name);
  const changes: PluginDeclarationItem[] = [];
  let before: PluginDeclarationItem[] | null = null;
  let covered: (id: string) => boolean = () => false;
  let diff = null;
  if (current) {
    const installedPerms = await packagePermissions(current.manifest, packageDir(current.name));
    before = declarationItems(installedPerms, current.manifest, hostEnforcement(current.origin));
    covered = await coveredBy(current);
    diff = diffPermissions(installedPerms, permissions);
    const change = await upgradeChanges(current, staged, origin);
    const said = describeUpgradeChange(manifest.name, current, change, origin);
    if (said.sourceChange) changes.push(changeItem('source', 'Comes from another source', said.sourceChange, 'Another registry, or the marketplace, takes over this package. Recorded in the audit log.'));
    if (said.signerChange) changes.push(changeItem('signer', 'Signed by another publisher', said.signerChange, 'Who vouches for these bytes changes. Recorded in the audit log.'));
    if (said.downgrade) changes.push(changeItem('downgrade', 'Installs an older version', said.downgrade, 'An older version may lack fixes the installed one has. Recorded in the audit log.'));
  }
  if (resolved.incompatible) changes.push(changeItem('incompatible', 'Asks for a newer Octipus', resolved.incompatible, 'It may not work here as its publisher intends.'));
  const items = consentItems([...base, ...changes], before, covered);
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  const guidance: PluginGuidanceWarning[] = [
    ...(resolved.guidance.length > 0 ? resolved.guidance : permissionsGuidance(permissions)),
    ...signature.warnings.map((message) => ({ code: 'signature', message })),
    ...modelTrustWarnings(manifest).map((message) => ({ code: 'model_cli_tools', message })),
  ];
  const view: PluginInstallPreview = {
    previewId: id, name: manifest.name, version: manifest.version, title: manifest.title, contentHash, signedBy: signature.signedBy, origin,
    declarations: items, guidance, diff, upgradeFrom: current?.version ?? null, expiresAt: new Date(expiresAt).toISOString(),
  };
  previews.set(id, {
    id, actorUserId, expiresAt, dir, pkgDir: staged.dir, options, manifest, contentHash, base, items,
    baseline: current ? { contentHash: current.contentHash } : null, view,
  });
  return view;
}

/** Strip what a client's copy of an item may differ in, to compare declarations. */
const comparable = (items: readonly PluginDeclarationItem[]) => JSON.stringify(items.map(({ id, kind, label, detail, guidance }) => ({ id, kind, label, detail, guidance: guidance ?? null })));

/** The approvals every item of `manifest` stands for, read from the staged copy. */
async function approvalsOf(staged: StagedPackage): Promise<{ hostScopes: PluginHostApproval[]; contributionsHash: string | null; inProcessHash: string | null }> {
  const m = staged.manifest;
  return {
    hostScopes: [...(m.host ?? []), ...(declaresTrustedModelInput(m) ? [PLUGIN_MODEL_CLI_TOOLS_APPROVAL] : [])] as PluginHostApproval[],
    contributionsHash: hasContributions(m) ? await contributionsHashOf(m, staged.dir) : null,
    inProcessHash: pluginRuntime(m) === 'in-process' ? staged.contentHash : null,
  };
}

/** Refuse unless `accepted` holds every id of `required`. */
function checkAccepted(required: readonly string[], accepted: readonly string[]): void {
  const agreed = new Set(accepted);
  const missing = required.filter((id) => !agreed.has(id));
  if (missing.length > 0) {
    throw new PluginPackageError('incomplete', `Agree to every item before installing: ${missing.join(', ')} not agreed`, missing.map((id) => `${id}: not agreed`));
  }
}

/** Enable `name` after a consent when asked, unless a required setting or secret is missing (then say which). */
async function enableAfter(name: string, enable: boolean, actorUserId: string): Promise<{ enabled: boolean; enableProblem: string | null }> {
  if (!enable) return { enabled: false, enableProblem: null };
  const row = await findRow(name);
  if (!row) return { enabled: false, enableProblem: 'Not installed' };
  const missing = await missingConfiguration(row);
  if (missing.length > 0) return { enabled: false, enableProblem: `Set ${missing.join(', ')} before enabling it` };
  try {
    await configure(name, { enabled: true }, actorUserId);
    return { enabled: true, enableProblem: null };
  } catch (err) {
    if (err instanceof PluginPackageError) return { enabled: false, enableProblem: err.message };
    throw err;
  }
}

/**
 * Install a preview with the admin's consent: `contentHash` is the hash they
 * saw, `accepted` the ids they agreed to (every item not carried).
 */
export async function installPreview(
  previewId: string, req: { contentHash: string; accepted: readonly string[]; enable?: boolean }, actorUserId: string,
): Promise<PluginConsentResult> {
  await sweep();
  const preview = previews.get(previewId);
  if (!preview || preview.actorUserId !== actorUserId || preview.expiresAt <= Date.now()) {
    // Behind a load balancer without sticky sessions the install can reach another instance than the preview: it then fails closed here.
    throw new PluginPackageError('not_found', 'No such install preview: it expired, was used, belongs to someone else, or was made on another server instance. Preview the package again');
  }
  if (req.contentHash !== preview.contentHash) {
    throw new PluginPackageError('conflict', `You agreed to ${req.contentHash}, but this preview is ${preview.contentHash}; preview the package again`);
  }
  checkAccepted(requiredConsentIds(preview.items), req.accepted);
  refuseWithoutSandbox(preview.manifest, preview.options.origin);
  // Single use: from here on the preview is spent, whatever happens.
  previews.delete(preview.id);
  const accepted = new Set(req.accepted);
  try {
    const row = await installFromDirectory(preview.pkgDir, actorUserId, {
      ...preview.options,
      upgrade: preview.baseline !== null,
      allowSourceChange: accepted.has('change:source'),
      allowSignerChange: accepted.has('change:signer'),
      allowDowngrade: accepted.has('change:downgrade'),
      consent: {
        contentHash: preview.contentHash,
        baseline: preview.baseline,
        verify: async (staged) => {
          const now = await baseItems(staged.manifest, staged.dir, preview.options.origin);
          if (comparable(now) !== comparable(preview.base)) {
            throw new PluginPackageError('conflict', `What ${staged.manifest.name} declares is not what you agreed to; not installed. Preview it again`);
          }
        },
        approvals: approvalsOf,
      },
    });
    await audit(actorUserId, 'consent', row.name, {
      version: row.version, contentHash: row.contentHash, previewId: preview.id, accepted: [...accepted].sort(),
      carried: preview.items.filter((i) => i.carried).map((i) => i.id), upgradeFrom: preview.view.upgradeFrom,
    });
    const { enabled, enableProblem } = await enableAfter(row.name, req.enable === true, actorUserId);
    return { name: row.name, version: row.version, contentHash: row.contentHash ?? preview.contentHash, enabled, enableProblem, warnings: row.warnings };
  } finally {
    await rm(preview.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The declarations of an installed package's files as they are now, for the admin to agree to before enabling it. */
export async function consentView(name: string): Promise<PluginConsentView> {
  const row = await findRow(name);
  if (!row) throw new PluginPackageError('not_found', `Plugin package not found: ${name}`);
  const dir = packageDir(name);
  const contentHash = await hashPackageContent(dir, row);
  const permissions = await packagePermissions(row.manifest, dir);
  const covered = contentHash === row.contentHash ? await coveredBy(row) : () => false;
  return {
    name, version: row.version, title: row.manifest.title, contentHash, signedBy: row.signedBy, origin: row.origin ?? null, enabled: row.enabled,
    // What its consent already covers for exactly these files (approved scopes, contributions, in-process) is carried.
    declarations: (() => {
      const items = declarationItems(permissions, row.manifest, hostEnforcement(row.origin));
      return consentItems(items, items, covered);
    })(),
    guidance: [...permissionsGuidance(permissions), ...modelTrustWarnings(row.manifest).map((message) => ({ code: 'model_cli_tools', message }))],
  };
}

/**
 * Agree to an installed package's declarations, for the content hash shown,
 * and (with `enable`) enable it: content, contributions, host scopes,
 * model:cli-tools and in-process approved in one write (`configure`), which
 * refuses files that no longer hash to `contentHash`.
 */
export async function consentToInstalled(
  name: string, req: { contentHash: string; accepted: readonly string[]; enable?: boolean }, actorUserId: string,
): Promise<PluginConsentResult> {
  const view = await consentView(name);
  if (view.contentHash !== req.contentHash) {
    throw new PluginPackageError('conflict', `The files of ${name} hash to ${view.contentHash}, not to the ${req.contentHash} you agreed to: they changed; review them again`, undefined, { actualHash: view.contentHash });
  }
  checkAccepted(requiredConsentIds(view.declarations), req.accepted);
  const row = await findRow(name);
  if (!row) throw new PluginPackageError('not_found', `Plugin package not found: ${name}`);
  refuseWithoutSandbox(row.manifest, row.origin);
  const m = row.manifest;
  const missing = req.enable === true ? await missingConfiguration(row) : [];
  const enable = req.enable === true && missing.length === 0;
  const contributionsHash = hasContributions(m) ? await contributionsHashOf(m, packageDir(name)) : null;
  await configure(name, {
    approveContent: req.contentHash,
    approveHostScopes: [...(m.host ?? []), ...(declaresTrustedModelInput(m) ? [PLUGIN_MODEL_CLI_TOOLS_APPROVAL] : [])] as PluginHostApproval[],
    ...(contributionsHash ? { approveContributions: contributionsHash } : {}),
    ...(pluginRuntime(m) === 'in-process' ? { approveInProcess: req.contentHash } : {}),
    ...(enable ? { enabled: true } : {}),
  }, actorUserId);
  await audit(actorUserId, 'consent', name, { version: row.version, contentHash: req.contentHash, accepted: [...new Set(req.accepted)].sort(), carried: [], installed: true });
  const after = await findRow(name);
  return {
    name, version: row.version, contentHash: req.contentHash, enabled: after?.enabled ?? false,
    enableProblem: req.enable === true && missing.length > 0 ? `Set ${missing.join(', ')} before enabling it` : null, warnings: [],
  };
}
