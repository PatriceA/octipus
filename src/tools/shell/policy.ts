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
  return forms.map((f) => f.toLowerCase().replace(/\s+/g, ' '));
}

/**
 * Does `text` invoke `blocked` as a command — at the start, or after a shell
 * separator — as opposed to merely containing its letters?
 *
 * Token-aware because the denylist mixes bare names (`mkfs`, `halt`) with
 * argument-bearing phrases (`rm -rf /`, `nc -`), so the boundary has to be
 * judged on the character AFTER the match. A plain `startsWith` blocks `ncdu`
 * as `nc ` and `haltcheck` as `halt`; a plain `includes` blocks
 * `grep -rn "chmod 777" /etc`. Both are ordinary commands.
 */
function startsWithCommand(text: string, blocked: string): boolean {
  const b = blocked.toLowerCase().trim();
  if (!b) return false;
  for (const segment of text.split(/&&|\|\||[;&|]/)) {
    const seg = segment.trim();
    if (!seg.startsWith(b)) continue;
    const next = seg[b.length];
    if (next === undefined || /[\s;&|]/.test(next)) return true;
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
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');

  for (const blocked of BLOCKED_COMMANDS) {
    if (normalized.includes(blocked.toLowerCase())) {
      return `Blocked command detected: ${blocked}`;
    }
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(raw)) return 'Potential command injection detected';
  }

  // Then the dequoted forms, judged as COMMANDS rather than as text — this is
  // what catches `rm -rf '/'` and `true && rm -rf '/'`, neither of which the
  // raw scan above can see.
  for (const dequoted of dequotedForms(command)) {
    if (dequoted === normalized) continue;
    for (const blocked of BLOCKED_COMMANDS) {
      if (startsWithCommand(dequoted, blocked)) return `Blocked command detected: ${blocked}`;
    }
  }

  return null;
}
