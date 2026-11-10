/**
 * `octi plugin list`, `approve`, `approve-in-process`, `approve-contributions`, `set`, `secret` and `uninstall`
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
import { parseArgs } from 'node:util';
import { MAX_PLUGIN_SECRET_LENGTH, type PluginPackageView } from '@/shared/plugin-package';

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
  const data = await res.json().catch(() => ({})) as { error?: string; problems?: string[]; actualHash?: string; contributionsHash?: string };
  if (res.status === 401 || res.status === 403) {
    throw new CliError(`the backend refused (${res.status}): set OCTIPUS_API_TOKEN to an admin API token (Settings → API Tokens).`);
  }
  if (!res.ok) {
    const problems = (data.problems ?? []).filter((p) => p !== data.error);
    const next = [
      ...(data.actualHash ? [`  the files hash to ${data.actualHash} now; review them, then: octi plugin approve <name> --hash ${data.actualHash}`] : []),
      ...(data.contributionsHash ? [`  its contributions hash to ${data.contributionsHash}; review them (octi plugin approve-contributions <name>), then: octi plugin approve-contributions <name> --hash ${data.contributionsHash}`] : []),
    ];
    throw new CliError([data.error ?? `HTTP ${res.status}`, ...problems.map((p) => `  ${p}`), ...next].join('\n'));
  }
  return data as T;
}

function line(p: PluginPackageView): string {
  const inProcess = p.runtime === 'in-process';
  const running = inProcess ? (p.connected ? 'loaded' : 'enabled, not loaded') : (p.connected ? 'running' : 'enabled, not connected');
  const state = p.problem ? `problem: ${p.problem}` : p.enabled ? running : 'disabled';
  const signer = p.signature ? `${p.signature.status}${p.signature.publisher ? ` (${p.signature.publisher})` : ''}` : 'not pinned yet';
  const approval = p.inProcess?.approved
    ? `approved for ${p.inProcess.approvedHash}`
    : `not approved (approve with: octi plugin approve-in-process ${p.name} --hash ${p.contentHash ?? '<content hash>'})`;
  return [
    `${p.name} ${p.version}  ${state}`,
    `    runtime:   ${p.runtime ?? 'package'}`,
    `    signature: ${signer}; network: ${p.network.state}`,
    `    content:   ${p.contentHash ?? 'not pinned yet'}`,
    ...(p.actualHash ? [`    actual:    ${p.actualHash}   (approve with: octi plugin approve ${p.name} --hash ${p.actualHash})`] : []),
    ...(inProcess ? [`    in-process: ${approval}`] : []),
    ...(p.contributions?.hash ? [`    contributions: ${p.contributions.approved ? `approved (${p.contributions.hash})` : `not approved (review: octi plugin approve-contributions ${p.name})`}`] : []),
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

/**
 * `octi plugin approve-in-process <name> [--hash sha256:…]`: approve an
 * in-process plugin to run in the server process, for its approved content.
 * With --hash, that hash is sent as reviewed; without it, the approved
 * content hash is shown and must be confirmed at a terminal (refused
 * otherwise). The backend refuses (409) a hash that is not the approved
 * content, or files that no longer hash to it.
 */
export async function approveInProcessCommand(io: PluginApiIo, name: string, hash: string | undefined): Promise<number> {
  try {
    checkName(name);
    if (hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new CliError('--hash takes sha256:<64 hex>, the content hash `octi plugin list` shows', 2);
    let reviewed = hash;
    if (reviewed === undefined) {
      const packages = await request<PluginPackageView[]>(io, 'GET', '/');
      const pkg = packages.find((p) => p.name === name);
      if (!pkg) throw new CliError(`no plugin package named ${name}`);
      if (pkg.runtime !== 'in-process') throw new CliError(`${name} runs as a sandboxed package; only an in-process plugin is approved to run in the server process`);
      if (pkg.actualHash || !pkg.contentHash) {
        throw new CliError(`${name} has content waiting for approval; review it and run octi plugin approve ${name} first`);
      }
      if (pkg.inProcess?.approved) {
        io.out(`${name} is already approved to run in the server process (${pkg.contentHash}).\n`);
        return 0;
      }
      io.out(`${line(pkg)}\n\n`);
      if (!io.interactive) {
        throw new CliError(`not at a terminal: review the files of ${name}, then run\n  octi plugin approve-in-process ${name} --hash ${pkg.contentHash}`, 2);
      }
      const answer = (await io.ask(`Run ${name} in the server process, with the server's full authority, for the content that hashes to ${pkg.contentHash}? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        io.out('Not approved.\n');
        return 1;
      }
      reviewed = pkg.contentHash;
    }
    const view = await request<PluginPackageView>(io, 'PATCH', `/${encodeURIComponent(name)}`, { approveInProcess: reviewed });
    io.out(`Approved ${name} to run in the server process, for ${view.inProcess?.approvedHash ?? reviewed}.${view.enabled ? '' : ` Enable it to load it.`}\n`);
    if (view.problem) io.out(`  still: ${view.problem}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin approve-in-process: ${err.message}\n`);
    return err.exitCode;
  }
}

/** Everything a package adds besides tools, in full, for review at a terminal. */
export function describeContributions(p: PluginPackageView): string {
  const c = p.contributions;
  const out: string[] = [];
  for (const x of c.commands) out.push(`  command  /${x.name} → ${x.tool} (${x.effect ?? '?'}), as the user who types it: ${x.description}`);
  for (const x of c.schedules) out.push(`  schedule ${x.id}: "${x.cron}" (UTC) → ${x.tool} (${x.effect ?? '?'}), as the installing admin, unattended`);
  for (const x of c.events) out.push(`  event    ${x.on} → ${x.tool} (${x.effect ?? '?'}), for every user's events, as that user`);
  if (c.context) out.push(`  context  ${c.context.tool} (${c.context.effect ?? '?'}) gets the message of every turn${c.context.roles ? ` of ${c.context.roles.join(', ')}` : ''} of EVERY user (root and workers)`);
  if (c.prompt) {
    out.push(`  prompt   ${c.prompt.file}, added to the system prompt of ${c.prompt.roles ? c.prompt.roles.join(', ') : 'every'} agent of EVERY user:`);
    out.push(...(c.prompt.text ?? '(cannot be read)').split('\n').map((l) => `    | ${l}`));
  }
  return out.join('\n');
}

/**
 * `octi plugin approve-contributions <name> [--hash sha256:…]`: approve what a
 * package adds besides tools, for the contributions hash reviewed. Without
 * --hash, everything it adds (the full prompt text included) is shown and must
 * be confirmed at a terminal (refused otherwise). The backend refuses (409) a
 * hash that is not what the package adds now.
 */
export async function approveContributionsCommand(io: PluginApiIo, name: string, hash: string | undefined): Promise<number> {
  try {
    checkName(name);
    if (hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new CliError('--hash takes sha256:<64 hex>, the contributions hash `octi plugin list` shows', 2);
    let reviewed = hash;
    if (reviewed === undefined) {
      const packages = await request<PluginPackageView[]>(io, 'GET', '/');
      const pkg = packages.find((p) => p.name === name);
      if (!pkg) throw new CliError(`no plugin package named ${name}`);
      const current = pkg.contributions?.hash;
      if (!current) throw new CliError(`${name} adds no commands, schedules, events, prompt or context; there is nothing to approve`);
      if (pkg.contributions.approved) {
        io.out(`${name}'s contributions are already approved (${current}).\n`);
        return 0;
      }
      io.out(`${name} ${pkg.version} adds:\n${describeContributions(pkg)}\n\ncontributions hash: ${current}\n\n`);
      if (!io.interactive) {
        throw new CliError(`not at a terminal: review what ${name} adds, then run\n  octi plugin approve-contributions ${name} --hash ${current}`, 2);
      }
      const answer = (await io.ask(`Approve all of this for every user of this install? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        io.out('Not approved.\n');
        return 1;
      }
      reviewed = current;
    }
    const view = await request<PluginPackageView>(io, 'PATCH', `/${encodeURIComponent(name)}`, { approveContributions: reviewed });
    io.out(`Approved what ${name} adds, for ${view.contributions.approvedHash ?? reviewed}.${view.enabled ? '' : ' Enable it to bind them.'}\n`);
    if (view.problem) io.out(`  still: ${view.problem}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin approve-contributions: ${err.message}\n`);
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

/**
 * `key=value` pairs as the settings a PATCH sends. Only exactly `key=` clears
 * a setting (null); a value of spaces alone is refused rather than read as a
 * clear.
 */
export function parseSettingPairs(pairs: readonly string[]): Record<string, string | null> {
  if (pairs.length === 0) throw new CliError('give at least one key=value', 2);
  const out: Record<string, string | null> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = at < 0 ? '' : pair.slice(0, at);
    if (!/^[a-z][a-z0-9_]{0,49}$/.test(key)) throw new CliError(`"${pair}": expected key=value with a setting key (lower-case letters, digits, _)`, 2);
    if (Object.hasOwn(out, key)) throw new CliError(`${key} is given twice`, 2);
    const value = pair.slice(at + 1);
    if (value !== '' && value.trim() === '') throw new CliError(`${key}: the value is only spaces; give a value, or \`${key}=\` to clear it`, 2);
    out[key] = value === '' ? null : value;
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
      if (value.length > MAX_PLUGIN_SECRET_LENGTH) {
        throw new CliError(`the value for ${key} is ${value.length} characters; a plugin secret holds at most ${MAX_PLUGIN_SECRET_LENGTH}`, 2);
      }
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

const SECRET_USAGE = 'expected <name> <KEY> [--clear]; the value is read from a prompt that does not echo, or from stdin, never from the command line';

/**
 * The arguments of `octi plugin secret`. A refusal never repeats what was
 * typed: a value given on the command line by mistake (`-s3cret`, a third
 * argument) would otherwise be echoed into the terminal and its logs.
 */
export function parseSecretArgs(argv: readonly string[]): { name: string; key: string; clear: boolean } {
  let parsed: { values: { clear?: boolean }; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { clear: { type: 'boolean' } } });
  } catch {
    throw new CliError(SECRET_USAGE, 2);
  }
  if (parsed.positionals.length !== 2) throw new CliError(SECRET_USAGE, 2);
  return { name: parsed.positionals[0], key: parsed.positionals[1], clear: parsed.values.clear === true };
}

/** `octi plugin secret` from its argv, refusing bad arguments without echoing them. */
export async function secretCommandFromArgs(io: PluginApiIo, argv: readonly string[]): Promise<number> {
  let args: ReturnType<typeof parseSecretArgs>;
  try {
    args = parseSecretArgs(argv);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(`octi plugin secret: ${err.message}\n`);
    return err.exitCode;
  }
  return secretCommand(io, args.name, args.key, args.clear);
}

/** What `readHiddenLine` needs of a terminal stream (process.stdin, or a fake in tests). */
export interface HiddenInput {
  setRawMode(raw: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
}

/**
 * One line typed at a terminal without echoing it, in raw mode, decoded as
 * UTF-8 by the stream (`setEncoding`, so a character split across chunks
 * stays whole). Enter or Ctrl-D ends it, Ctrl-C cancels, Backspace removes the
 * last character; every other control character and every escape sequence
 * (arrow keys, bracketed-paste markers) is dropped. At most `max` + 1
 * characters are kept, so the caller can refuse a longer value.
 */
export function readHiddenLine(input: HiddenInput, write: (text: string) => void, prompt: string, max = MAX_PLUGIN_SECRET_LENGTH): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    write(prompt);
    let value: string[] = [];
    /** Inside an escape sequence: `esc` after ESC, `csi` after ESC [ or ESC O, until its final byte. */
    let escape: 'none' | 'esc' | 'csi' = 'none';
    let finished = false;
    const done = (err?: Error) => {
      finished = true;
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      write('\n');
      const text = value.join('');
      value = [];
      if (err) reject(err);
      else resolvePromise(text);
    };
    const onData = (chunk: string | Buffer) => {
      if (finished) return;
      for (const ch of typeof chunk === 'string' ? chunk : chunk.toString('utf8')) {
        const code = ch.codePointAt(0) as number;
        // A control character (Enter after a lone Esc, say) ends a sequence and counts as itself.
        if (escape !== 'none' && code < 0x20) escape = 'none';
        if (escape === 'esc') {
          // ESC [ / ESC O start a sequence; ESC <key> (Alt+key) drops the key.
          escape = ch === '[' || ch === 'O' ? 'csi' : 'none';
          continue;
        }
        if (escape === 'csi') {
          if (code >= 0x40 && code <= 0x7e) escape = 'none';
          continue;
        }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u001b') escape = 'esc';
        else if (ch === '\u007f' || ch === '\b') value.pop();
        else if (code < 0x20 || (code >= 0x80 && code < 0xa0)) continue;
        else if (value.length <= max) value.push(ch);
      }
    };
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

/**
 * All of a stream (stdin from a pipe or a file) as UTF-8, refusing one longer
 * than a secret can be (`max` characters, at most 4 bytes each).
 */
export async function readAllText(input: AsyncIterable<string | Buffer>, max = MAX_PLUGIN_SECRET_LENGTH): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += bytes.length;
    // Room for the trailing newline that is dropped.
    if (total > max * 4 + 2) throw new Error(`the value on stdin is longer than ${max} characters, the most a plugin secret holds`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
