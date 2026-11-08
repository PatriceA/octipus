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
import { cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { getConfig } from '@/config';
import { RecordValidationError, validateRecordData } from '@/core/records/fields';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { type PluginPackageRow, pluginPackages } from '@/db/schema/plugin-packages';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { activeSandboxRunner } from '@/security/shell-sandbox';
import { SYSTEM_USER_ID } from '@/security/principal';
import { getVault } from '@/security/vault';
import type { MCPServer } from '@/shared/mcp-server';
import { PLUGIN_MANIFEST_FILE, type PluginManifest, type PluginNetworkStatus, type PluginPackageView } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { CONTENT_MISMATCH_PROBLEM, hashPackageContent, isContentHash, verifyPackageContent } from './integrity';
import { ManifestError, parseManifest, settingEnvName } from './manifest';
import { checkSignatureOnDisk, readSignatureFile, SIGNATURE_FILE, type SignatureCheck, SignatureError } from './signature';
import { checkPackageTree, PackageTreeError } from './tree';

export class PluginPackageError extends Error {
  constructor(readonly code: 'not_found' | 'exists' | 'invalid' | 'incomplete' | 'conflict', message: string, readonly problems: string[] = [message]) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

/** Where installed packages live. */
export function pluginsRoot(): string {
  return join(resolve(getConfig().workspace.rootPath), 'plugin-packages');
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

/** The signing policy in force (`plugins.*`), read at each check so a config change applies to the next one. */
function signingPolicy(): { publishers: ReadonlyArray<{ name: string; publicKey: string }>; required: boolean } {
  const plugins = getConfig().plugins;
  return { publishers: plugins?.trustedPublishers ?? [], required: plugins?.requireSignature === true };
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

async function signatureState(dir: string, contentHash: string): Promise<SignatureState> {
  try {
    const onDisk = await readSignatureFile(dir);
    const check = checkSignatureOnDisk(onDisk, contentHash, signingPolicy().publishers, (publisher, reason) => {
      coreLogger.warn({ publisher, reason }, 'A key in plugins.trustedPublishers cannot be read; it trusts nothing');
    });
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
    case 'invalid': return `The signature of ${name} is invalid: ${check.reason}`;
  }
}

/**
 * The signature of files about to be installed: who signed them, or the
 * refusal. An invalid signature is always refused; unsigned files or an
 * unknown key are refused under `plugins.requireSignature` and otherwise
 * installed as unsigned (an unknown key with a warning).
 */
async function acceptSignature(
  dir: string,
  name: string,
  contentHash: string,
): Promise<{ signedBy: string | null; keyId: string | null; signatureHash: string | null; warnings: string[] }> {
  const state = await signatureState(dir, contentHash);
  const { check, sha256: signatureHash } = state;
  if (check.status === 'valid') return { signedBy: check.publisher, keyId: check.keyId, signatureHash, warnings: [] };
  const shortfall = signatureShortfall(name, check);
  if (check.status === 'invalid') throw new PluginPackageError('invalid', `${shortfall}; not installed`);
  if (signingPolicy().required) throw new PluginPackageError('invalid', `${shortfall}; plugins.requireSignature accepts only packages signed by a trusted publisher`);
  if (check.status === 'unknown_key') {
    coreLogger.warn({ pkg: name, keyId: check.keyId }, 'Plugin package signed by an untrusted key; installed as unsigned');
    return { signedBy: null, keyId: check.keyId, signatureHash, warnings: [`${shortfall}: installed as unsigned`] };
  }
  return { signedBy: null, keyId: null, signatureHash, warnings: [] };
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
 */
export async function installFromDirectory(
  sourceDir: string,
  actorUserId: string,
  opts: { upgrade?: boolean } = {},
): Promise<PluginPackageRow & { warnings: string[] }> {
  const source = resolve(sourceDir);
  const manifest = await readManifest(source);
  await checkTree(source);
  const target = packageDir(manifest.name);
  if (resolve(target) === source) throw new PluginPackageError('invalid', 'The package is already in the plugin directory');
  const db = getDb();
  const serverId = `${PLUGIN_SERVER_PREFIX}${manifest.name}`;

  let previous: PluginPackageRow | null = null;
  if (opts.upgrade) {
    const [disabled] = await db.update(pluginPackages).set({ enabled: false, updatedAt: new Date() })
      .where(eq(pluginPackages.name, manifest.name)).returning();
    if (!disabled) throw new PluginPackageError('not_found', `Plugin package not found: ${manifest.name}; install it first`);
    previous = disabled;
    await syncPluginServers();
  } else {
    const [claimed] = await db.insert(pluginPackages)
      .values({ name: manifest.name, version: manifest.version, manifest, enabled: false, settings: {}, installedBy: actorUserId })
      .onConflictDoNothing()
      .returning();
    if (!claimed) {
      const existing = await findRow(manifest.name);
      throw new PluginPackageError('exists', `Plugin package "${manifest.name}" is already installed (version ${existing?.version ?? '?'}); upgrade it instead`);
    }
  }

  const settings = previous ? keptSettings(manifest, previous.settings) : {};
  // Copy beside the target, hash the copy, then swap, so a failure anywhere
  // leaves the installed files (and the row that pins them) as they were.
  const staging = `${target}.installing-${process.pid}-${Date.now()}`;
  const swap = { done: false, backup: null as string | null };
  let row: PluginPackageRow;
  let contentHash: string;
  let signature: Awaited<ReturnType<typeof acceptSignature>>;
  try {
    await mkdir(pluginsRoot(), { recursive: true });
    await cp(source, staging, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    // Hashed as copied, so what the admin installs is what is pinned.
    contentHash = await hashPackageContent(staging, manifest);
    signature = await acceptSignature(staging, manifest.name, contentHash);
    await getMCPBridge().disconnect(serverId);
    row = await db.transaction(async (tx) => {
      const [updated] = await tx.update(pluginPackages)
        .set({ version: manifest.version, manifest, enabled: false, settings, contentHash, signatureHash: signature.signatureHash, signedBy: signature.signedBy, installedBy: actorUserId, updatedAt: new Date() })
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
    // A new install that could not copy its files is not installed.
    if (!previous) await db.delete(pluginPackages).where(eq(pluginPackages.name, manifest.name));
    throw err;
  }
  if (swap.backup) await rm(swap.backup, { recursive: true, force: true }).catch((err: unknown) => coreLogger.warn({ err, dir: swap.backup }, 'Could not remove the previous package files'));
  forgetMismatches(manifest.name);
  await audit(actorUserId, previous ? 'upgraded' : 'installed', manifest.name, {
    version: manifest.version, from: previous?.version ?? null, contentHash, signedBy: signature.signedBy, keyId: signature.keyId,
  });
  await syncPluginServers();
  return { ...row, warnings: signature.warnings };
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
 * Nothing is saved when a check fails.
 */
export async function configure(
  name: string,
  change: { settings?: unknown; enabled?: boolean; approveContent?: string | boolean },
  actorUserId: string,
): Promise<PluginPackageRow> {
  const row = await requireRow(name);
  if (change.approveContent !== undefined && !isContentHash(change.approveContent)) {
    throw new PluginPackageError('invalid',
      'approveContent takes the content hash you reviewed ("sha256:<64 hex>", shown as actualHash), not true: the files are approved only while they still hash to it');
  }
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
  if (enabled) {
    const missing = await missingConfiguration({ ...row, settings });
    if (missing.length > 0) {
      throw new PluginPackageError('incomplete', `Set ${missing.join(', ')} before enabling ${name}`, missing.map((m) => `${m}: required`));
    }
  }
  let contentHash = row.contentHash;
  let signedBy = row.signedBy;
  let signatureHash = row.signatureHash;
  const required = signingPolicy().required;
  /** Under requireSignature: refuse unless the files carry a valid trusted signature over `hash`. */
  const refuseUnsigned = (check: SignatureCheck, doing: string): void => {
    if (!required || check.status === 'valid') return;
    throw new PluginPackageError('incomplete',
      `${signatureShortfall(name, check)}; plugins.requireSignature refuses ${doing} it until it carries a valid signature by a trusted publisher`);
  };
  const approving = typeof change.approveContent === 'string' ? change.approveContent : null;
  if (approving) {
    const actual = await hashPackageContent(packageDir(name), row);
    if (actual !== approving) {
      throw new PluginPackageError('conflict',
        `The files of ${name} hash to ${actual}, not to the reviewed ${approving}: they changed since they were reviewed; review them again`,
        [`approveContent: reviewed ${approving}, actual ${actual}`]);
    }
    contentHash = actual;
    // Approved content is the publisher's only if their signature covers it. A
    // signature left from before the change no longer matches: it reads as
    // invalid, and signedBy clears.
    const sig = await signatureState(packageDir(name), actual);
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
          [`contentHash: recorded ${row.contentHash}, actual ${actual}`]);
      }
    }
    const sig = await signatureState(packageDir(name), actual ?? await hashPackageContent(packageDir(name), row));
    if (sig.malformed) throw new PluginPackageError('incomplete', `${sig.malformed}; remove it or sign the package again before enabling ${name}`);
    if (row.contentHash !== null && sig.sha256 !== row.signatureHash) {
      throw new PluginPackageError('incomplete',
        `${SIGNATURE_FILE} of ${name} changed since its content was approved (recorded ${row.signatureHash ?? 'none'}, actual ${sig.sha256 ?? 'none'}); approve its content before enabling it`);
    }
    refuseUnsigned(sig.check, 'enabling');
  }
  const [updated] = await getDb().update(pluginPackages).set({ settings, enabled, contentHash, signatureHash, signedBy, updatedAt: new Date() }).where(eq(pluginPackages.name, name)).returning();
  if (approving) {
    forgetMismatches(name);
    await audit(actorUserId, 'content_approved', name, { version: row.version, from: row.contentHash, to: contentHash, signedBy, previousSignedBy: row.signedBy, signatureHash });
  }
  if (change.settings !== undefined) await audit(actorUserId, 'settings_changed', name, { keys: Object.keys(change.settings as object) });
  if (change.enabled !== undefined && change.enabled !== row.enabled) await audit(actorUserId, enabled ? 'enabled' : 'disabled', name, { version: row.version });
  await syncPluginServers();
  return updated;
}

/** Accept a package's files, if they still hash to the reviewed `hash` (`configure` with `approveContent` alone). */
export function approveContent(name: string, hash: string, actorUserId: string): Promise<PluginPackageRow> {
  return configure(name, { approveContent: hash }, actorUserId);
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

async function viewOf(row: PluginPackageRow, secrets: string[]): Promise<PluginPackageView> {
  const bridge = getMCPBridge();
  const serverId = `${PLUGIN_SERVER_PREFIX}${row.name}`;
  const problem = row.enabled ? bridge.pluginProblem(serverId) : null;
  // Only on a mismatch, so a listing does not hash every package: what the
  // files hash to now, for the admin to review and pass as approveContent.
  let actualHash: string | null = null;
  if (problem === CONTENT_MISMATCH_PROBLEM || problem === SIGNATURE_FILE_CHANGED_PROBLEM) {
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
    connected: bridge.isConnected(serverId),
    contentHash: row.contentHash,
    actualHash,
    signedBy: await currentSigner(row),
    installedBy: row.installedBy,
    installedAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Why no runner wraps the server: off, none found, or Windows (no built-in one). */
const NO_RUNNER = 'security.shellSandbox off, no bwrap/firejail on Linux, no /usr/bin/sandbox-exec on macOS, or Windows, which has none';

/**
 * Who signs the package's approved content now: the publisher of a valid
 * signature over the recorded hash, by a key trusted now, in the signature
 * file that was approved with it. Recomputed for every view (one small file
 * read and one verification, no re-hash), so a key removed from
 * `plugins.trustedPublishers` or a replaced signature file shows at once;
 * the row's `signedBy` is what it was at install or approval (also audited).
 */
async function currentSigner(row: PluginPackageRow): Promise<string | null> {
  if (row.contentHash === null) return null;
  try {
    const sig = await signatureState(packageDir(row.name), row.contentHash);
    return sig.check.status === 'valid' && sig.sha256 === row.signatureHash ? sig.check.publisher : null;
  } catch (err) {
    coreLogger.warn({ err, pkg: row.name }, 'Plugin package signature could not be read for its view');
    return null;
  }
}

/**
 * How a package's network is held on this host, decided the same way the
 * transport decides at start (`prepareSandboxedLaunch`): only a sandbox
 * runner (bwrap/firejail on Linux, sandbox-exec on macOS) can take direct
 * network away; without one the declared hosts are advice.
 */
export function networkStatus(m: PluginManifest, runner = activeSandboxRunner({ allowSeatbelt: true })): PluginNetworkStatus {
  const hosts = m.network ?? [];
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
  return Promise.all(rows.map(async (row) => viewOf(row, await secretsSet(row, entries))));
}

/** One installed package, for the admin API. */
export async function packageView(name: string): Promise<PluginPackageView> {
  const row = await requireRow(name);
  return viewOf(row, await secretsSet(row));
}

/** The MCP server an installed package runs as. */
export async function serverFor(row: PluginPackageRow): Promise<MCPServer> {
  const m = row.manifest;
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
      root: dir, readOnlyRoot: true, writable: [dataDir], allowNetwork: (m.network ?? []).length > 0,
      ...((m.network ?? []).length > 0 ? { egress: { label: row.name, hosts: [...(m.network ?? [])], runDir: pluginRunDir() } } : {}),
    },
    requestTimeoutMs: m.server.requestTimeoutMs,
    isEnabled: row.enabled,
    // Declared tools are reachable through mcp_list_tools / mcp_call_tool;
    // every other name the server offers is hidden (an exact name wins over `*`).
    toolExposure: { ...Object.fromEntries(Object.keys(m.tools).map((t) => [t, 'deferred' as const])), '*': 'hidden' },
    plugin: {
      package: row.name, version: row.version, tools: Object.fromEntries(Object.entries(m.tools).map(([t, d]) => [t, d.effect])),
      // Undeclared: a package that reaches the network leaves the house (1); one that cannot keeps everything in (4).
      maxProtection: m.maxProtection ?? ((m.network ?? []).length > 0 ? 1 : 4),
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
  let sig: SignatureState;
  try {
    sig = await signatureState(packageDir(name), check.hash);
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
  if (signingPolicy().required) {
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
 */
export async function syncPluginServers(): Promise<void> {
  const rows = await getDb().select().from(pluginPackages);
  const bridge = getMCPBridge();
  bridge.setPluginStartGuard(checkBeforeStart);
  const servers: MCPServer[] = [];
  const problems = new Map<string, string>();
  for (const row of rows) {
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
