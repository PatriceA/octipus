/**
 * What a repository's own git configuration may do when the git tool runs
 * in it (docs/EGRESS-POLICY.md#git).
 *
 * The git tool runs git on the host, outside the shell sandbox, and the
 * model or a sandboxed command can write `.git/config`. Every repository-
 * scope (local, worktree) setting that names a program is handled one of two
 * ways:
 *
 * - **Neutralised** with a command-line `-c`, which outranks every config
 *   file and is passed on to the git processes git starts. Where the operator
 *   configured the same key globally (or in system config), the operator's
 *   value is put back after the reset, so their credential helpers, LFS and
 *   signing keep working; the repository's own value never runs.
 * - **Refused** — the action does not run — where no `-c` reliably switches
 *   the program off (`refusedKeys`).
 *
 * Settings switched off for every run regardless (hooks, fsmonitor, pager,
 * editors, `ext::`, external diff and textconv on diff) are in
 * src/security/git-hardening.ts and the diff action's flags.
 */

export interface ConfigEntry {
  scope: string;
  key: string;
  value: string;
}

/** `git config --list --show-scope` output as entries; keys lower-cased (git's own normalisation of section and variable). */
export function parseConfigListing(listing: string): ConfigEntry[] {
  return listing.split('\n').map((line) => /^(\w+)\t([^=]+)=(.*)$/.exec(line)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ scope: m[1], key: lowerKey(m[2]), value: m[3] }));
}

/** Section and variable lower-cased, a subsection (between them) kept as written. */
function lowerKey(key: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first < 0) return key.toLowerCase();
  if (first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

const REPO_SCOPES = new Set(['local', 'worktree']);
const OPERATOR_SCOPES = new Set(['system', 'global']);

/**
 * Repository-scope keys that run a program and that no `-c` switches off
 * reliably: `remote.<name>.uploadpack`/`receivepack` take the FIRST value
 * (a `-c` comes last), the rest have no off value.
 */
const REFUSED_KEY = /^(?:core\.(?:gitproxy|alternaterefscommand)|remote\..+\.(?:vcs|uploadpack|receivepack)|gpg\.ssh\.defaultkeycommand|hook\..+\.(?:command|event))$/;

/** Single-valued keys reset to the operator's value, else to this safe default. */
const SINGLE_DEFAULTS: Array<[RegExp, (key: string) => string]> = [
  [/^core\.sshcommand$/, () => 'ssh'],
  [/^core\.askpass$/, () => ''],
  [/^gpg\.program$/, () => 'gpg'],
  [/^gpg\.openpgp\.program$/, () => 'gpg'],
  [/^gpg\.x509\.program$/, () => 'gpgsm'],
  [/^gpg\.ssh\.program$/, () => 'ssh-keygen'],
  [/^submodule\..+\.update$/, () => 'checkout'],
  [/^submodule\.recurse$/, () => 'false'],
  [/^merge\..+\.driver$/, () => ''],
  [/^interactive\.difffilter$/, () => ''],
];

/** The repository-scope keys the git tool refuses to run under. */
export function refusedKeys(entries: ConfigEntry[]): string[] {
  return [...new Set(entries.filter((e) => REPO_SCOPES.has(e.scope) && REFUSED_KEY.test(e.key)).map((e) => e.key))];
}

/**
 * The `-c` options that neutralise the repository's program-running settings,
 * with the operator's own values put back. Empty when the repository sets
 * none of them.
 */
export function neutralizingArgs(entries: ConfigEntry[]): string[] {
  const repo = entries.filter((e) => REPO_SCOPES.has(e.scope));
  const operator = (key: string) => entries.filter((e) => OPERATOR_SCOPES.has(e.scope) && e.key === key).map((e) => e.value);
  const args: string[] = [];
  const c = (key: string, value: string) => args.push('-c', `${key}=${value}`);
  const done = new Set<string>();
  for (const { key } of repo) {
    if (done.has(key)) continue;
    // Credential helpers are a list: an empty value resets it, then the
    // operator's helpers (in their order) are added back.
    if (/^credential(?:\..+)?\.helper$/.test(key)) {
      done.add(key);
      c(key, '');
      for (const value of operator(key)) c(key, value);
      continue;
    }
    // A filter driver part the repository sets: emptied (a `required` one
    // made not required), so git treats the repository's filter as absent —
    // an LFS file stays its pointer. The operator's value for the same part,
    // if any, is put back instead; parts the repository does not set are left
    // as they are (an empty `process` would also switch off an operator's
    // `clean`).
    const filter = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(key);
    if (filter) {
      done.add(key);
      const own = operator(key);
      c(key, own.length ? own.at(-1) as string : filter[2] === 'required' ? 'false' : '');
      continue;
    }
    // An interactive rebase on pull would open the (switched-off) sequence
    // editor; the repository may keep any other pull.rebase it likes.
    if (key === 'pull.rebase') {
      done.add(key);
      if (repo.some((e) => e.key === key && /^i(?:nteractive)?$/i.test(e.value.trim()))) c(key, operator(key).at(-1) ?? 'false');
      continue;
    }
    const single = SINGLE_DEFAULTS.find(([pattern]) => pattern.test(key));
    if (single) {
      done.add(key);
      const own = operator(key);
      c(key, own.length ? own.at(-1) as string : single[1](key));
    }
  }
  return args;
}

/** One argument quoted for `sh -c` (git runs `--receive-pack` through the shell). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
