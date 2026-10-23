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
 *   directory as the only writable one and network only when it declares a
 *   host;
 * - with only its declared tools reachable, each permitted by its declared
 *   effect (src/security/mcp-authorization.ts).
 *
 * Every change re-syncs the bridge (`syncPluginServers`), which restarts the
 * package's server when its config changed.
 */
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { getConfig } from '@/config';
import { RecordValidationError, validateRecordData } from '@/core/records/fields';
import { getDb } from '@/db/postgres';
import { auditRepository } from '@/db/repositories/audit-repository';
import { type PluginPackageRow, pluginPackages } from '@/db/schema/plugin-packages';
import { getMCPBridge, PLUGIN_SERVER_PREFIX } from '@/mcp/bridge';
import { getVault } from '@/security/vault';
import type { MCPServer } from '@/shared/mcp-server';
import { PLUGIN_MANIFEST_FILE, type PluginManifest, type PluginPackageView } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { ManifestError, parseManifest, settingEnvName } from './manifest';

/** Largest package a directory install copies (bytes). */
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
/** Most files a directory install copies. */
const MAX_PACKAGE_FILES = 20_000;

export class PluginPackageError extends Error {
  constructor(readonly code: 'not_found' | 'exists' | 'invalid' | 'incomplete', message: string, readonly problems: string[] = [message]) {
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

/**
 * Walk a package directory before copying it: no symbolic links (a link
 * could carry a host file into the plugin directory, or out of it), and
 * bounded size and file count.
 */
async function checkTree(dir: string): Promise<void> {
  let bytes = 0;
  let files = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new PluginPackageError('invalid', `The package contains a symbolic link (${full}); copy real files instead`);
      if (info.isDirectory()) await walk(full);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > MAX_PACKAGE_FILES) throw new PluginPackageError('invalid', `The package has more than ${MAX_PACKAGE_FILES} files`);
        if (bytes > MAX_PACKAGE_BYTES) throw new PluginPackageError('invalid', `The package is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`);
      } else throw new PluginPackageError('invalid', `The package contains a special file (${full})`);
    }
  };
  await walk(dir);
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

/**
 * Install a package from a local directory. With `upgrade`, an installed
 * package of the same name is replaced: its settings stay, and it is disabled
 * until an admin enables the new version (its tools may have changed).
 *
 * The row is claimed before any file moves: a new name is inserted first (a
 * concurrent install of the same name gets `exists`), and an upgrade is
 * disabled first, so a failure partway never leaves an enabled row whose old
 * manifest governs new code.
 */
export async function installFromDirectory(sourceDir: string, actorUserId: string, opts: { upgrade?: boolean } = {}): Promise<PluginPackageRow> {
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

  try {
    await mkdir(pluginsRoot(), { recursive: true });
    // Copy beside the target, then swap, so a failed copy leaves the installed files as they were.
    const staging = `${target}.installing-${process.pid}-${Date.now()}`;
    await cp(source, staging, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
    await getMCPBridge().disconnect(serverId);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
  } catch (err) {
    // A new install that could not copy its files is not installed.
    if (!previous) await db.delete(pluginPackages).where(eq(pluginPackages.name, manifest.name));
    throw err;
  }

  const settings = previous ? keptSettings(manifest, previous.settings) : {};
  const [row] = await db.update(pluginPackages)
    .set({ version: manifest.version, manifest, enabled: false, settings, installedBy: actorUserId, updatedAt: new Date() })
    .where(eq(pluginPackages.name, manifest.name))
    .returning();
  await audit(actorUserId, previous ? 'upgraded' : 'installed', manifest.name, { version: manifest.version, from: previous?.version ?? null });
  await syncPluginServers();
  return row;
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
  const entries = (row.manifest.secrets ?? []).length > 0 ? await getVault().list('system') : [];
  for (const s of row.manifest.secrets ?? []) await deleteSecret(name, s.key, entries);
  await audit(actorUserId, 'uninstalled', name, { version: row.version });
  await syncPluginServers();
}

/**
 * Change a package's settings and/or turn it on or off, in one write.
 * Settings are checked against the fields its manifest declares; turning it
 * on (or keeping it on) requires every required setting and secret to have a
 * value. Nothing is saved when either check fails.
 */
export async function configure(
  name: string,
  change: { settings?: unknown; enabled?: boolean },
  actorUserId: string,
): Promise<PluginPackageRow> {
  const row = await requireRow(name);
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
  const [updated] = await getDb().update(pluginPackages).set({ settings, enabled, updatedAt: new Date() }).where(eq(pluginPackages.name, name)).returning();
  if (change.settings !== undefined) await audit(actorUserId, 'settings_changed', name, { keys: Object.keys(change.settings as object) });
  if (change.enabled !== undefined && change.enabled !== row.enabled) await audit(actorUserId, enabled ? 'enabled' : 'disabled', name, { version: row.version });
  await syncPluginServers();
  return updated;
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

function viewOf(row: PluginPackageRow, secrets: string[]): PluginPackageView {
  const bridge = getMCPBridge();
  const serverId = `${PLUGIN_SERVER_PREFIX}${row.name}`;
  return {
    name: row.name,
    version: row.version,
    manifest: row.manifest,
    enabled: row.enabled,
    settings: row.settings,
    secretsSet: secrets,
    problem: row.enabled ? bridge.pluginProblem(serverId) : null,
    connected: bridge.isConnected(serverId),
    installedBy: row.installedBy,
    installedAt: row.installedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
  return {
    id: `${PLUGIN_SERVER_PREFIX}${row.name}`,
    name: m.title,
    description: m.description,
    command: m.server.command,
    args: m.server.args,
    cwd: dir,
    env,
    isolatedEnv: true,
    sandbox: { root: dir, allowNetwork: (m.network ?? []).length > 0 },
    requestTimeoutMs: m.server.requestTimeoutMs,
    isEnabled: row.enabled,
    // Declared tools are reachable through mcp_list_tools / mcp_call_tool;
    // every other name the server offers is hidden (an exact name wins over `*`).
    toolExposure: { ...Object.fromEntries(Object.keys(m.tools).map((t) => [t, 'deferred' as const])), '*': 'hidden' },
    plugin: { package: row.name, version: row.version, tools: Object.fromEntries(Object.entries(m.tools).map(([t, d]) => [t, d.effect])) },
  };
}

/**
 * Give the bridge the servers of every installed package, enabled or not. A
 * package whose server cannot be prepared (its secrets cannot be read, say)
 * keeps the config it runs with, and the reason is shown as its problem.
 */
export async function syncPluginServers(): Promise<void> {
  const rows = await getDb().select().from(pluginPackages);
  const bridge = getMCPBridge();
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
