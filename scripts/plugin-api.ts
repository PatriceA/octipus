/**
 * `octi plugin list`, `approve`, `set`, `secret` and `uninstall`
 * (docs/PLUGIN-PACKAGES.md): the installed plugin packages, through the
 * running backend's API.
 *
 * Authenticates the way the other CLI commands that call the backend do: a
 * bearer API token from `OCTIPUS_API_TOKEN` (docs/API.md; `octi persona`),
 * or `OCTIPUS_TOKEN` (`octi doctor`), against `http://localhost:$API_PORT`.
 * The routes are admin-only, so the token must belong to an admin.
 *
 * Kept apart from scripts/plugin.ts (which runs on import) so it can be
 * tested with a fetch and a prompt of the test's own.
 */
import type { PluginPackageView } from '@/shared/plugin-package';

export interface PluginApiIo {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Whether a person can answer a question (stdin and stdout are a terminal). */
  interactive: boolean;
  /** Ask a yes/no question; resolves to the answer typed. */
  ask: (question: string) => Promise<string>;
  /**
   * Read a secret value: at a terminal a prompt that does not echo, else all
   * of stdin. Never from the command line, where it would land in the shell
   * history and the process list.
   */
  readSecret: (prompt: string) => Promise<string>;
}

/** The backend's base URL, as `octi capabilities`, `octi persona` and `octi doctor` reach it. */
export function backendBase(env: NodeJS.ProcessEnv): string {
  const port = env.API_PORT || env.PORT || '3005';
  // Only a port: `1@evil.example` would send the bearer token to another host.
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new CliError(`API_PORT must be a port number (1-65535), not ${JSON.stringify(port)}`, 2);
  }
  return `http://localhost:${port}`;
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.OCTIPUS_API_TOKEN || env.OCTIPUS_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

async function request<T>(io: PluginApiIo, method: string, path: string, body?: unknown): Promise<T> {
  const base = backendBase(io.env);
  let res: Response;
  try {
    res = await io.fetch(`${base}/api/plugin-packages${path}`, {
      method,
      headers: { ...authHeaders(io.env), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new CliError(`backend unreachable at ${base} (${(err as Error).message}). Run \`octi start\` first.`);
  }
  const data = await res.json().catch(() => ({})) as { error?: string; problems?: string[]; actualHash?: string };
  if (res.status === 401 || res.status === 403) {
    throw new CliError(`the backend refused (${res.status}): set OCTIPUS_API_TOKEN to an admin API token (Settings → API Tokens).`);
  }
  if (!res.ok) {
    const problems = (data.problems ?? []).filter((p) => p !== data.error);
    const next = data.actualHash ? [`  the files hash to ${data.actualHash} now; review them, then: octi plugin approve <name> --hash ${data.actualHash}`] : [];
    throw new CliError([data.error ?? `HTTP ${res.status}`, ...problems.map((p) => `  ${p}`), ...next].join('\n'));
  }
  return data as T;
}

function line(p: PluginPackageView): string {
  const state = p.problem ? `problem: ${p.problem}` : p.enabled ? (p.connected ? 'running' : 'enabled, not connected') : 'disabled';
  const signer = p.signature ? `${p.signature.status}${p.signature.publisher ? ` (${p.signature.publisher})` : ''}` : 'not pinned yet';
  return [
    `${p.name} ${p.version}  ${state}`,
    `    signature: ${signer}; network: ${p.network.state}`,
    `    content:   ${p.contentHash ?? 'not pinned yet'}`,
    ...(p.actualHash ? [`    actual:    ${p.actualHash}   (approve with: octi plugin approve ${p.name} --hash ${p.actualHash})`] : []),
  ].join('\n');
}

/** `octi plugin list`: every installed package, its state, signature, network and hashes. */
export async function listCommand(io: PluginApiIo): Promise<number> {
  try {
    const packages = await request<PluginPackageView[]>(io, 'GET', '/');
    if (packages.length === 0) io.out('No plugin packages installed.\n');
    for (const p of packages) io.out(`${line(p)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin list: ${err.message}\n`);
    return err.exitCode;
  }
}

/**
 * `octi plugin approve <name> [--hash sha256:…]`: approve the package's
 * changed content. With --hash, that hash is sent as reviewed; without it,
 * the actual hash is shown and must be confirmed at a terminal (refused
 * otherwise). The backend hashes the files again and refuses (409) when they
 * no longer hash to it.
 */
export async function approveCommand(io: PluginApiIo, name: string, hash: string | undefined): Promise<number> {
  try {
    if (hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new CliError('--hash takes sha256:<64 hex>, the actual hash `octi plugin list` shows', 2);
    let reviewed = hash;
    if (reviewed === undefined) {
      const packages = await request<PluginPackageView[]>(io, 'GET', '/');
      const pkg = packages.find((p) => p.name === name);
      if (!pkg) throw new CliError(`no plugin package named ${name}`);
      if (!pkg.actualHash) {
        io.out(`${name} has no content waiting for approval${pkg.problem ? ` (its problem: ${pkg.problem})` : ''}.\n`);
        return 0;
      }
      io.out(`${line(pkg)}\n\n`);
      if (!io.interactive) {
        throw new CliError(`not at a terminal: review the files of ${name}, then run\n  octi plugin approve ${name} --hash ${pkg.actualHash}`, 2);
      }
      const answer = (await io.ask(`Approve the content of ${name} that hashes to ${pkg.actualHash}? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        io.out('Not approved.\n');
        return 1;
      }
      reviewed = pkg.actualHash;
    }
    const view = await request<PluginPackageView>(io, 'PATCH', `/${encodeURIComponent(name)}`, { approveContent: reviewed });
    io.out(`Approved ${name}: content ${view.contentHash}${view.signedBy ? `, signed by ${view.signedBy}` : ', unsigned'}.\n`);
    if (view.problem) io.out(`  still: ${view.problem}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin approve: ${err.message}\n`);
    return err.exitCode;
  }
}

/** A package name as the backend accepts it in a path: checked here so a typo is not sent as some other path. */
function checkName(name: string): void {
  if (!/^[a-z][a-z0-9-]{1,49}$/.test(name)) throw new CliError(`${JSON.stringify(name)} is not a plugin package name`, 2);
}

/**
 * `octi plugin uninstall <name> [--yes]`: remove a package, its files, data
 * directory, settings and secrets. Asks at a terminal; not at one, it is
 * refused unless --yes says so.
 */
export async function uninstallCommand(io: PluginApiIo, name: string, yes: boolean): Promise<number> {
  try {
    checkName(name);
    if (!yes) {
      if (!io.interactive) throw new CliError(`not at a terminal: run \`octi plugin uninstall ${name} --yes\` to remove it without asking`, 2);
      const answer = (await io.ask(`Uninstall ${name}? Its files, data directory, settings and secrets are deleted. [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        io.out('Not uninstalled.\n');
        return 1;
      }
    }
    await request<{ uninstalled: boolean }>(io, 'DELETE', `/${encodeURIComponent(name)}`);
    io.out(`Uninstalled ${name}.\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin uninstall: ${err.message}\n`);
    return err.exitCode;
  }
}

/** `key=value` pairs as the settings a PATCH sends: `key=` clears the setting (null). */
export function parseSettingPairs(pairs: readonly string[]): Record<string, string | null> {
  if (pairs.length === 0) throw new CliError('give at least one key=value', 2);
  const out: Record<string, string | null> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = at < 0 ? '' : pair.slice(0, at);
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key)) throw new CliError(`"${pair}": expected key=value with a setting key (lower-case letters, digits, _)`, 2);
    if (Object.hasOwn(out, key)) throw new CliError(`${key} is given twice`, 2);
    const value = pair.slice(at + 1);
    out[key] = value.trim() === '' ? null : value;
  }
  return out;
}

/**
 * `octi plugin set <name> key=value...`: change settings (not secrets: see
 * `octi plugin secret`). Values go as typed and the backend checks them
 * against the manifest's fields (numbers, `true`/`false`, choices); `key=`
 * clears one. All or nothing.
 */
export async function setCommand(io: PluginApiIo, name: string, pairs: readonly string[]): Promise<number> {
  try {
    checkName(name);
    const settings = parseSettingPairs(pairs);
    const view = await request<PluginPackageView>(io, 'PATCH', `/${encodeURIComponent(name)}`, { settings });
    const shown = Object.entries(view.settings).map(([k, v]) => `${k}=${String(v)}`);
    io.out(`Saved the settings of ${name}${shown.length ? `: ${shown.join(' ')}` : ' (none set)'}.\n`);
    if (view.problem) io.out(`  still: ${view.problem}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin set: ${err.message}\n`);
    return err.exitCode;
  }
}

/**
 * `octi plugin secret <name> <KEY> [--clear]`: set one declared secret,
 * reading its value from a prompt that does not echo (at a terminal) or from
 * stdin (`… < file`, `printf %s "$X" | …`), never from the command line; one
 * trailing newline is dropped. `--clear` removes it. The value is never shown.
 */
export async function secretCommand(io: PluginApiIo, name: string, key: string, clear: boolean): Promise<number> {
  try {
    checkName(name);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new CliError(`${JSON.stringify(key)} is not a secret key (an environment variable name)`, 2);
    let value: string | null = null;
    if (!clear) {
      try {
        value = (await io.readSecret(`Value for ${key} of ${name} (not shown): `)).replace(/\r?\n$/, '');
      } catch (err) {
        throw new CliError(`no value read for ${key}: ${(err as Error).message}`);
      }
      if (value.trim() === '') throw new CliError(`no value given for ${key}; use --clear to remove it`, 2);
    }
    await request<{ saved: boolean }>(io, 'PUT', `/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`, { value });
    io.out(clear ? `Removed ${key} of ${name}.\n` : `Saved ${key} of ${name}.\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin secret: ${err.message}\n`);
    return err.exitCode;
  }
}
