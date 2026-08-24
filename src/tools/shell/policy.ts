/**
 * What a command is allowed to be, independent of who is running it.
 *
 * Extracted from `ShellTool` so there is ONE denylist rather than one per
 * caller. It was private to the tool, which was fine while the tool was the
 * only way a command reached a process; the `command_exit_zero` scorer is a
 * second way in, and a second copy of these rules is a copy that goes stale
 * exactly when it matters.
 *
 * This is the *content* policy — is this string a dangerous command. It is not
 * the permission layer (who may run commands at all) and not the execution
 * sandbox; those stay with their own owners, and a caller outside `ShellTool`
 * has to satisfy them separately.
 *
 * The rules are evaluated against the argv a command TOKENIZES to as well as
 * the text as written, because the two differ in exactly the cases an attacker
 * cares about: `rm -rf '/'` and `'sudo' npm test` match nothing written against
 * the raw string and reach `spawn` as `rm -rf /` and `sudo npm test`.
 */

/**
 * Conservative POSIX-ish tokenizer. Splits a command string into argv,
 * stripping single/double quotes. Returns `null` if the command contains
 * any shell metacharacter that would enable command injection or
 * unsupported expansion (`;` `&` `|` `<` `>` `` ` `` `$(` `${` `{,}` newline).
 *
 * The intent is to bypass `sh -c` for well-formed simple commands so a
 * compromised LLM cannot inject extra commands via input. Callers that
 * genuinely need shell features must pass `unsafe: true`.
 */
export function tokenizeSafe(cmd: string): string[] | null {
  const META = /[;&|<>`\n]/;
  const tokens: string[] = [];
  let buf = '';
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) return null;
      buf += cmd.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = cmd.indexOf('"', i + 1);
      if (end === -1) return null;
      const inside = cmd.slice(i + 1, end);
      if (/\$\(|\$\{|`/.test(inside)) return null;
      buf += inside;
      i = end + 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (buf) { tokens.push(buf); buf = ''; }
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      buf += cmd[i + 1];
      i += 2;
      continue;
    }
    // brace expansion: {a,b}
    if (c === '{' && cmd.slice(i).match(/^\{[^{}]*,[^{}]*\}/)) return null;
    if (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) return null;
    if (META.test(c)) return null;
    buf += c;
    i++;
  }
  if (buf) tokens.push(buf);
  return tokens.length > 0 ? tokens : null;
}

/** Commands refused outright, whoever asks. */
export const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs',
  ':(){:|:&};:',
  'dd if=/dev/random',
  'chmod -R 777 /',
  'chmod 777 /',
  // Data exfiltration / reverse shell tools
  'nc ',
  'nc -',
  'ncat ',
  'ncat -',
  'netcat ',
  'netcat -',
  // Process management — prevent agents from killing Octipus or other processes
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
];

/** Commands that require the DENY-by-default `execute_elevated` permission. */
export const ELEVATED_COMMANDS = [
  'sudo',
  'su',
  'chown',
  'chmod',
  'systemctl',
  'service',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'docker',
  'podman',
  'mount',
  'umount',
  'iptables',
  'ip6tables',
  'nft',
  // Process management — prevent accidental self-kill
  'kill',
  'pkill',
  'killall',
  'xkill',
];

const INJECTION_PATTERNS = [
  /;\s*rm\s+/i,
  /\|\s*rm\s+/i,
  /`.*rm.*`/i,
  /\$\(.*rm.*\)/i,
  />\s*\/dev\/sd/i,
  />\s*\/dev\/hd/i,
  // Data exfiltration: piping output to network tools
  /\|\s*curl\s+/i,
  /\|\s*wget\s+/i,
  /\|\s*nc\s+/i,
  /\|\s*ncat\s+/i,
  /\|\s*netcat\s+/i,
  // Suspicious backtick command substitution (nested command execution)
  /`[^`]*`.*`[^`]*`/i,
  // Suspicious $(...) expansion piping to network tools
  /\$\(.*\).*\|\s*(curl|wget|nc|ncat|netcat)\s/i,
];

/**
 * The elevated keyword a command invokes at the start of the line or after a
 * pipe / `;` / `&&` separator, else null.
 */
export function matchElevatedCommand(command: string): string | null {
  // Judge the form that will actually be SPAWNED, not the string as typed.
  // `tokenizeSafe` strips quotes and backslashes, so `'sudo' npm test` and
  // `\\sudo npm test` reach `spawn` as argv `['sudo','npm','test']` while
  // matching no pattern written against the raw text. Checking both forms
  // keeps the raw match for `unsafe: true` callers, whose string really is
  // handed to `sh -c` intact.
  for (const candidate of [command.trim().toLowerCase(), ...dequotedForms(command)]) {
    for (const elevated of ELEVATED_COMMANDS) {
      const patterns = [
        new RegExp(`^${elevated}\\b`, 'i'),
        new RegExp(`\\|\\s*${elevated}\\b`, 'i'),
        new RegExp(`;\\s*${elevated}\\b`, 'i'),
        new RegExp(`&&\\s*${elevated}\\b`, 'i'),
      ];
      if (patterns.some((p) => p.test(candidate))) return elevated;
      // And through a wrapper: `sh -c "sudo x"` is still sudo.
      if (startsWithCommand(candidate, elevated)) return elevated;
    }
  }
  return null;
}

/**
 * The command forms a process could actually see, lowercased and
 * whitespace-normalized: the argv when the string tokenizes, and the text with
 * quoting removed.
 *
 * Both, because the two execution paths differ and each is evadable from the
 * other's blind spot. `tokenizeSafe` returns null the moment a metacharacter
 * appears — which is precisely when `sh -c` takes over and does its own
 * dequoting, so `true && rm -rf '/'` reaches a shell that runs `rm -rf /` while
 * matching nothing written against the text as typed.
 */
function dequotedForms(command: string): string[] {
  const forms: string[] = [];
  const argv = tokenizeSafe(command);
  if (argv) forms.push(argv.join(' '));
  const stripped = command.replace(/["'\\]/g, '').trim();
  if (stripped) forms.push(stripped);
  return forms.map((f) => f.toLowerCase().replace(/[^\S\n]+/g, ' '));
}

/**
 * Commands whose own arguments are another command. They have to be
 * transparent to the denylist: `sh -c "rm -rf /"` and `timeout 5 rm -rf /` run
 * exactly what they wrap, so a matcher that only looks at the head of a segment
 * sees `sh` and `timeout` and waves them through.
 */
const COMMAND_WRAPPERS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'ash', 'fish',
  'env', 'timeout', 'nohup', 'nice', 'ionice', 'setsid', 'stdbuf', 'script',
  'xargs', 'time', 'watch', 'sudo', 'su', 'doas', 'chroot', 'unshare', 'eval', 'exec',
]);

/** A token that is a flag (`-c`, `--quiet`) rather than the command. */
const FLAG = /^-{1,2}[a-z][a-z0-9-]*$/i;

/** A duration or count a wrapper takes positionally (`timeout 5`, `1.5s`). */
const WRAPPER_ARG = /^\d+(?:\.\d+)?[smhd]?$/i;

/**
 * Tokens after which the REST is another command: `sh -c …`, `find … -exec …`.
 * Without these, `find . -exec rm -rf / ;` reads as an invocation of `find`.
 */
const INTRODUCES_COMMAND = new Set(['-c', '-exec', '-execdir', '-ok', '-okdir']);

/**
 * A command's own name, without the path it was reached by. `/bin/rm` and
 * `rm` run the same program, so the denylist has to compare the same thing —
 * matching only the bare form let `/bin/rm -rf /`, `/usr/sbin/shutdown` and
 * `/usr/bin/sudo` straight through.
 */
const basename = (token: string): string => token.slice(token.lastIndexOf('/') + 1);

/**
 * The command strings a segment could actually run.
 *
 * Normally one: the segment with its leading `NAME=value` assignments removed
 * and its head reduced to a basename. Two more sources add candidates:
 *
 * - **A wrapper** hides what it runs behind its own arguments, so those are
 *   stepped over — flags, and the positional counts `timeout 5` / `nice 10`
 *   take. Exactly one candidate comes out, not every suffix: enumerating
 *   suffixes refused `timeout 60 npm run halt` and `xargs -n1 npm run reboot`,
 *   which are ordinary commands, and a scorer marks such a refusal unfixable.
 * - **A command-introducing token** (`-c`, `-exec`) means the rest is a command
 *   in its own right, wherever it appears.
 */
function commandCandidates(segment: string): string[] {
  const stripped = segment.trim().replace(/^(?:[a-z_][a-z0-9_]*=\S*\s+)+/i, '');
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const normalize = (list: string[]): string =>
    list.length === 0 ? '' : [basename(list[0]), ...list.slice(1)].join(' ');

  const candidates = [normalize(tokens)];

  // Anything after `-exec` / `-c` is a command, at whatever depth it appears.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (INTRODUCES_COMMAND.has(tokens[i])) candidates.push(normalize(tokens.slice(i + 1)));
  }

  if (COMMAND_WRAPPERS.has(basename(tokens[0]))) {
    let i = 1;
    while (i < tokens.length && (FLAG.test(tokens[i]) || WRAPPER_ARG.test(tokens[i]))) i++;
    if (i < tokens.length) candidates.push(normalize(tokens.slice(i)));
  }

  return candidates.filter(Boolean);
}

/**
 * Does `text` invoke `blocked` as a command — as opposed to merely containing
 * its letters?
 *
 * A plain substring test refuses ordinary work: `nc ` is an entry, so
 * `npm run sync tests` and `go test ./internal/sync` were both blocked. Pure
 * head-anchoring is the opposite mistake: it waves through every wrapper.
 * So each separator-delimited segment is unwrapped down to the command that
 * will actually run, and the entry is matched there on a token boundary.
 *
 * Entries that themselves contain a separator (`:(){:|:&};:`) cannot survive
 * the split, so they are matched against the whole string instead.
 */
function startsWithCommand(text: string, blocked: string): boolean {
  const b = blocked.toLowerCase().trim();
  if (!b) return false;

  // A separator-bearing entry is a shape, not a command name — the split would
  // shatter it, so it is matched against the whole string instead.
  if (/[;&|]/.test(b)) return text.replace(/\s+/g, '').includes(b.replace(/\s+/g, ''));

  for (const segment of text.split(/&&|\|\||[;&|\n()]/)) {
    for (const candidate of commandCandidates(segment)) {
      if (!candidate.startsWith(b)) continue;
      const next = candidate[b.length];
      if (next === undefined || /[\s;&|]/.test(next)) return true;
    }
  }
  return false;
}

/**
 * Why this command may not run, or null when the content policy permits it.
 *
 * Returns a reason rather than throwing, because one caller wants an exception
 * and the other wants a failed gate. Whitespace runs are normalized first so
 * trivial evasions (`rm -rf  /`, tabs, a newline between tokens) still match.
 */
export function commandPolicyViolation(command: string): string | null {
  const raw = command.trim();
  // `[^\S\n]` and not `\s`: collapsing newlines would erase the separator the
  // segment split depends on, so `echo hi\nshutdown` would read as one command
  // called `echo`.
  const normalized = raw.toLowerCase().replace(/[^\S\n]+/g, ' ');

  // Every form a process could see, each judged as a COMMAND. The forms cover
  // the two execution paths (argv for safe mode, the shell's own dequoting for
  // `sh -c`); the matcher is what makes it a command rather than a substring.
  //
  // A substring test here was the original rule and it is untenable: `nc ` is a
  // denylist entry, so `npm run sync tests`, `go test ./internal/sync` and
  // `cargo test --features async ui` were all refused — measured, on the
  // shipped list. That is ordinary verification work, and since a scorer treats
  // this refusal as unfixable it would fail correct children for a command
  // that never ran.
  for (const form of [normalized, ...dequotedForms(command)]) {
    for (const blocked of BLOCKED_COMMANDS) {
      if (startsWithCommand(form, blocked)) return `Blocked command detected: ${blocked}`;
    }
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(raw)) return 'Potential command injection detected';
  }

  return null;
}
