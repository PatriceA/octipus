/**
 * Check a plugin directory the way an install would, without installing it
 * (creator mode, docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent):
 * the manifest against the contract, the contributions against what is
 * installed, the tree (no links, no special files, size), and that the files
 * the server is started from are in the package. Every problem is reported at
 * once; `warnings` are what would not refuse the install but may not work.
 */
import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join, normalize, sep } from 'node:path';
import { PLUGIN_MANIFEST_FILE, type PluginManifest, pluginRuntime } from '@/shared/plugin-package';
import { contributionInstallProblems } from '../contributions';
import { hashPackageContent } from '../integrity';
import { ManifestError, manifestSchema, parseManifest } from '../manifest';
import { checkPackageTree, PackageTreeError } from '../tree';

export interface PluginValidation {
  /** No problem: the install would accept it (an admin still has to enable it). */
  ok: boolean;
  name: string | null;
  version: string | null;
  /** What the package hashes to now: the content hash an install would record. Null while the tree is refused. */
  contentHash: string | null;
  /** What refuses the install. */
  problems: string[];
  /** What would not refuse it but may not work. */
  warnings: string[];
}

/** The refusal an agent gets for an in-process plugin, at validation and at install. */
export const IN_PROCESS_REFUSAL = 'runtime "in-process": an agent cannot install a plugin that runs in the server process. '
  + 'Write a sandboxed package instead (leave runtime out, or "package"): a server, its tools and their effects.';

/** An argument that names a file of the package, by its look: a path or a script extension. */
const FILE_ARG_RE = /[/\\]|\.(?:m?js|cjs|ts|mts|py|rb|sh|php|pl|jar|wasm)$/i;

/**
 * The manifest's problems, each with the field it is about: the install's
 * messages leave the path out when the message has a colon of its own
 * ("Invalid option: …"), which tells an author nothing about where.
 */
function manifestProblems(json: unknown, err: ManifestError): string[] {
  const parsed = manifestSchema.safeParse(json);
  if (parsed.success) return err.problems;
  return parsed.error.issues.map((i) => {
    const path = i.path.map(String).join('.');
    return path && !i.message.startsWith(`${String(i.path[0])}`) ? `${path}: ${i.message}` : i.message;
  });
}

/** Whether `rel` stays inside the package: relative, no `..` segment out of it. */
function insidePackage(rel: string): boolean {
  if (isAbsolute(rel)) return false;
  const norm = normalize(rel);
  return norm !== '..' && !norm.startsWith(`..${sep}`) && !norm.startsWith('../');
}

async function isFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isFile() === true;
}

/** Whether a bare command name is found on this host's PATH. */
async function onPath(command: string): Promise<boolean> {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (await access(join(dir, command + ext), constants.X_OK).then(() => true, () => false)) return true;
    }
  }
  return false;
}

/** The files `server.command` and `server.args` start the package from: each must be in the package. */
async function serverProblems(dir: string, server: NonNullable<PluginManifest['server']>, warnings: string[]): Promise<string[]> {
  const problems: string[] = [];
  const command = server.command;
  if (isAbsolute(command)) {
    warnings.push(`server.command: ${command} is an absolute path; it ties the package to hosts that have it there`);
  } else if (/[/\\]/.test(command)) {
    if (!insidePackage(command)) problems.push(`server.command: ${command} leads outside the package`);
    else if (!await isFile(join(dir, command))) problems.push(`server.command: ${command} is not a file in the package`);
  } else if (!await onPath(command)) {
    warnings.push(`server.command: "${command}" is not on this host's PATH; the server would not start here`);
  }
  for (const arg of server.args ?? []) {
    if (arg.startsWith('-') || !FILE_ARG_RE.test(arg) || /^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) continue;
    if (!insidePackage(arg)) {
      problems.push(`server.args: ${arg} leads outside the package (the server runs from the package directory; reference its own files)`);
    } else if (!await isFile(join(dir, arg))) {
      problems.push(`server.args: ${arg} is not a file in the package`);
    }
  }
  return problems;
}

/**
 * Validate the package in `dir`. `installed` are the packages installed
 * now (their names and manifests), for command-name clashes; leave it out
 * to check the package alone.
 */
export async function validatePluginDirectory(
  dir: string,
  installed: ReadonlyArray<{ name: string; version: string; manifest: PluginManifest }> = [],
): Promise<PluginValidation> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const result = (manifest: PluginManifest | null, contentHash: string | null): PluginValidation => ({
    ok: problems.length === 0, name: manifest?.name ?? null, version: manifest?.version ?? null, contentHash, problems, warnings,
  });

  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) {
    problems.push(`${dir} is not a directory`);
    return result(null, null);
  }
  let raw: string;
  try {
    raw = await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8');
  } catch {
    problems.push(`No ${PLUGIN_MANIFEST_FILE} at the root of ${dir}`);
    return result(null, null);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    problems.push(`${PLUGIN_MANIFEST_FILE} is not valid JSON: ${(err as Error).message}`);
    return result(null, null);
  }
  if ((json as { runtime?: unknown } | null)?.runtime === 'in-process') problems.push(IN_PROCESS_REFUSAL);

  let manifest: PluginManifest | null = null;
  try {
    manifest = parseManifest(json);
  } catch (err) {
    if (!(err instanceof ManifestError)) throw err;
    problems.push(...manifestProblems(json, err).map((p) => `${PLUGIN_MANIFEST_FILE}: ${p}`));
  }

  let treeOk = true;
  try {
    await checkPackageTree(dir);
  } catch (err) {
    if (!(err instanceof PackageTreeError)) throw err;
    problems.push(err.message);
    treeOk = false;
  }
  if (!manifest) return result(null, null);
  if (pluginRuntime(manifest) === 'in-process') return result(manifest, null);

  if (manifest.server) problems.push(...await serverProblems(dir, manifest.server, warnings));
  problems.push(...await contributionInstallProblems(manifest, dir, installed));
  const current = installed.find((p) => p.name === manifest.name);
  if (current) {
    warnings.push(`${manifest.name} is installed (version ${current.version}): plugin_install with upgrade: true replaces it, only if an agent of the same user installed it`);
  }
  return result(manifest, treeOk ? await hashPackageContent(dir, manifest) : null);
}
