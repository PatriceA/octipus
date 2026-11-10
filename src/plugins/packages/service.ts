/**
 * Plugin packages (docs/PLUGIN-PACKAGES.md): installing, enabling,
 * configuring and running them.
 *
 * A package is a directory with an `octipus-plugin.json` manifest and a local
 * MCP server. Installing copies it into the plugin directory
 * (`<workspace.rootPath>/plugin-packages/<name>`) and records the manifest as
 * checked; it starts disabled, so an admin reads what it declares — its tools
 * and their effects, the hosts it talks to, the protection level of data it
 * may see — before it runs.
 *
 * An enabled package runs as an MCP server of the bridge, `plugin-<name>`:
 *
 * - in its own directory, with only a minimal host environment plus its
 *   settings (`OCTIPUS_SETTING_<KEY>`) and its secrets (vault system rows
 *   `plugin:<name>:<KEY>`, handed over under their own key) — no provider
 *   key, master key or database URL of the host;
 * - in the shell sandbox when `security.shellSandbox` is on, with its
 *   directory read-only, its data directory (`pluginDataDir`,
 *   `OCTIPUS_PLUGIN_DATA_DIR`) as the only writable one and no direct
 *   network; a package that declares hosts reaches only those, through a
 *   per-package egress proxy
 *   (src/security/egress-proxy.ts). Without a sandbox (off, no runner, macOS,
 *   Windows) the proxy is advisory and the status says "not enforced";
 * - with only its declared tools reachable, each permitted by its declared
 *   effect (src/security/mcp-authorization.ts).
 *
 * Every change re-syncs the bridge (`syncPluginServers`), which restarts the
 * package's server when its config changed.
 *
 * The files are pinned (./integrity.ts): install, upgrade and content approval
 * record a hash of the package directory, and every start of its server
 * recomputes it; a package modified since then does not start until an admin
 * approves its content (`configure` with `approveContent`: the hash the
 * admin reviewed, accepted only while the files still hash to it).
 *
 * A package may be signed (./signature.ts): Ed25519 over its content hash,
 * by a key in `plugins.trustedPublishers`. Install and upgrade refuse an
 * invalid signature and record who signed (`signedBy`); with
 * `plugins.requireSignature` they also refuse an unsigned package or an
 * unknown key, and so do content approval, enabling and every start. The
 * signature file is outside the content hash, so it is pinned on its own:
 * only its canonical form is accepted, and the sha256 of its bytes
 * (`signatureHash`) is recorded with the content hash and compared at every
 * start, whatever `requireSignature` says.
 */
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { getConfig } from '@/config';
import { RecordValidationError, validateRecordData } from '@/core/records/fields';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { type PluginPackageRow, pluginPackages } from '@/db/schema/plugin-packages';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { activeSandboxRunner, getSandboxMode } from '@/security/shell-sandbox';
import { SYSTEM_USER_ID } from '@/security/principal';
import { getVault } from '@/security/vault';
import type { MCPServer } from '@/shared/mcp-server';
import {
  declaresTrustedModelInput,
  MODEL_CLI_TOOLS_WARNING,
  modelCliToolsSourcesWarning,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MODEL_CLI_TOOLS_APPROVAL,
  type PluginHostApproval,
  type PluginHostScope,
  type PluginModelCliToolsView,
  type PluginAgentAuthorship,
  type PluginInProcessStatus,
  type PluginManifest,
  type PluginRuntime,
  type PluginNetworkStatus,
  type PluginOrigin,
  type PluginPackageView,
  type PluginPermissionsSummary,
  type PluginRevocationView,
  type PluginSignatureStatus,
  pluginRuntime,
} from '@/shared/plugin-package';
import { declarationItems } from '@/shared/plugin-declarations';
import { octipusRoot } from '@/utils/install-root';
import { coreLogger } from '@/utils/logger';
import { type AgentAuthoredDetails, agentAuthorship, agentAuthorships } from './authoring/authorship';
import { contributionInstallProblems, contributionsView, syncContributions } from './contributions';
import { checkInProcessBundle } from './in-process-bundle';
import { contributionsHashOf, hasContributions } from './contributions/approval';
import { CONTENT_MISMATCH_PROBLEM, hashPackageContent, isContentHash, LISTING_FILE, verifyPackageContent } from './integrity';
import { ManifestError, parseManifest, settingEnvName } from './manifest';
import { computePermissions, defaultMaxProtection } from './permissions';
import { checkSignatureOnDisk, keyFingerprint, parsePublicKey, readSignatureFile, SIGNATURE_FILE, type SignatureCheck, SignatureError, type TrustedPublisher } from './signature';
import { keyRevocation, packageRevocation, revokedKeyIds } from './revocations';
import { checkPackageTree, PackageTreeError } from './tree';
import { HOST_API_URL, hostApiTarget, isHostScope, issueHostCallMeta, revokePluginTokens } from './host-api';

export class PluginPackageError extends Error {
  constructor(
    readonly code: 'not_found' | 'exists' | 'invalid' | 'incomplete' | 'conflict',
    message: string,
    readonly problems: string[] = [message],
    /** What the refusal knows that a client can act on, e.g. the `actualHash` to review and approve. */
    readonly details: { actualHash?: string; contributionsHash?: string; sourceChange?: { from: string; to: string } } = {},
  ) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

/**
 * Compare two semantic versions (`1.2.0`, `1.2.0-beta.1`): negative when `a`
 * is older. A pre-release is older than its release; pre-release identifiers
 * compare numerically when both are numbers, else as text.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = a.split(/-(.*)/s, 2);
  const [coreB, preB] = b.split(/-(.*)/s, 2);
  const na = coreA.split('.').map(Number);
  const nb = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  const pa = preA.split('.');
  const pb = preB.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    if (pa[i] === pb[i]) continue;
    const xa = /^\d+$/.test(pa[i]) ? Number(pa[i]) : null;
    const xb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : null;
    if (xa !== null && xb !== null) return xa - xb;
    if (xa !== null) return -1;
    if (xb !== null) return 1;
    return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Where installed packages live. */
export function pluginsRoot(): string {
  return join(resolve(getConfig().workspace.rootPath), 'plugin-packages');
}

/**
 * Refuse a plugin store or data directory inside `<install>/plugins`, where
 * only the plugins Octipus ships live (a misconfigured `workspace.rootPath`):
 * an installed or local plugin never lands in the install or the repository.
 */
export function assertStoreOutsideInstall(): void {
  let shippedDir: string;
  try {
    shippedDir = join(octipusRoot(), 'plugins');
  } catch {
    return;
  }
  for (const dir of [pluginsRoot(), join(resolve(getConfig().workspace.rootPath), 'plugin-data')]) {
    const rel = relative(shippedDir, dir);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      throw new PluginPackageError('invalid', `The plugin store ${dir} is inside ${shippedDir}, where only the plugins Octipus ships live: set workspace.rootPath to a directory outside the Octipus install`);
    }
  }
}

/** The directory of one installed package. */
export function packageDir(name: string): string {
  return join(pluginsRoot(), name);
}

/**
 * The writable data directory of one installed package, outside its files
 * (which are read-only in the sandbox and pinned by hash). Handed to the
 * server as `OCTIPUS_PLUGIN_DATA_DIR`; created when the server starts.
 */
export function pluginDataDir(name: string): string {
  return join(resolve(getConfig().workspace.rootPath), 'plugin-data', name);
}

/**
 * Where the egress proxies put their Unix sockets: under the workspace, which
 * both sandbox runners mount by path — not /tmp, which firejail's
 * `--private-tmp` hides.
 */
function pluginRunDir(): string {
  return join(resolve(getConfig().workspace.rootPath), 'plugin-run');
}

/** The vault name of one of a package's secrets. */
export function secretName(pkg: string, key: string): string {
  return `plugin:${pkg}:${key}`;
}

/** Read and check the manifest of a package directory. */
export async function readManifest(dir: string): Promise<PluginManifest> {
  let raw: string;
  try {
    raw = await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8');
  } catch (err) {
    throw new PluginPackageError('invalid', `No ${PLUGIN_MANIFEST_FILE} in ${dir}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new PluginPackageError('invalid', `${PLUGIN_MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parseManifest(json);
  } catch (err) {
    if (err instanceof ManifestError) throw new PluginPackageError('invalid', `${PLUGIN_MANIFEST_FILE} does not fit the contract`, err.problems);
    throw err;
  }
}

/** The tree check of ./tree.ts, as an install refusal. */
async function checkTree(dir: string): Promise<void> {
  try {
    await checkPackageTree(dir);
  } catch (err) {
    if (err instanceof PackageTreeError) throw new PluginPackageError('invalid', err.message);
    throw err;
  }
}

async function findRow(name: string): Promise<PluginPackageRow | null> {
  const [row] = await getDb().select().from(pluginPackages).where(eq(pluginPackages.name, name)).limit(1);
  return row ?? null;
}

async function requireRow(name: string): Promise<PluginPackageRow> {
  const row = await findRow(name);
  if (!row) throw new PluginPackageError('not_found', `Plugin package not found: ${name}`);
  return row;
}

/** Whether `plugins.requireSignature` is on, read at each check. */
function signatureRequired(): boolean {
  return getConfig().plugins?.requireSignature === true;
}

/** Key ids of `trustedPublishers` entries marked `revoked`, so they stay revoked in a ring built without those entries. */
function configRevokedKeyIds(publishers: readonly TrustedPublisher[]): string[] {
  const out: string[] = [];
  for (const p of publishers) {
    if (p.revoked !== true) continue;
    try {
      out.push(keyFingerprint(parsePublicKey(p.publicKey)));
    } catch {
      // An unreadable key trusts nothing anyway (trustedKeys reports it).
    }
  }
  return out;
}

/**
 * The signing policy in force, read at each check so a config change (a
 * revoked key, say) applies to the next one (docs/PLUGIN-PACKAGES.md#signed-packages):
 *
 * - **Publishers.** `plugins.trustedPublishers`; for a package installed from
 *   the marketplace (`origin.source === 'marketplace'`) the marketplace's
 *   signing keys too (its last accepted keys.json, re-verified against the
 *   root keys), while the marketplace is configured. They are trusted for nothing
 *   else. `only` replaces the list (an install from the marketplace accepts
 *   its keys alone).
 * - **Revoked keys.** `plugins.revokedKeys`, the keys of revoked
 *   `trustedPublishers` entries, and the keys the marketplace's signed index
 *   revoked (./revocations.ts, kept in the database). A database that cannot
 *   be read refuses the check (it throws): never trust on a guess.
 */
async function signingPolicy(origin?: PluginOrigin | null, only?: readonly TrustedPublisher[]): Promise<{ publishers: readonly TrustedPublisher[]; revokedKeys: readonly string[]; required: boolean }> {
  const plugins = getConfig().plugins;
  const config = plugins?.trustedPublishers ?? [];
  let publishers: readonly TrustedPublisher[] = only ?? config;
  if (!only && origin?.source === 'marketplace') {
    // The marketplace's signing keys as last accepted (re-verified against its root keys), never its root keys.
    const { persistedSigningPublishers } = await import('./marketplace-keys-file');
    publishers = [...config, ...await persistedSigningPublishers()];
  }
  const revokedKeys = [...new Set([...(plugins?.revokedKeys ?? []), ...configRevokedKeyIds(config), ...await revokedKeyIds()])];
  return { publishers, revokedKeys, required: signatureRequired() };
}

/**
 * The signature file of a package directory: the sha256 of its bytes (null:
 * none), its check against `contentHash` and the trusted publishers, and why
 * it is refused outright when it is not in the canonical form (`malformed`).
 */
interface SignatureState {
  sha256: string | null;
  check: SignatureCheck;
  malformed: string | null;
}

async function signatureState(dir: string, contentHash: string, origin?: PluginOrigin | null, only?: readonly TrustedPublisher[]): Promise<SignatureState> {
  const policy = await signingPolicy(origin, only);
  try {
    const onDisk = await readSignatureFile(dir);
    const check = checkSignatureOnDisk(onDisk, contentHash, policy.publishers, (publisher, reason) => {
      coreLogger.warn({ publisher, reason }, 'A key in plugins.trustedPublishers cannot be read; it trusts nothing');
    }, { revokedKeys: policy.revokedKeys });
    return { sha256: onDisk?.sha256 ?? null, check, malformed: null };
  } catch (err) {
    if (err instanceof SignatureError) return { sha256: null, check: { status: 'invalid', reason: err.message }, malformed: err.message };
    throw err;
  }
}

/** The problem shown for a package whose signature file changed since its content was approved. */
export const SIGNATURE_FILE_CHANGED_PROBLEM = `${SIGNATURE_FILE} changed since the content was approved; approve its content to run it`;

/** Why a signature check does not give a trusted signature, in words. */
function signatureShortfall(name: string, check: Exclude<SignatureCheck, { status: 'valid' }>): string {
  switch (check.status) {
    case 'unsigned': return `${name} is not signed (no ${SIGNATURE_FILE})`;
    case 'unknown_key': return `${name} is signed by a key that is not in plugins.trustedPublishers (${check.keyId})`;
    case 'revoked': return `${name} is signed by a revoked key: ${check.detail}`;
    case 'expired': return `${name} is signed by an expired key: ${check.detail}`;
    case 'invalid': return `The signature of ${name} is invalid: ${check.reason}`;
  }
}

/**
 * The signature of files about to be installed: who signed them, or the
 * refusal. An invalid signature, or one by a revoked key, is always refused;
 * unsigned files, an unknown key or an expired one are refused under
 * `plugins.requireSignature` (or `requireTrusted`, a remote install) and
 * otherwise installed as unsigned (an unknown or expired key with a warning).
 */
async function acceptSignature(
  dir: string,
  name: string,
  contentHash: string,
  requireTrusted = false,
  only?: readonly TrustedPublisher[],
): Promise<{ signedBy: string | null; keyId: string | null; signatureHash: string | null; warnings: string[] }> {
  const state = await signatureState(dir, contentHash, null, only);
  const { check, sha256: signatureHash } = state;
  if (check.status === 'valid') return { signedBy: check.publisher, keyId: check.keyId, signatureHash, warnings: [] };
  const shortfall = signatureShortfall(name, check);
  if (check.status === 'invalid' || check.status === 'revoked') throw new PluginPackageError('invalid', `${shortfall}; not installed`);
  if (requireTrusted) throw new PluginPackageError('invalid', `${shortfall}; a package installed from a URL must carry a valid signature by a trusted publisher`);
  if (signatureRequired()) throw new PluginPackageError('invalid', `${shortfall}; plugins.requireSignature accepts only packages signed by a trusted publisher`);
  if (check.status === 'unknown_key' || check.status === 'expired') {
    coreLogger.warn({ pkg: name, keyId: check.keyId, status: check.status }, 'Plugin package signed by an untrusted key; installed as unsigned');
    return { signedBy: null, keyId: check.keyId, signatureHash, warnings: [`${shortfall}: installed as unsigned`] };
  }
  return { signedBy: null, keyId: null, signatureHash, warnings: [] };
}

/**
 * Whether an upgrade changes who signed the package: the installed version's
 * key (from its approved signature file; by publisher name when that file is
 * gone) against the new one's. Null when the installed version was not
 * signed by a trusted publisher, or the key is the same.
 */
async function signerChange(
  current: PluginPackageRow,
  next: { signedBy: string | null; keyId: string | null },
): Promise<{ from: string; to: string | null; fromKeyId: string | null; toKeyId: string | null } | null> {
  if (current.signedBy === null) return null;
  const onDisk = await readSignatureFile(packageDir(current.name)).catch(() => null);
  const fromKeyId = onDisk && onDisk.sha256 === current.signatureHash ? onDisk.file.keyId : null;
  const toKeyId = next.signedBy !== null ? next.keyId : null;
  const same = fromKeyId !== null ? fromKeyId === toKeyId : next.signedBy === current.signedBy;
  return same ? null : { from: current.signedBy, to: next.signedBy, fromKeyId, toKeyId };
}

/**
 * Leave the marketplace listing file (`marketplace.json` in the package root)
 * out of a staged copy: it is listing metadata, not package content, and a
 * source hash leaves it out (./integrity.ts), so what is installed is exactly
 * what was hashed and signed. Only a regular file is listing metadata; a
 * directory or anything else of that name stays and counts.
 */
async function dropListingFile(staging: string): Promise<void> {
  const path = join(staging, LISTING_FILE);
  if ((await lstat(path).catch(() => null))?.isFile()) await rm(path);
}

/** JSON with sorted object keys, so equal objects compare equal whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The source an upgrade must keep (docs/PLUGIN-PACKAGES.md#provenance): the
 * marketplace, or one named registry. Direct installs an admin points at
 * (a directory, a URL, a bundled plugin, an agent's directory) and packages
 * installed before provenance was recorded are one class, `direct`: moving
 * between them is the admin's own doing, as before. Moving to or from a
 * registry needs `allowSourceChange`.
 */
export function sourceClass(origin: PluginOrigin | null | undefined): string {
  const source = origin?.source;
  if (source === 'marketplace' || (typeof source === 'string' && source.startsWith('registry:'))) return source;
  return 'direct';
}

function describeSource(origin: PluginOrigin | null | undefined): string {
  if (!origin) return 'an install made before provenance was recorded';
  if (origin.source === 'marketplace') return 'the Octipus marketplace';
  if (origin.source.startsWith('registry:')) return `the registry ${origin.source.slice('registry:'.length)}`;
  return `a ${origin.source} install`;
}

/**
 * Install a package from a local directory. With `upgrade`, an installed
 * package of the same name is replaced: its settings stay, and it is disabled
 * until an admin enables the new version (its tools may have changed).
 *
 * The row is claimed before any file moves: a new name is inserted first (a
 * concurrent install of the same name gets `exists`), and an upgrade is
 * disabled first, so a failure partway never leaves an enabled row whose old
 * manifest governs new code.
 *
 * The files are hashed in the staging copy, before they replace anything
 * (the hash depends only on paths relative to the package root), and the row
 * — new manifest, version and hash — is written in the same transaction that
 * swaps the files in: if either fails, the old files and the old row stay
 * together. The signature is checked on the same staging copy, against that
 * hash (`acceptSignature`); a refused one fails the install the same way.
 * `warnings` says what was accepted with a caveat (an untrusted key).
 * `requireTrustedSignature` refuses anything but a valid trusted signature,
 * whatever `plugins.requireSignature` says (a remote install, ./remote.ts);
 * `source` (its URL) goes into the audit row. `expect` refuses a package
 * whose manifest names another name or version (a registry entry's promise).
 *
 * An upgrade is checked against the installed version before anything is
 * disabled: a lower version is refused unless `allowDowngrade`, and a
 * version signed by another key than the installed one (or unsigned, when
 * the installed one was signed by a trusted publisher) unless
 * `allowSignerChange`; either override is recorded in the audit row. A
 * refused or failed upgrade leaves the installed package as it was, enabled
 * and running if it was.
 */
export async function installFromDirectory(
  sourceDir: string,
  actorUserId: string,
  opts: {
    upgrade?: boolean;
    requireTrustedSignature?: boolean;
    source?: string;
    /** The name (and version) the package must have: what a registry entry promised. */
    expect?: { name?: string; version?: string };
    /** An upgrade may be signed by another key than the installed version (audited). */
    allowSignerChange?: boolean;
    /** An upgrade may install an older version (audited). */
    allowDowngrade?: boolean;
    /** The agent that wrote the package (creator mode, ./authoring): recorded in the audit row, shown on the admin page. */
    authoredBy?: AgentAuthoredDetails;
    /** The runtime the package must declare (creator mode installs `package` only), checked on the staged copy. */
    requireRuntime?: PluginRuntime;
    /**
     * What a registry listing promised beyond name and version
     * (docs/PLUGIN-PACKAGES.md#marketplace): the content hash, and the
     * permissions (`computePermissions`) the listing shows. Each is compared
     * with the staged copy; any difference refuses the install (audited), so
     * a listing can never understate what a package asks for.
     */
    expectListing?: { contentHash?: string | null; permissions?: PluginPermissionsSummary | null };
    /** Where it comes from (provenance, recorded on the row and in the audit row). Default: a directory, or `agent` with `authoredBy`. */
    origin?: PluginOrigin;
    /** Only these publishers' keys count for its signature (an install from the marketplace: its keys alone). */
    trustOnly?: readonly TrustedPublisher[];
    /** An upgrade may come from another source than the installed version (another registry, the marketplace; audited). */
    allowSourceChange?: boolean;
  } = {},
): Promise<PluginPackageRow & { warnings: string[] }> {
  assertStoreOutsideInstall();
  const source = resolve(sourceDir);
  const fromStore = relative(pluginsRoot(), source);
  if (fromStore === '' || (fromStore !== '..' && !fromStore.startsWith(`..${sep}`) && !isAbsolute(fromStore))) throw new PluginPackageError('invalid', 'The package is already in the plugin directory');
  // A first look at the source, so a linked or unbounded tree is refused
  // before anything is copied. It is not what decides: the source may be
  // written by someone else (an agent) while this runs, so everything below
  // is read and checked on the staged copy only.
  await checkTree(source);
  await installHook?.(source);
  const db = getDb();

  // Copy into the plugin directory, then read, check, hash and verify only
  // the copy, before anything installed is touched: a refused package leaves
  // an installed one (and whether it runs) as it was, and what was checked is
  // exactly what is installed.
  await mkdir(pluginsRoot(), { recursive: true });
  let staging = join(pluginsRoot(), `.installing-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  let manifest: PluginManifest;
  let contentHash: string;
  let signature: Awaited<ReturnType<typeof acceptSignature>>;
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    await dropListingFile(staging);
    manifest = await readManifest(staging);
    await checkTree(staging);
    if (opts.requireRuntime !== undefined && pluginRuntime(manifest) !== opts.requireRuntime) {
      throw new PluginPackageError('invalid', `${manifest.name} declares runtime "${pluginRuntime(manifest)}"; only runtime "${opts.requireRuntime}" is accepted here; not installed`);
    }
    if (opts.expect?.name !== undefined && opts.expect.name !== manifest.name) {
      throw new PluginPackageError('invalid', `The package is "${manifest.name}", not the expected "${opts.expect.name}"; not installed`);
    }
    if (opts.expect?.version !== undefined && opts.expect.version !== manifest.version) {
      throw new PluginPackageError('invalid', `${manifest.name} is version ${manifest.version}, not the expected ${opts.expect.version}; not installed`);
    }
    // A version the marketplace revoked installs from nowhere (docs/PLUGIN-PACKAGES.md#online-revocation).
    const revoked = await packageRevocation(manifest.name, manifest.version);
    if (revoked) {
      await auditQuietly('install_refused_revoked', manifest.name, { version: manifest.version, reason: revoked.reason, actor: actorUserId });
      throw new PluginPackageError('invalid', `${manifest.name} ${manifest.version} is revoked by the marketplace (${revoked.reason || 'no reason given'}); not installed`);
    }
    if (opts.expectListing?.permissions) {
      const actual = computePermissions(manifest);
      if (canonicalJson(actual) !== canonicalJson(opts.expectListing.permissions)) {
        await auditQuietly('listing_mismatch', manifest.name, {
          version: manifest.version, actor: actorUserId, what: 'permissions', listed: opts.expectListing.permissions, actual, source: opts.origin?.source ?? null,
        });
        throw new PluginPackageError('invalid',
          `The listing of ${manifest.name} ${manifest.version} does not state what the package asks for: its permissions differ from those computed from its manifest; not installed`,
          [`listed: ${canonicalJson(opts.expectListing.permissions)}`, `actual: ${canonicalJson(actual)}`]);
      }
    }
    // Named after the package from here on, beside its target.
    const named = `${packageDir(manifest.name)}.installing-${process.pid}-${Date.now()}`;
    await rename(staging, named);
    staging = named;
    // Hashed as copied, so what the admin installs is what is pinned.
    if (manifest.entry !== undefined) await checkEntry(staging, manifest.entry);
    contentHash = await hashPackageContent(staging, manifest);
    if (opts.expectListing?.contentHash && opts.expectListing.contentHash !== contentHash) {
      await auditQuietly('listing_mismatch', manifest.name, {
        version: manifest.version, actor: actorUserId, what: 'contentHash', listed: opts.expectListing.contentHash, actual: contentHash, source: opts.origin?.source ?? null,
      });
      throw new PluginPackageError('invalid',
        `${manifest.name} ${manifest.version} hashes to ${contentHash}, not to the ${opts.expectListing.contentHash} its listing states; not installed`);
    }
    signature = await acceptSignature(staging, manifest.name, contentHash, opts.requireTrustedSignature === true, opts.trustOnly);
    // Its contributions must fit beside what is installed (a command name taken), and its prompt file be readable.
    const fit = await contributionInstallProblems(manifest, staging, await db.select({ name: pluginPackages.name, manifest: pluginPackages.manifest }).from(pluginPackages));
    if (fit.length > 0) throw new PluginPackageError('conflict', `${manifest.name}: ${fit.join('; ')}`, fit);
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const target = packageDir(manifest.name);
  const serverId = `${PLUGIN_SERVER_PREFIX}${manifest.name}`;

  let previous: PluginPackageRow | null = null;
  const overrides: Record<string, unknown> = {};
  const origin: PluginOrigin = opts.origin ?? (opts.authoredBy ? { source: 'agent' } : { source: 'directory' });
  try {
    if (opts.upgrade) {
      const current = await findRow(manifest.name);
      if (!current) throw new PluginPackageError('not_found', `Plugin package not found: ${manifest.name}; install it first`);
      if (compareVersions(manifest.version, current.version) < 0) {
        if (!opts.allowDowngrade) {
          throw new PluginPackageError('conflict',
            `${manifest.name} ${manifest.version} is older than the installed ${current.version}; pass allowDowngrade to install it anyway`);
        }
        overrides.downgrade = true;
      }
      // Another registry (or the marketplace) offering the same name must not take the package over in silence.
      if (sourceClass(current.origin) !== sourceClass(origin)) {
        if (!opts.allowSourceChange) {
          throw new PluginPackageError('conflict',
            `${manifest.name} ${current.version} came from ${describeSource(current.origin)}; this version comes from ${describeSource(origin)}. Confirm the change of source to continue (allowSourceChange: true); it is recorded in the audit log`,
            [`source: ${sourceClass(current.origin)} → ${sourceClass(origin)}`], { sourceChange: { from: sourceClass(current.origin), to: sourceClass(origin) } });
        }
        overrides.sourceChange = { from: current.origin ?? null, to: origin };
      }
      const change = await signerChange(current, signature);
      if (change) {
        if (!opts.allowSignerChange) {
          throw new PluginPackageError('conflict',
            `${manifest.name} ${current.version} is signed by ${change.from}, this upgrade ${change.to === null ? 'is not signed by a trusted publisher' : `by ${change.to}`}; pass allowSignerChange to accept another publisher`);
        }
        overrides.signerChange = change;
      }
      // Claimed only now: disabled before any file is replaced, since its tools may have changed.
      const [disabled] = await db.update(pluginPackages).set({ enabled: false, updatedAt: new Date() })
        .where(eq(pluginPackages.name, manifest.name)).returning();
      if (!disabled) throw new PluginPackageError('not_found', `Plugin package not found: ${manifest.name}; install it first`);
      previous = { ...disabled, enabled: current.enabled };
      if (current.enabled) await syncPluginServers();
    } else {
      const [claimed] = await db.insert(pluginPackages)
        .values({ name: manifest.name, version: manifest.version, manifest, enabled: false, settings: {}, installedBy: actorUserId, origin })
        .onConflictDoNothing()
        .returning();
      if (!claimed) {
        const existing = await findRow(manifest.name);
        throw new PluginPackageError('exists', `Plugin package "${manifest.name}" is already installed (version ${existing?.version ?? '?'}); upgrade it instead`);
      }
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const settings = previous ? keptSettings(manifest, previous.settings) : {};
  const swap = { done: false, backup: null as string | null };
  let row: PluginPackageRow;
  try {
    await getMCPBridge().disconnect(serverId);
    row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(pluginPackages)
        .set({
          version: manifest.version, manifest, enabled: false, settings, contentHash, signatureHash: signature.signatureHash, signedBy: signature.signedBy, origin,
          // New files: running them in the server process is approved again, for these bytes.
          inProcessApprovedHash: null, inProcessApprovedBy: null, inProcessApprovedAt: null,
          // New files: what it adds to every user's agents is approved again.
          approvedContributionsHash: null,
          // New version: its tools' effects (and so what each call's token may carry) can
          // differ, so the host API scopes are approved again (docs/PLUGIN-PACKAGES.md#host-api),
          // and so is model:cli-tools: what its prompts are built from can differ too.
          approvedHostScopes: null,
          installedBy: actorUserId, updatedAt: new Date(),
        })
        .where(eq(pluginPackages.name, manifest.name))
        .returning();
      if (!updated) throw new PluginPackageError('not_found', `Plugin package not found: ${manifest.name}`);
      swap.backup = await swapIn(staging, target);
      swap.done = true;
      return updated;
    });
  } catch (err) {
    if (swap.done) {
      // The row did not commit: put back the files it pins.
      await rm(target, { recursive: true, force: true }).catch(() => {});
      if (swap.backup) await rename(swap.backup, target).catch((e: unknown) => coreLogger.error({ err: e, pkg: manifest.name }, 'Could not restore the previous package files'));
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (previous) {
      // The old files and row stay: so does whether it ran.
      if (previous.enabled) {
        await db.update(pluginPackages).set({ enabled: true }).where(eq(pluginPackages.name, manifest.name))
          .catch((e: unknown) => coreLogger.error({ err: e, pkg: manifest.name }, 'Could not re-enable the package after a failed upgrade'));
        await syncPluginServers().catch((e: unknown) => coreLogger.error({ err: e, pkg: manifest.name }, 'Could not restart the package after a failed upgrade'));
      }
    } else {
      // A new install that could not copy its files is not installed.
      await db.delete(pluginPackages).where(eq(pluginPackages.name, manifest.name));
    }
    throw err;
  }
  if (swap.backup) await rm(swap.backup, { recursive: true, force: true }).catch((err: unknown) => coreLogger.warn({ err, dir: swap.backup }, 'Could not remove the previous package files'));
  forgetMismatches(manifest.name);
  revokePluginTokens(manifest.name);
  await audit(actorUserId, previous ? 'upgraded' : 'installed', manifest.name, {
    version: manifest.version, from: previous?.version ?? null, contentHash, signedBy: signature.signedBy, keyId: signature.keyId,
    runtime: pluginRuntime(manifest),
    ...(opts.source ? { source: opts.source } : {}),
    origin,
    ...(previous?.approvedContributionsHash ? { contributionsApprovalCleared: previous.approvedContributionsHash } : {}),
    ...(previous?.approvedHostScopes?.includes(PLUGIN_MODEL_CLI_TOOLS_APPROVAL) ? { modelCliToolsApprovalCleared: true } : {}),
    ...(opts.authoredBy ? { authoredBy: opts.authoredBy } : {}),
    ...overrides,
  });
  await syncPluginServers();
  return { ...row, warnings: [...signature.warnings, ...modelTrustWarnings(manifest)] };
}

/**
 * What an install says about a manifest's `model.trustedInput`: that it grants
 * nothing until an admin approves `model:cli-tools`, and the other sources
 * the package reads from, which the admin has to trust.
 */
export function modelTrustWarnings(m: PluginManifest): string[] {
  if (!declaresTrustedModelInput(m)) return [];
  const sources = modelCliToolsSourcesWarning(m);
  return [
    `${m.name} declares model.trustedInput ("${m.model?.reason ?? ''}"): its model calls stay off CLI lanes until an admin approves ${PLUGIN_MODEL_CLI_TOOLS_APPROVAL}. ${MODEL_CLI_TOOLS_WARNING}`,
    ...(sources ? [sources] : []),
  ];
}

let installHook: ((source: string) => Promise<void> | void) | null = null;
/** Test-only: runs between the first look at the source and its copy (when another writer could change it). */
export function _setInstallHookForTesting(hook: ((source: string) => Promise<void> | void) | null): void {
  installHook = hook;
}

/**
 * An in-process plugin's `entry` must be a regular file in the package (the
 * manifest checked its path), and the package one bundled module: no other
 * code file, no import by path (./in-process-bundle.ts).
 */
async function checkEntry(dir: string, entry: string): Promise<void> {
  const info = await lstat(join(dir, entry)).catch(() => null);
  if (!info?.isFile()) throw new PluginPackageError('invalid', `entry: ${entry} is not a file in the package`);
  const problems = await checkInProcessBundle(dir, entry);
  if (problems.length > 0) throw new PluginPackageError('invalid', `${problems[0]}; not installed`, problems);
}

/**
 * Move `staging` to `target`, keeping what was there as a backup (returned,
 * or null when there was nothing): two renames, the second undone if it fails.
 */
async function swapIn(staging: string, target: string): Promise<string | null> {
  const backup = `${target}.previous-${process.pid}-${Date.now()}`;
  let moved = false;
  try {
    await rename(target, backup);
    moved = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await rename(staging, target);
  } catch (err) {
    if (moved) await rename(backup, target);
    throw err;
  }
  return moved ? backup : null;
}

/**
 * The settings of a previous version that the new one still declares and
 * accepts, one by one: a value the new field refuses is dropped, the rest
 * stay. A required field the new version adds is not demanded here; enabling
 * asks for it.
 */
function keptSettings(manifest: PluginManifest, previous: PluginPackageRow['settings']): PluginPackageRow['settings'] {
  const kept: PluginPackageRow['settings'] = {};
  for (const field of manifest.settings ?? []) {
    if (!Object.hasOwn(previous, field.key)) continue;
    try {
      Object.assign(kept, validateRecordData([{ ...field, required: false }], { [field.key]: previous[field.key] }));
    } catch (err) {
      coreLogger.warn({ err, pkg: manifest.name, key: field.key }, 'A setting of the previous version does not fit the new one; dropped');
    }
  }
  return kept;
}

/** Remove a package: its server, its files, its row and its secrets. */
export async function uninstall(name: string, actorUserId: string): Promise<void> {
  const row = await requireRow(name);
  await getMCPBridge().disconnect(`${PLUGIN_SERVER_PREFIX}${name}`);
  await getDb().delete(pluginPackages).where(eq(pluginPackages.name, name));
  await rm(packageDir(name), { recursive: true, force: true });
  await rm(pluginDataDir(name), { recursive: true, force: true });
  forgetMismatches(name);
  revokePluginTokens(name);
  const entries = (row.manifest.secrets ?? []).length > 0 ? await getVault().list('system') : [];
  for (const s of row.manifest.secrets ?? []) await deleteSecret(name, s.key, entries);
  await audit(actorUserId, 'uninstalled', name, { version: row.version });
  await syncPluginServers();
}

/**
 * Change a package's settings, approve its content and/or turn it on or off,
 * in one write. Settings are checked against the fields its manifest
 * declares; turning it on (or keeping it on) requires every required setting
 * and secret to have a value, and turning it on requires its files to match
 * the approved hash. `approveContent` is the hash the operator reviewed
 * (`sha256:<hex>`, the view's `actualHash`): it is recorded only if the files
 * hash to it now, so what is approved is what was reviewed, not whatever is
 * on disk by the time the request arrives (`conflict` otherwise).
 * Approved content is the publisher's only if it carries a valid trusted
 * signature: `signedBy` becomes that publisher, or null. Under
 * `plugins.requireSignature`, approving or enabling content without one is
 * refused (`incomplete`).
 *
 * An `in-process` plugin (docs/PLUGIN-PACKAGES.md#runtimes) runs in the
 * server process, so it needs one approval more: `approveInProcess`, the
 * content hash the admin reviewed, accepted only when it is the approved
 * content and the files still hash to it, under the same signature rules as
 * enabling. It is recorded with who and when; approving other content clears
 * it. Turning such a plugin on without it is refused (`incomplete`); one that
 * stays enabled while its approval is cleared is not loaded until it is
 * approved again.
 * Nothing is saved when a check fails.
 */
export async function configure(
  name: string,
  change: {
    settings?: unknown; enabled?: boolean; approveContent?: string | boolean; approveInProcess?: string | boolean; approveHostScopes?: unknown;
    approveContributions?: string | boolean;
  },
  actorUserId: string,
): Promise<PluginPackageRow> {
  const row = await requireRow(name);
  if (change.approveContributions !== undefined) {
    if (!hasContributions(row.manifest)) throw new PluginPackageError('invalid', `${name} declares no commands, schedules, events, prompt or context; there is nothing to approve`);
    if (!isContentHash(change.approveContributions)) {
      throw new PluginPackageError('invalid',
        'approveContributions takes the contributions hash you reviewed ("sha256:<64 hex>", shown as contributions.hash), not true: what the package adds is approved only while it still hashes to it');
    }
  }
  if (change.approveContent !== undefined && !isContentHash(change.approveContent)) {
    throw new PluginPackageError('invalid',
      'approveContent takes the content hash you reviewed ("sha256:<64 hex>", shown as actualHash), not true: the files are approved only while they still hash to it');
  }
  const inProcess = pluginRuntime(row.manifest) === 'in-process';
  if (change.approveInProcess !== undefined) {
    if (!inProcess) throw new PluginPackageError('invalid', `${name} runs as a sandboxed package; approveInProcess is only for runtime "in-process"`);
    if (!isContentHash(change.approveInProcess)) {
      throw new PluginPackageError('invalid',
        'approveInProcess takes the content hash you reviewed ("sha256:<64 hex>", the approved contentHash), not true: running in the server process is approved for those bytes only');
    }
  }
  const approvedHostScopes = change.approveHostScopes !== undefined
    ? checkHostScopeApproval(row.manifest, change.approveHostScopes)
    : row.approvedHostScopes;
  let settings = row.settings;
  if (change.settings !== undefined) {
    const values = change.settings;
    if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new PluginPackageError('invalid', 'Settings must be an object');
    try {
      settings = validateRecordData(row.manifest.settings ?? [], { ...row.settings, ...(values as Record<string, unknown>) });
    } catch (err) {
      if (err instanceof RecordValidationError) throw new PluginPackageError('invalid', 'The settings do not fit the package', err.problems);
      throw err;
    }
  }
  const enabled = change.enabled ?? row.enabled;
  if ((enabled && !row.enabled) || change.approveContent !== undefined || change.approveInProcess !== undefined) {
    const revoked = await packageRevocation(name, row.version);
    if (revoked) {
      throw new PluginPackageError('incomplete', `${name} ${row.version} is revoked by the marketplace (${revoked.reason || 'no reason given'}); it cannot be enabled or approved. Upgrade to a version that is not revoked`);
    }
  }
  if (enabled) {
    const missing = await missingConfiguration({ ...row, settings });
    if (missing.length > 0) {
      throw new PluginPackageError('incomplete', `Set ${missing.join(', ')} before enabling ${name}`, missing.map((m) => `${m}: required`));
    }
  }
  if (enabled && !row.enabled) {
    // Enabling approves what the package may do as a user: every declared host scope must be approved.
    const unapproved = unapprovedHostScopes(row.manifest, approvedHostScopes);
    if (unapproved.length > 0) {
      throw new PluginPackageError('incomplete',
        `Approve the host API scopes ${unapproved.join(', ')} before enabling ${name} (approveHostScopes)`,
        unapproved.map((s) => `host: ${s} not approved`));
    }
  }
  let contentHash = row.contentHash;
  let signedBy = row.signedBy;
  let signatureHash = row.signatureHash;
  const required = signatureRequired();
  /** Under requireSignature: refuse unless the files carry a valid trusted signature over `hash`. */
  const refuseUnsigned = (check: SignatureCheck, doing: string): void => {
    // A revoked key is refused whatever requireSignature says.
    if (check.status === 'revoked') {
      throw new PluginPackageError('incomplete', `${signatureShortfall(name, check)}; ${doing} it is refused until it is signed again by a trusted key, or its signature file is removed`);
    }
    if (!required || check.status === 'valid') return;
    throw new PluginPackageError('incomplete',
      `${signatureShortfall(name, check)}; plugins.requireSignature refuses ${doing} it until it carries a valid signature by a trusted publisher`);
  };
  const approving = typeof change.approveContent === 'string' ? change.approveContent : null;
  /** What the files hash to now, once computed by a check below. */
  let hashedNow: string | null = null;
  if (approving) {
    const actual = await hashPackageContent(packageDir(name), row);
    hashedNow = actual;
    if (actual !== approving) {
      throw new PluginPackageError('conflict',
        `The files of ${name} hash to ${actual}, not to the reviewed ${approving}: they changed since they were reviewed; review them again`,
        [`approveContent: reviewed ${approving}, actual ${actual}`], { actualHash: actual });
    }
    contentHash = actual;
    // Approved content is the publisher's only if their signature covers it. A
    // signature left from before the change no longer matches: it reads as
    // invalid, and signedBy clears.
    const sig = await signatureState(packageDir(name), actual, row.origin);
    if (sig.malformed) throw new PluginPackageError('invalid', `${sig.malformed}; remove it or sign the package again before approving`);
    refuseUnsigned(sig.check, 'approving');
    signedBy = sig.check.status === 'valid' ? sig.check.publisher : null;
    signatureHash = sig.sha256;
  } else if (enabled && !row.enabled) {
    let actual: string | null = null;
    if (row.contentHash !== null) {
      actual = await hashPackageContent(packageDir(name), row);
      if (actual !== row.contentHash) {
        throw new PluginPackageError('incomplete',
          `${name} was modified since it was approved (hash mismatch: recorded ${row.contentHash}, actual ${actual}); approve its content before enabling it`,
          [`contentHash: recorded ${row.contentHash}, actual ${actual}`], { actualHash: actual });
      }
    }
    actual ??= await hashPackageContent(packageDir(name), row);
    hashedNow = actual;
    const sig = await signatureState(packageDir(name), actual, row.origin);
    if (sig.malformed) throw new PluginPackageError('incomplete', `${sig.malformed}; remove it or sign the package again before enabling ${name}`);
    if (row.contentHash !== null && sig.sha256 !== row.signatureHash) {
      throw new PluginPackageError('incomplete',
        `${SIGNATURE_FILE} of ${name} changed since its content was approved (recorded ${row.signatureHash ?? 'none'}, actual ${sig.sha256 ?? 'none'}); approve its content before enabling it`,
        undefined, { actualHash: actual });
    }
    refuseUnsigned(sig.check, 'enabling');
  }
  // Running in the server process is approved for one content hash: other content clears it.
  let inProcessApproval = { inProcessApprovedHash: row.inProcessApprovedHash, inProcessApprovedBy: row.inProcessApprovedBy, inProcessApprovedAt: row.inProcessApprovedAt };
  const inProcessCleared = row.inProcessApprovedHash !== null && contentHash !== row.inProcessApprovedHash;
  if (inProcessCleared) inProcessApproval = { inProcessApprovedHash: null, inProcessApprovedBy: null, inProcessApprovedAt: null };
  const approvingInProcess = typeof change.approveInProcess === 'string' ? change.approveInProcess : null;
  if (approvingInProcess) {
    if (contentHash === null || approvingInProcess !== contentHash) {
      throw new PluginPackageError('conflict',
        `${name}'s approved content is ${contentHash ?? 'not pinned yet'}, not the reviewed ${approvingInProcess}: approve running in the server process for the approved content`,
        [`approveInProcess: reviewed ${approvingInProcess}, approved content ${contentHash ?? 'none'}`]);
    }
    const actual = hashedNow ?? await hashPackageContent(packageDir(name), row);
    if (actual !== approvingInProcess) {
      throw new PluginPackageError('conflict',
        `The files of ${name} hash to ${actual}, not to the reviewed ${approvingInProcess}: they changed since they were approved; review them and approve their content first`,
        [`approveInProcess: reviewed ${approvingInProcess}, actual ${actual}`], { actualHash: actual });
    }
    if (!approving) {
      const sig = await signatureState(packageDir(name), actual, row.origin);
      if (sig.malformed) throw new PluginPackageError('invalid', `${sig.malformed}; remove it or sign the package again before approving it to run in the server process`);
      if (sig.sha256 !== signatureHash) {
        throw new PluginPackageError('incomplete',
          `${SIGNATURE_FILE} of ${name} changed since its content was approved; approve its content first`, undefined, { actualHash: actual });
      }
      refuseUnsigned(sig.check, 'approving');
    }
    inProcessApproval = { inProcessApprovedHash: approvingInProcess, inProcessApprovedBy: actorUserId, inProcessApprovedAt: new Date() };
  }
  if (inProcess && change.enabled === true && (contentHash === null || inProcessApproval.inProcessApprovedHash !== contentHash)) {
    throw new PluginPackageError('incomplete',
      `${name} runs in the server process, with the server's full authority: approve that for its content first (approveInProcess: "${contentHash ?? '<its content hash>'}"), then enable it`);
  }
  // What the package adds to every user's agents (prompt, context, events,
  // schedules, commands) is approved for one contributions hash: approving
  // content that changes it clears the approval, and enabling needs it.
  let approvedContributionsHash = row.approvedContributionsHash;
  let contributionsCleared = false;
  const approvingContributions = typeof change.approveContributions === 'string' ? change.approveContributions : null;
  if (hasContributions(row.manifest) && (approvingContributions || approving || (enabled && !row.enabled))) {
    let current: string | null;
    try {
      current = await contributionsHashOf(row.manifest, packageDir(name));
    } catch (err) {
      throw new PluginPackageError('invalid', `The contributions of ${name} cannot be read: ${(err as Error).message}`);
    }
    if (approvingContributions) {
      if (approvingContributions !== current) {
        throw new PluginPackageError('conflict',
          `The contributions of ${name} hash to ${current}, not to the reviewed ${approvingContributions}: they changed since they were reviewed; review them again`,
          [`approveContributions: reviewed ${approvingContributions}, actual ${current}`], current ? { contributionsHash: current } : {});
      }
      approvedContributionsHash = approvingContributions;
    } else if (approvedContributionsHash !== null && approvedContributionsHash !== current) {
      approvedContributionsHash = null;
      contributionsCleared = true;
    }
    if (enabled && !row.enabled && approvedContributionsHash !== current) {
      throw new PluginPackageError('conflict',
        `${name} adds commands, schedules, events, prompt text or turn context for every user: review them and approve them first (approveContributions: "${current}"), then enable it`,
        [`approveContributions: required, contributions hash ${current}`], current ? { contributionsHash: current } : {});
    }
  }
  const [updated] = await getDb().update(pluginPackages)
    .set({ settings, enabled, contentHash, signatureHash, signedBy, approvedHostScopes, approvedContributionsHash, ...inProcessApproval, updatedAt: new Date() })
    .where(eq(pluginPackages.name, name)).returning();
  if (approvingContributions) {
    await audit(actorUserId, 'contributions_approved', name, { version: row.version, hash: approvingContributions, previous: row.approvedContributionsHash });
  }
  if (contributionsCleared) {
    await audit(actorUserId, 'contributions_approval_cleared', name, { version: row.version, previous: row.approvedContributionsHash });
  }
  if (approving) {
    forgetMismatches(name);
    await audit(actorUserId, 'content_approved', name, {
      version: row.version, from: row.contentHash, to: contentHash, signedBy, previousSignedBy: row.signedBy, signatureHash,
      ...(inProcessCleared ? { inProcessApprovalCleared: row.inProcessApprovedHash } : {}),
    });
  }
  if (approvingInProcess) {
    await audit(actorUserId, 'in_process_approved', name, { version: row.version, hash: approvingInProcess, signedBy, previous: row.inProcessApprovedHash });
  }
  if (change.approveHostScopes !== undefined) {
    await audit(actorUserId, 'host_scopes_approved', name, { version: row.version, scopes: approvedHostScopes, previous: row.approvedHostScopes });
    const before = (row.approvedHostScopes ?? []).includes(PLUGIN_MODEL_CLI_TOOLS_APPROVAL);
    const after = (approvedHostScopes ?? []).includes(PLUGIN_MODEL_CLI_TOOLS_APPROVAL);
    if (before !== after) {
      await audit(actorUserId, after ? 'model_cli_tools_approved' : 'model_cli_tools_revoked', name, { version: row.version, reason: row.manifest.model?.reason ?? null });
    }
  }
  if (change.settings !== undefined) await audit(actorUserId, 'settings_changed', name, { keys: Object.keys(change.settings as object) });
  if (change.enabled !== undefined && change.enabled !== row.enabled) await audit(actorUserId, enabled ? 'enabled' : 'disabled', name, { version: row.version });
  // A token of a call in flight dies with the package's enabled state or a narrower approval.
  if (!enabled || change.approveHostScopes !== undefined) revokePluginTokens(name);
  await syncPluginServers();
  return updated;
}

/**
 * The host API scopes an admin approves (`approveHostScopes`): a list of
 * scopes the manifest declares, each at most once. A scope it does not
 * declare is refused: approval is for what this version asks. It may also
 * carry `model:cli-tools`, the approval of the manifest's `model.trustedInput`
 * (docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes), only when it declares it.
 * The list replaces the approved one: leaving `model:cli-tools` out revokes it.
 */
function checkHostScopeApproval(manifest: PluginManifest, value: unknown): PluginHostApproval[] {
  const isApproval = (s: unknown): s is PluginHostApproval => isHostScope(s) || s === PLUGIN_MODEL_CLI_TOOLS_APPROVAL;
  if (!Array.isArray(value) || !value.every(isApproval)) {
    throw new PluginPackageError('invalid', `approveHostScopes is a list of host API scopes, such as ["notes:read"] (and ${PLUGIN_MODEL_CLI_TOOLS_APPROVAL} for a package that declares model.trustedInput)`);
  }
  const declared = new Set<string>([...(manifest.host ?? []), ...(declaresTrustedModelInput(manifest) ? [PLUGIN_MODEL_CLI_TOOLS_APPROVAL] : [])]);
  const undeclared = value.filter((s) => !declared.has(s));
  if (undeclared.length > 0) {
    const what = undeclared.map((s) => (s === PLUGIN_MODEL_CLI_TOOLS_APPROVAL ? `${s} (it does not declare model.trustedInput)` : s));
    throw new PluginPackageError('invalid', `${manifest.name} does not declare the host API scopes ${what.join(', ')}`);
  }
  return [...new Set(value)];
}

/**
 * Whether a package's `model:complete` calls may run on a CLI lane (its
 * models have their own tools): it declares `model.trustedInput`, and an
 * admin approved both `model:complete` and `model:cli-tools` for this version.
 */
export function modelCliToolsGranted(row: Pick<PluginPackageRow, 'manifest' | 'approvedHostScopes'>): boolean {
  const approved = row.approvedHostScopes ?? [];
  return declaresTrustedModelInput(row.manifest) && (row.manifest.host ?? []).includes('model:complete')
    && approved.includes('model:complete') && approved.includes(PLUGIN_MODEL_CLI_TOOLS_APPROVAL);
}

/** The view of a manifest's `model.trustedInput` and its approval, or null when it does not declare it. */
export function modelCliToolsView(row: Pick<PluginPackageRow, 'manifest' | 'approvedHostScopes'>): PluginModelCliToolsView | null {
  if (!declaresTrustedModelInput(row.manifest)) return null;
  return {
    reason: row.manifest.model?.reason ?? '',
    approved: (row.approvedHostScopes ?? []).includes(PLUGIN_MODEL_CLI_TOOLS_APPROVAL),
    active: modelCliToolsGranted(row),
    sourcesWarning: modelCliToolsSourcesWarning(row.manifest),
  };
}

/** The scopes the manifest declares that are not approved. */
export function unapprovedHostScopes(manifest: PluginManifest, approved: readonly string[] | null): PluginHostScope[] {
  const ok = new Set(approved ?? []);
  return (manifest.host ?? []).filter((s) => !ok.has(s));
}

/** Approve a package's host API scopes (`configure` with `approveHostScopes` alone). */
export function approveHostScopes(name: string, scopes: PluginHostApproval[], actorUserId: string): Promise<PluginPackageRow> {
  return configure(name, { approveHostScopes: scopes }, actorUserId);
}

/** Accept a package's files, if they still hash to the reviewed `hash` (`configure` with `approveContent` alone). */
export function approveContent(name: string, hash: string, actorUserId: string): Promise<PluginPackageRow> {
  return configure(name, { approveContent: hash }, actorUserId);
}

/** Approve what a package contributes, for the reviewed contributions `hash` (`configure` with `approveContributions` alone). */
export function approveContributions(name: string, hash: string, actorUserId: string): Promise<PluginPackageRow> {
  return configure(name, { approveContributions: hash }, actorUserId);
}

/** Approve an in-process plugin to run in the server process, for the reviewed `hash` (`configure` with `approveInProcess` alone). */
export function approveInProcess(name: string, hash: string, actorUserId: string): Promise<PluginPackageRow> {
  return configure(name, { approveInProcess: hash }, actorUserId);
}

/** Turn a package on or off (`configure` with `enabled` alone). */
export function setEnabled(name: string, enabled: boolean, actorUserId: string): Promise<PluginPackageRow> {
  return configure(name, { enabled }, actorUserId);
}

/** Change a package's settings (`configure` with `settings` alone). */
export function updateSettings(name: string, values: unknown, actorUserId: string): Promise<PluginPackageRow> {
  return configure(name, { settings: values }, actorUserId);
}

/** What a package still needs before it can run: labels of required settings and secrets without a value. */
async function missingConfiguration(row: PluginPackageRow, setSecrets?: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const f of row.manifest.settings ?? []) {
    if (f.required && !Object.hasOwn(row.settings, f.key)) missing.push(f.label);
  }
  const set = setSecrets ?? await secretsSet(row);
  for (const s of row.manifest.secrets ?? []) {
    if (s.required && !set.includes(s.key)) missing.push(s.label);
  }
  return missing;
}

/**
 * Store (or, with null or a blank value, remove) one of a package's declared
 * secrets. A required secret of an enabled package cannot be removed: disable
 * the package first.
 */
export async function setSecret(name: string, key: string, value: string | null, actorUserId: string): Promise<void> {
  const row = await requireRow(name);
  const decl = (row.manifest.secrets ?? []).find((s) => s.key === key);
  if (!decl) throw new PluginPackageError('invalid', `${name} declares no secret ${key}`);
  const remove = value === null || value.trim() === '';
  if (remove && decl.required && row.enabled) {
    throw new PluginPackageError('incomplete', `${decl.label} is required while ${name} is enabled; disable it first`);
  }
  if (remove) await deleteSecret(name, key);
  else await getVault().setSystemSecret(secretName(name, key), value as string, { description: `Secret ${key} of plugin package ${name}`, tags: ['system', 'plugin'] });
  await audit(actorUserId, remove ? 'secret_removed' : 'secret_set', name, { key });
  await syncPluginServers();
}

async function deleteSecret(name: string, key: string, entries?: SystemSecretList): Promise<void> {
  const vault = getVault();
  const wanted = secretName(name, key);
  for (const entry of entries ?? await vault.list('system')) {
    if (entry.name === wanted) await vault.delete('system', entry.id);
  }
}

type SystemSecretList = Awaited<ReturnType<ReturnType<typeof getVault>['list']>>;

/** Which of a package's declared secrets have a value, against one listing of the system secrets. */
async function secretsSet(row: PluginPackageRow, entries?: SystemSecretList): Promise<string[]> {
  const declared = row.manifest.secrets ?? [];
  if (declared.length === 0) return [];
  const names = new Set((entries ?? await getVault().list('system')).map((e) => e.name));
  return declared.filter((s) => names.has(secretName(row.name, s.key))).map((s) => s.key);
}

/** The problem shown for an enabled in-process plugin whose content is not approved to run in the server process. */
export const IN_PROCESS_UNAPPROVED_PROBLEM = 'Not approved to run in the server process (for this content); approve that to load it';

/** Whether an in-process plugin's approval covers its approved content. */
export function inProcessApproved(row: PluginPackageRow): boolean {
  return row.contentHash !== null && row.inProcessApprovedHash === row.contentHash;
}

async function viewOf(row: PluginPackageRow, secrets: string[], authoredBy?: PluginAgentAuthorship | null): Promise<PluginPackageView> {
  const bridge = getMCPBridge();
  const signature = await currentSignature(row);
  const serverId = `${PLUGIN_SERVER_PREFIX}${row.name}`;
  const runtime = pluginRuntime(row.manifest);
  let inProcess: PluginInProcessStatus | null = null;
  let problem: string | null;
  let connected: boolean;
  if (runtime === 'in-process') {
    const loader = await import('./in-process');
    connected = loader.isInProcessLoaded(row.name);
    problem = !row.enabled ? null : !inProcessApproved(row) ? IN_PROCESS_UNAPPROVED_PROBLEM : loader.inProcessProblem(row.name);
    inProcess = {
      approved: inProcessApproved(row),
      approvedHash: row.inProcessApprovedHash,
      approvedBy: row.inProcessApprovedBy,
      approvedAt: row.inProcessApprovedAt?.toISOString() ?? null,
      loaded: connected,
    };
  } else {
    problem = row.enabled ? bridge.pluginProblem(serverId) : null;
    connected = bridge.isConnected(serverId);
  }
  // Only on a mismatch, so a listing does not hash every package: what the
  // files hash to now, for the admin to review and pass as approveContent.
  let actualHash: string | null = null;
  if (!row.enabled && row.contentHash !== null) {
    // A disabled package is not started, so nothing else notices that its
    // files changed: check here, so it can be reviewed and approved (and then
    // enabled) instead of only being refused at enabling.
    const now = await hashPackageContent(packageDir(row.name), row).catch((err: unknown) => {
      coreLogger.warn({ err, pkg: row.name }, 'Plugin package content could not be hashed for its view');
      return null;
    });
    if (now !== null && now !== row.contentHash) {
      problem = CONTENT_MISMATCH_PROBLEM;
      actualHash = now;
    } else if (now !== null && signature?.status === 'changed') {
      problem = SIGNATURE_FILE_CHANGED_PROBLEM;
      actualHash = now;
    }
  } else if (problem === CONTENT_MISMATCH_PROBLEM || problem === SIGNATURE_FILE_CHANGED_PROBLEM) {
    actualHash = await hashPackageContent(packageDir(row.name), row).catch((err: unknown) => {
      coreLogger.warn({ err, pkg: row.name }, 'Plugin package content could not be hashed for its view');
      return null;
    });
  }
  return {
    name: row.name,
    version: row.version,
    manifest: row.manifest,
    enabled: row.enabled,
    settings: row.settings,
    secretsSet: secrets,
    problem,
    network: networkStatus(row.manifest),
    connected,
    contentHash: row.contentHash,
    actualHash,
    signedBy: signature?.status === 'valid' ? signature.publisher : null,
    signature,
    runtime,
    inProcess,
    contributions: await contributionsView(row),
    approvedHostScopes: row.approvedHostScopes ?? null,
    modelCliTools: modelCliToolsView(row),
    authoredBy: authoredBy !== undefined ? authoredBy : await agentAuthorship(row.name),
    origin: row.origin ?? null,
    revocation: await revocationOf(row, signature),
    declarations: declarationItems(computePermissions(row.manifest), row.manifest),
    installedBy: row.installedBy,
    installedAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Why a package is revoked, for its view: its version (the marketplace's
 * signed index), or the key that signed it (the marketplace, or the config).
 */
async function revocationOf(row: PluginPackageRow, signature: PluginSignatureStatus | null): Promise<PluginRevocationView | null> {
  const pkg = await packageRevocation(row.name, row.version);
  if (pkg) return { kind: 'package', keyId: null, reason: pkg.reason, source: 'marketplace', since: pkg.firstSeenAt.toISOString() };
  if (signature?.status === 'revoked' && signature.keyId) {
    const key = await keyRevocation(signature.keyId);
    return key
      ? { kind: 'key', keyId: signature.keyId, reason: key.reason, source: 'marketplace', since: key.firstSeenAt.toISOString() }
      : { kind: 'key', keyId: signature.keyId, reason: signature.detail, source: 'config', since: null };
  }
  return null;
}

/** Why no runner wraps the server: off, none found, or Windows (no built-in one). */
const NO_RUNNER = 'security.shellSandbox off, no bwrap/firejail on Linux, no /usr/bin/sandbox-exec on macOS, or Windows, which has none';

/**
 * The signature over the package's approved content now: checked against the
 * recorded hash and the keys trusted now, in the signature file that was
 * approved with it (`changed` when it is another one). Recomputed for every
 * view (one small file read and one verification, no re-hash), so a key
 * removed, revoked or expired, or a replaced signature file shows at once;
 * the row's `signedBy` is what it was at install or approval (also audited).
 * Null before the first start of a package installed before pinning.
 */
async function currentSignature(row: PluginPackageRow): Promise<PluginSignatureStatus | null> {
  if (row.contentHash === null) return null;
  try {
    const sig = await signatureState(packageDir(row.name), row.contentHash, row.origin);
    if (sig.sha256 !== row.signatureHash) {
      return { status: 'changed', keyId: null, publisher: null, detail: `${SIGNATURE_FILE} changed since the content was approved` };
    }
    const c = sig.check;
    switch (c.status) {
      case 'valid': return { status: 'valid', keyId: c.keyId, publisher: c.publisher, detail: `Signed by ${c.publisher}` };
      case 'unsigned': return { status: 'unsigned', keyId: null, publisher: null, detail: 'Not signed' };
      case 'unknown_key': return { status: 'unknown_key', keyId: c.keyId, publisher: null, detail: `Signed by a key not in plugins.trustedPublishers (${c.keyId})` };
      case 'revoked':
      case 'expired': return { status: c.status, keyId: c.keyId, publisher: c.publisher, detail: `Signed, but ${c.detail}` };
      case 'invalid': return { status: 'invalid', keyId: null, publisher: null, detail: c.reason };
    }
  } catch (err) {
    coreLogger.warn({ err, pkg: row.name }, 'Plugin package signature could not be read for its view');
    return { status: 'invalid', keyId: null, publisher: null, detail: `Could not read the signature: ${(err as Error).message}` };
  }
}

/**
 * How a package's network is held on this host, decided the same way the
 * transport decides at start (`prepareSandboxedLaunch`): only a sandbox
 * runner (bwrap/firejail on Linux, sandbox-exec on macOS) can take direct
 * network away; without one the declared hosts are advice.
 */
export function networkStatus(m: PluginManifest, runner = activeSandboxRunner({ allowSeatbelt: true }), mode = getSandboxMode()): PluginNetworkStatus {
  if (pluginRuntime(m) === 'in-process') {
    return { state: 'not_enforced', detail: 'Runs in the server process: no sandbox, so it has the server\'s network, files and data.' };
  }
  // The host API counts as a host here: it is reached through the egress proxy (docs/PLUGIN-PACKAGES.md#host-api).
  const hosts = [...(m.network ?? []), ...((m.host ?? []).length > 0 ? ['the Octipus host API'] : [])];
  if (!runner && mode === 'required') {
    return { state: 'refused', detail: `Not started: security.shellSandbox is required and no sandbox can wrap the server here (${NO_RUNNER}).` };
  }
  if (runner) {
    return hosts.length === 0
      ? { state: 'offline', detail: `No network: the sandbox (${runner}) runs the server without one.` }
      : { state: 'restricted', detail: `Only ${hosts.join(', ')}: the sandbox (${runner}) has no direct network, and the egress proxy allows only the declared hosts.` };
  }
  return hosts.length === 0
    ? { state: 'not_enforced', detail: `Network not enforced on this platform: no sandbox wraps the server (${NO_RUNNER}), so nothing stops it from connecting.` }
    : { state: 'not_enforced', detail: `Network not enforced on this platform: no sandbox wraps the server (${NO_RUNNER}). It is pointed at an egress proxy that allows only ${hosts.join(', ')}, but it can still connect directly.` };
}

/** Every installed package, for the admin API. */
export async function listPackages(): Promise<PluginPackageView[]> {
  const rows = await getDb().select().from(pluginPackages).orderBy(pluginPackages.name);
  const entries = rows.some((r) => (r.manifest.secrets ?? []).length > 0) ? await getVault().list('system') : [];
  const authors = await agentAuthorships(rows.map((r) => r.name));
  return Promise.all(rows.map(async (row) => viewOf(row, await secretsSet(row, entries), authors.get(row.name) ?? null)));
}

/** One installed package, for the admin API. */
export async function packageView(name: string): Promise<PluginPackageView> {
  const row = await requireRow(name);
  return viewOf(row, await secretsSet(row));
}

/** The host API scopes a package is granted: declared and approved. */
export function grantedHostScopes(row: Pick<PluginPackageRow, 'manifest' | 'approvedHostScopes'>): PluginHostScope[] {
  const approved = new Set(row.approvedHostScopes ?? []);
  return (row.manifest.host ?? []).filter((s) => approved.has(s));
}

// defaultMaxProtection lives in ./permissions.ts (offline: the CLI computes a package's permissions without the server).
export { defaultMaxProtection } from './permissions';

/**
 * Host scopes that send what the package hands them out of the house: any URL
 * (`web:read`), a remote model (`model:complete`), an agent that searches and
 * fetches the web on the package's prompt (`agent:run`).
 */
export const EGRESS_HOST_SCOPES: readonly PluginHostScope[] = ['web:read', 'model:complete', 'agent:run'];

/**
 * The level a package may see, as enforced: its `maxProtection` (or the
 * default above), clamped to 1 while it is granted a scope that can carry
 * data out (`EGRESS_HOST_SCOPES`), whatever its manifest says: such a package
 * could pass whatever it reads to any URL or model.
 */
export function effectiveMaxProtection(
  m: Pick<PluginManifest, 'maxProtection' | 'network' | 'host' | 'ui'>, granted: readonly PluginHostScope[],
): 1 | 2 | 3 | 4 {
  const level = defaultMaxProtection(m);
  return granted.some((s) => EGRESS_HOST_SCOPES.includes(s)) ? 1 : level;
}

/** The MCP server an installed package runs as. */
export async function serverFor(row: PluginPackageRow): Promise<MCPServer> {
  const m = row.manifest;
  if (!m.server || !m.tools) throw new Error(`${row.name} runs in the server process; it has no MCP server`);
  const tools = m.tools;
  const env: Record<string, string> = {};
  for (const f of m.settings ?? []) {
    if (Object.hasOwn(row.settings, f.key)) env[settingEnvName(f.key)] = String(row.settings[f.key]);
  }
  const vault = getVault();
  for (const s of m.secrets ?? []) {
    const value = await vault.getSystemSecret(secretName(row.name, s.key));
    if (value !== null) env[s.key] = value;
  }
  const dir = packageDir(row.name);
  const dataDir = pluginDataDir(row.name);
  // Set last, so no secret can claim the name.
  env.OCTIPUS_PLUGIN_DATA_DIR = dataDir;
  // The host API (docs/PLUGIN-PACKAGES.md#host-api): only the declared scopes an
  // admin approved; reached through the egress proxy, whose only route to it is this.
  const hostScopes = grantedHostScopes(row);
  if (hostScopes.length > 0) env.OCTIPUS_HOST_URL = HOST_API_URL;
  const hosts = [...(m.network ?? [])];
  const egress = hosts.length > 0 || hostScopes.length > 0
    ? { egress: { label: row.name, hosts, runDir: pluginRunDir(), ...(hostScopes.length > 0 ? { hostApi: hostApiTarget() } : {}) } }
    : {};
  return {
    id: `${PLUGIN_SERVER_PREFIX}${row.name}`,
    name: m.title,
    description: m.description,
    command: m.server.command,
    args: m.server.args,
    cwd: dir,
    env,
    isolatedEnv: true,
    // Its files are read-only in the sandbox; it writes to its data directory.
    // Hosts go through the egress proxy; direct network stays off wherever the
    // sandbox can turn it off. allowNetwork is kept for a sandbox without egress support.
    sandbox: {
      root: dir, readOnlyRoot: true, writable: [dataDir], allowNetwork: hosts.length > 0,
      ...egress,
    },
    requestTimeoutMs: m.server.requestTimeoutMs,
    isEnabled: row.enabled,
    // Declared tools are reachable through mcp_list_tools / mcp_call_tool;
    // every other name the server offers is hidden (an exact name wins over `*`).
    toolExposure: { ...Object.fromEntries(Object.keys(tools).map((t) => [t, 'deferred' as const])), '*': 'hidden' },
    plugin: {
      package: row.name, version: row.version, tools: Object.fromEntries(Object.entries(tools).map(([t, d]) => [t, d.effect])),
      // Undeclared: see defaultMaxProtection; clamped by egress scopes (effectiveMaxProtection).
      maxProtection: effectiveMaxProtection(m, hostScopes),
      ...(hostScopes.length > 0 ? { hostScopes } : {}),
      // Its model calls may run on a CLI lane: declared and approved (docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes).
      ...(modelCliToolsGranted(row) ? { modelCliTools: true as const } : {}),
    },
  };
}

/** Refused starts already audited, keyed `<package>\n…` (the recorded and actual hashes, or the signature reason). */
const mismatchesAudited = new Set<string>();
const MAX_MISMATCHES_REMEMBERED = 1000;

/** Let a package's next mismatch be audited again (it was approved, reinstalled or removed). */
function forgetMismatches(name: string): void {
  for (const key of mismatchesAudited) if (key.startsWith(`${name}\n`)) mismatchesAudited.delete(key);
}

/** An audit row by the host itself; failing to write it is logged, never a reason to refuse or allow a start. */
async function auditQuietly(op: string, name: string, details: Record<string, unknown>): Promise<void> {
  try {
    await audit(SYSTEM_USER_ID, op, name, details);
  } catch (err) {
    coreLogger.error({ err, pkg: name, op }, 'Plugin package audit row could not be written');
  }
}

/** Audit a refused start once per `key` (which starts with `<package>\n`): a crash-looping reconnect does not flood the log. */
async function auditOnce(key: string, op: string, name: string, details: Record<string, unknown>): Promise<void> {
  if (mismatchesAudited.has(key)) return;
  if (mismatchesAudited.size >= MAX_MISMATCHES_REMEMBERED) mismatchesAudited.clear();
  mismatchesAudited.add(key);
  await auditQuietly(op, name, details);
}

/**
 * The check before every start of a package's server: its files against the
 * hash recorded when they were approved. The reason it may not start, or
 * null. A package with no recorded hash (installed before pinning) has the
 * current one recorded and starts: trust on first use, logged once. Under
 * `plugins.requireSignature` the files must also carry a valid signature by a
 * publisher trusted now (a key dropped from the config stops its packages).
 */
export async function checkBeforeStart(server: MCPServer): Promise<string | null> {
  const name = server.plugin?.package;
  if (!name) return null;
  return checkPackageBeforeStart(name);
}

/**
 * `checkBeforeStart` by package name: also the check before an in-process
 * plugin's module is loaded (./in-process.ts), so both runtimes run only the
 * bytes approved, under the same signature rules.
 */
export async function checkPackageBeforeStart(name: string): Promise<string | null> {
  const row = await findRow(name);
  if (!row) return `Plugin package ${name} is not installed`;
  let check: Awaited<ReturnType<typeof verifyPackageContent>>;
  try {
    check = await verifyPackageContent(packageDir(name), row, async (hash) => {
      // The signature file is pinned with it; one that is not canonical is refused below either way.
      const signatureHash = (await readSignatureFile(packageDir(name)).catch(() => null))?.sha256 ?? null;
      row.signatureHash = signatureHash;
      const pinned = await getDb().update(pluginPackages).set({ contentHash: hash, signatureHash })
        .where(and(eq(pluginPackages.name, name), isNull(pluginPackages.contentHash)))
        .returning({ name: pluginPackages.name });
      // Only the start that actually pinned it is audited (a concurrent one finds the hash set).
      if (pinned.length > 0) await auditQuietly('content_pinned_first_use', name, { version: row.version, hash });
    });
  } catch (err) {
    coreLogger.error({ err, pkg: name }, 'Plugin package content could not be hashed; not started');
    return `Could not check the package files: ${(err as Error).message}`;
  }
  if (check.status === 'first_use') {
    coreLogger.info({ pkg: name, version: row.version, hash: check.hash }, 'Plugin package had no content hash; recorded it on first start (trust on first use)');
  } else if (check.status === 'mismatch') {
    coreLogger.warn({ pkg: name, version: row.version, recorded: check.recorded, actual: check.actual }, 'Plugin package modified since it was approved (hash mismatch); not started');
    // Once per (package, recorded, actual): a crash-looping reconnect does not flood the log.
    await auditOnce(`${name}\n${check.recorded}\n${check.actual}`, 'content_mismatch', name, { version: row.version, recorded: check.recorded, actual: check.actual });
    return CONTENT_MISMATCH_PROBLEM;
  }
  // A version the marketplace revoked does not start, whatever else holds (docs/PLUGIN-PACKAGES.md#online-revocation).
  let revoked: Awaited<ReturnType<typeof packageRevocation>>;
  try {
    revoked = await packageRevocation(name, row.version);
  } catch (err) {
    coreLogger.error({ err, pkg: name }, 'Plugin package revocations could not be read; not started');
    return `Could not check whether the package is revoked: ${(err as Error).message}`;
  }
  if (revoked) {
    coreLogger.warn({ pkg: name, version: row.version, reason: revoked.reason }, 'Plugin package version is revoked; not started');
    await auditOnce(`${name}\npackage-revoked\n${row.version}`, 'package_revoked', name, { version: row.version, reason: revoked.reason });
    return `${name} ${row.version} is revoked by the marketplace (${revoked.reason || 'no reason given'}); it does not start. Upgrade to a version that is not revoked`;
  }
  let sig: SignatureState;
  try {
    sig = await signatureState(packageDir(name), check.hash, row.origin);
  } catch (err) {
    coreLogger.error({ err, pkg: name }, 'Plugin package signature could not be read; not started');
    return `Could not check the package signature: ${(err as Error).message}`;
  }
  // Whatever requireSignature says: the one unhashed file must be the canonical signature that was approved.
  if (sig.malformed) {
    coreLogger.warn({ pkg: name, version: row.version, reason: sig.malformed }, 'Plugin package signature file is not canonical; not started');
    await auditOnce(`${name}\nsignature-file\n${sig.malformed}`, 'signature_file_refused', name, { version: row.version, reason: sig.malformed });
    return `${sig.malformed}; remove it or sign the package again, then approve its content`;
  }
  if (sig.sha256 !== row.signatureHash) {
    coreLogger.warn({ pkg: name, version: row.version, recorded: row.signatureHash, actual: sig.sha256 }, 'Plugin package signature file changed since it was approved; not started');
    await auditOnce(`${name}\nsignature-hash\n${row.signatureHash}\n${sig.sha256}`, 'signature_file_mismatch', name, { version: row.version, recorded: row.signatureHash, actual: sig.sha256 });
    return SIGNATURE_FILE_CHANGED_PROBLEM;
  }
  // A revoked key stops the package whatever requireSignature says: it was
  // withdrawn because it can no longer be trusted. (An expired one is advice
  // unless requireSignature is on, below.)
  if (sig.check.status === 'revoked') {
    const shortfall = signatureShortfall(name, sig.check);
    coreLogger.warn({ pkg: name, version: row.version, keyId: sig.check.keyId }, 'Plugin package signed by a revoked key; not started');
    // Once per (package, key).
    await auditOnce(`${name}\nrevoked\n${sig.check.keyId}`, 'signature_revoked', name, { version: row.version, hash: check.hash, keyId: sig.check.keyId, publisher: sig.check.publisher });
    return `${shortfall}; it does not start until it is signed again by a trusted key (or its signature file is removed and its content approved)`;
  }
  if (signatureRequired()) {
    const signature = sig.check;
    if (signature.status !== 'valid') {
      const shortfall = signatureShortfall(name, signature);
      coreLogger.warn({ pkg: name, version: row.version, status: signature.status }, 'Plugin package has no valid trusted signature (plugins.requireSignature); not started');
      // Once per (package, hash, reason), like a mismatch.
      await auditOnce(`${name}\nsignature\n${check.hash}\n${shortfall}`, 'signature_refused', name, { version: row.version, hash: check.hash, status: signature.status, reason: shortfall });
      return `${shortfall}; plugins.requireSignature runs only packages signed by a trusted publisher`;
    }
  }
  return null;
}

/**
 * Give the bridge the servers of every installed package, enabled or not. A
 * package whose server cannot be prepared (its secrets cannot be read, say)
 * keeps the config it runs with, and the reason is shown as its problem.
 * In-process plugins have no server: the extension system loads and unloads
 * them to match their rows (./in-process.ts).
 */
export async function syncPluginServers(): Promise<void> {
  const rows = await getDb().select().from(pluginPackages);
  const bridge = getMCPBridge();
  bridge.setPluginStartGuard(checkBeforeStart);
  bridge.setPluginCallMeta(issueHostCallMeta);
  const servers: MCPServer[] = [];
  const problems = new Map<string, string>();
  for (const row of rows) {
    if (pluginRuntime(row.manifest) === 'in-process') continue;
    try {
      servers.push(await serverFor(row));
    } catch (err) {
      const id = `${PLUGIN_SERVER_PREFIX}${row.name}`;
      coreLogger.error({ err, pkg: row.name }, 'Plugin package could not be prepared; it keeps its current configuration');
      problems.set(id, `Could not prepare the server: ${(err as Error).message}`);
      const current = bridge.pluginServerConfig(id);
      if (current) servers.push(current);
    }
  }
  await bridge.setPluginServers(servers, problems);
  const { syncInProcessPlugins } = await import('./in-process');
  await syncInProcessPlugins();
  // Commands, schedules, events, prompt and context follow (./contributions).
  await syncContributions(rows);
}

async function audit(actorUserId: string, op: string, name: string, details: Record<string, unknown>): Promise<void> {
  await auditRepository.log({
    userId: actorUserId,
    action: 'settings_changed',
    resourceType: 'plugin_package',
    resourceId: name,
    details: { op, ...details },
  });
}
