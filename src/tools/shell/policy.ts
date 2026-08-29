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
  // Data exfiltration / reverse shell tools.
  //
  // The `nc -` / `ncat -` / `netcat -` forms the substring matcher needed are
  // gone: matching is per token now, and a name containing a space can never
  // equal one, so they read as live rules while being unreachable. The
  // space-suffixed entries subsume them — `nc -e /bin/sh` is `nc` followed by
  // an argument, which is exactly what a trailing space means here.
  'nc ',
  'ncat ',
  'netcat ',
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
  for (const candidate of [command.trim().toLowerCase(), ...dequotedForms(command)]) {
    for (const elevated of ELEVATED_COMMANDS) {
      if (headOfSegmentIs(candidate, elevated)) return elevated;
    }
  }
  return null;
}

/**
 * The way a command destroys work irreversibly, else null.
 *
 * A separate class from elevation because the question is different. Elevation
 * asks *may this caller touch the system at all*; destruction asks *can this be
 * taken back*. `rm -rf build` needs no privilege whatsoever and cannot be
 * undone, so it passes the elevated check untouched — which is how a spawned
 * agent emptied a project directory with nobody asked.
 *
 * Matched on the argv a segment tokenizes to rather than its head alone,
 * because here the flags ARE the event: `rm notes.txt` and `rm -rf .` share a
 * head and share nothing else.
 *
 * Deliberately narrow. The bar is "takes out more than it names, and no copy
 * survives" — a single named file is not on this list, because it is the most
 * common edit an agent makes and git already holds the copy. The mistake this
 * guards against is the unbounded one.
 */
export function matchDestructiveCommand(command: string): string | null {
  const forms = [command.trim().toLowerCase(), ...dequotedForms(command)];

  // Inline interpreter source is matched against the WHOLE command, before any
  // segmenting. The segment splitter cuts on `;` `(` `)` — which are precisely
  // the characters the source is made of, so
  // `python3 -c "import shutil; shutil.rmtree('.')"` arrives at the per-segment
  // matcher already in pieces, with the destruction in a different piece from
  // the interpreter.
  for (const form of forms) {
    const hit = inlineInterpreterDestruction(form);
    if (hit) return hit;
  }

  for (const form of forms) {
    for (const segment of form.split(/&&|\|\||[;&|\n()`]/)) {
      for (const candidate of commandCandidates(segment)) {
        const hit = destructiveForm(candidate);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** What makes one already-peeled candidate destructive, else null. */
function destructiveForm(candidate: string): string | null {
  const argv = candidate.split(/\s+/).filter(Boolean);
  const head = argv[0];
  if (!head) return null;
  const args = argv.slice(1);

  /** Is `ch` set in any bundled short flag (`-rf` carries both r and f)? */
  const shortFlag = (ch: string) =>
    args.some((a) => /^-[^-]/.test(a) && a.slice(1).includes(ch));
  const has = (...names: string[]) => names.some((n) => args.includes(n));

  switch (head) {
    case 'rm':
      if (shortFlag('r') || has('--recursive')) return 'rm -r';
      // An UNBOUNDED glob — `rm *`, `rm ./*`, `rm .*` — deletes whatever
      // happens to be there. A bounded one (`rm dist/*.js`) names an extension
      // inside a directory and is routine build hygiene; gating it would deny
      // ordinary autonomous cleanup for no safety gain, and a guard that fires
      // on routine work is a guard people learn to wave through.
      if (args.some((a) => !a.startsWith('-') && UNBOUNDED_GLOB.test(a))) return 'rm <glob>';
      return null;
    case 'shred':
      return 'shred';
    case 'truncate':
      return 'truncate';
    case 'dd':
      return args.some((a) => a.startsWith('of=')) ? 'dd of=' : null;
    case 'rsync':
      // `--delete` makes the destination match the source by removing whatever
      // is not in it — the standard "empty this directory" idiom in build
      // scripts, and unbounded by construction.
      return has('--delete', '--delete-after', '--delete-before', '--delete-during', '--delete-excluded')
        ? 'rsync --delete'
        : null;
    case 'find': {
      if (has('-delete')) return 'find -delete';
      // The binary `-exec` runs is the token that FOLLOWS it, not any token in
      // the line. Scanning the whole argv both missed
      // `find . -exec shred {} \;` and false-positived on
      // `find . -exec grep -rn 'rm ' {} \;`, where quote stripping leaves a
      // bare `rm` that was only ever a search pattern.
      const execAt = args.findIndex((a) => a === '-exec' || a === '-execdir');
      if (execAt >= 0) {
        const run = args[execAt + 1];
        if (run && DESTRUCTIVE_EXEC_BINARIES.has(basename(run))) return `find -exec ${basename(run)}`;
      }
      return null;
    }
    case 'git':
      // Each of these throws away work that exists nowhere else: uncommitted
      // changes, untracked files, or somebody else's history on the remote.
      if (has('reset') && has('--hard')) return 'git reset --hard';
      if (has('clean') && (shortFlag('f') || has('--force'))) return 'git clean -f';
      if (has('push') && (has('--force', '--force-with-lease') || shortFlag('f'))) {
        return 'git push --force';
      }
      if (has('checkout') && has('.')) return 'git checkout .';
      if (has('worktree') && has('remove') && (has('--force') || shortFlag('f'))) {
        return 'git worktree remove --force';
      }
      return null;
    default:
      return null;
  }
}

/**
 * An interpreter handed inline source runs whatever that source says, and the
 * head of the command is `python3`. Closing the `rm` route without this one
 * only moves the problem: an agent refused a recursive delete reaches for
 * `python3 -c "shutil.rmtree('.')"` next — the same escape-hatch step the
 * original incident took when its first attempt was rejected.
 */
function inlineInterpreterDestruction(form: string): string | null {
  const tokens = form.split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t) => INTERPRETERS.has(basename(t)));
  if (at < 0) return null;
  if (!tokens.slice(at + 1).some((t) => INLINE_CODE_FLAGS.has(t))) return null;
  return DESTRUCTIVE_IN_CODE.test(form) ? `${basename(tokens[at] as string)} inline code` : null;
}

/** Interpreters that will run source handed to them on the command line. */
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'perl', 'ruby', 'php', 'deno', 'bun']);

/** The flags that mean "the next argument is source, not a filename". */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '--eval', '-E', '--exec']);

/**
 * Destruction expressed in inline source. Deliberately a keyword scan rather
 * than an attempt to parse: the point is to route the call to a human, not to
 * decide what the program does. Anything this misses is a known ceiling —
 * inline code is not analysable from a denylist, so a workspace that runs
 * untrusted inline interpreters wants the sandbox, not this.
 */
const DESTRUCTIVE_IN_CODE =
  /\b(rmtree|removedirs|\bunlink\b|shutil\.rm|os\.remove|fs\.rm|rmSync|rmdirSync|unlinkSync|remove_entry|FileUtils\.rm|File\.delete)\b/i;

/** Binaries whose whole job, when `find -exec`s them, is to destroy the match. */
const DESTRUCTIVE_EXEC_BINARIES = new Set(['rm', 'unlink', 'shred', 'truncate', 'rmdir']);

/** `*`, `./*`, `.*`, `dir/*` — a glob that names no extension or stem. */
const UNBOUNDED_GLOB = /(^|\/)\.?\*$/;

/**
 * Does `text` START a segment with `name`, after any wrappers and assignments?
 *
 * Narrower than the denylist's token test, deliberately. Elevation does not
 * block a command; it routes one to the DENY-by-default `execute_elevated`
 * permission, so a false positive refuses ordinary work — an npm script called
 * `kill` or `service` is not the binary, and `timeout 5 npm run kill` was not
 * elevated before this branch either. The denylist takes the opposite bias
 * because the mistake it guards against is worse.
 */
function headOfSegmentIs(text: string, name: string): boolean {
  const b = name.toLowerCase().trim();
  if (!b) return false;
  for (const segment of text.split(/&&|\|\||[;&|\n()`]/)) {
    for (const candidate of commandCandidates(segment)) {
      if (!candidate.startsWith(b)) continue;
      const next = candidate[b.length];
      // A dot continues the name — `kill.sh` and `service.sh` are project
      // scripts, not the binaries they are named after.
      if (next === undefined || /[\s/~]/.test(next)) return true;
      // A dash continues a TOOL's name (`docker-compose`, `iptables-restore`,
      // which the old `\b` matcher caught) but also a SCRIPT's
      // (`kill-stale.sh`, `service-check.sh`). The file extension is what tells
      // them apart: a dashed name ending in one is a script in the repo, not a
      // privileged binary, and refusing it would deny ordinary work.
      if (next === '-') {
        const remainder = candidate.slice(b.length).split(/\s/)[0];
        if (!looksLikeFilename(remainder.slice(remainder.lastIndexOf('.') + 1))) return true;
      }
    }
  }
  return false;
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
  // Debuggers, lockers and launchers that take a command as their tail. The
  // list cannot be complete — which is why the DENYLIST does not depend on it —
  // but each name here is one the elevation check would otherwise miss.
  'flock', 'strace', 'ltrace', 'proxychains', 'proxychains4', 'runuser', 'command', 'busybox',
]);

/** A token that is a flag (`-c`, `--signal=KILL`), not the command. */
const FLAG = /^-{1,2}[a-z][a-z0-9-]*(?:=.*)?$/i;

/**
 * A count or duration a wrapper takes positionally (`timeout 5`, `1.5s`) — or
 * an option's separate value, including a negative one: `nice -n -5 sudo id`
 * and `nice -5 sudo id` both stopped the peel dead at `-5`, so the `sudo`
 * behind them was never seen. `--` likewise ends a wrapper's options rather
 * than naming a command.
 */
const WRAPPER_ARG = /^(?:--|-?\d+(?:\.\d+)?[smhd]?)$/i;

/**
 * A path a wrapper takes positionally before the command it runs — `flock
 * /tmp/lock cmd`, `chroot /newroot cmd`.
 *
 * Skipped only for the wrappers that actually take one. Applied to every
 * wrapper it consumed the SCRIPT being run and promoted its first argument to
 * the head: `bash scripts/build.sh docker` read as `docker`,
 * `timeout 120 ./gradlew kill` as `kill` — both routed to the DENY-by-default
 * `execute_elevated` permission, refusing ordinary work.
 */
const WRAPPER_PATH_ARG = /^[./~]|\//;

/** The wrappers whose first positional is a path, not the command. */
const TAKES_PATH_ARG = new Set(['flock', 'chroot', 'unshare', 'runuser', 'script']);

/**
 * Wrapper options that take a SEPARATE value, PER WRAPPER.
 *
 * One shared list does not work: `-f` takes a value for `proxychains` and none
 * for `strace`, `-t` none for `xargs`, `-p` none for `time`. Applied globally
 * it ate the payload of `strace -f sudo id`, `xargs -t sudo id` and
 * `time -p sudo id`. And guessing from "the previous token looked like a flag"
 * ate `env -i sudo id`, since `-i` takes nothing either.
 */
const VALUE_TAKING_FLAGS: Record<string, ReadonlySet<string>> = {
  // Keys are LOWERCASE: `matchElevatedCommand` lowercases the command before
  // matching, so an upper-case entry can never be looked up. `env -C /tmp sudo
  // …` and `xargs -E EOF sudo …` were dropping the elevated command behind an
  // entry that was dead on arrival.
  //
  // Where lowering would collide with a valueless flag of the same wrapper the
  // entry is omitted rather than guessed: `xargs -P` (max-procs, takes a value)
  // lowers onto `xargs -p` (interactive, takes none), and consuming the token
  // after `-p` would hide a command instead of revealing one.
  // `-S`/`--split-string` is deliberately ABSENT: its value is a command line,
  // so skipping it hid the `sudo` in `env -S "sudo id"`. The same reasoning
  // keeps `-c` off `script` below. A flag whose value is a command must have
  // that value examined, not stepped over.
  env: new Set(['-u', '--unset', '-c', '--chdir']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata']),
  strace: new Set(['-o', '--output', '-p', '--attach', '-e', '-s']),
  ltrace: new Set(['-o', '-p', '-e', '-s']),
  xargs: new Set([
    '-i', '--replace', '-a', '--arg-file', '-n', '--max-args',
    '--max-procs', '-s', '-d', '--delimiter', '-e', '-l',
  ]),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  watch: new Set(['-n', '--interval']),
  time: new Set(['-o', '--output', '-f', '--format']),
  proxychains: new Set(['-f']),
  proxychains4: new Set(['-f']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt']),
  // `su -c` likewise runs its value.
  su: new Set(['-s', '--shell']),
  doas: new Set(['-u', '-C']),
  runuser: new Set(['-u', '--user', '-g', '--group', '-s', '--shell']),
  unshare: new Set(['--map-user', '--map-group', '--setgroups']),
  script: new Set(['-l', '--log-out']),
};

/**
 * Flags whose value IS a command line, in the joined `--flag=value` form.
 *
 * The separate form (`env -S "sudo id"`) is already handled by keeping these
 * flags out of `VALUE_TAKING_FLAGS`, so the peel stops on the `sudo` token.
 * The joined form has no such token: whitespace-splitting
 * `env --split-string="sudo id"` yields `--split-string=sudo`, which matches
 * `FLAG` and is stepped over as an option — so the elevated command inside it
 * was never examined and the invocation routed to the ASK-level `execute`
 * permission instead of DENY-by-default `execute_elevated`.
 */
const COMMAND_STRING_FLAGS: Record<string, ReadonlySet<string>> = {
  // PER WRAPPER, and for the same reason `VALUE_TAKING_FLAGS` is: the command
  // is lowercased before matching, so `env -S` lowers onto `-s` — which for
  // `strace` and `timeout` is an ordinary value-taking flag. A shared list
  // would read `strace -s=1024 sudo id` as running the command `1024` and lose
  // the `sudo` behind it.
  env: new Set(['-s', '--split-string']),
  sh: new Set(['-c', '--command']),
  bash: new Set(['-c', '--command']),
  zsh: new Set(['-c', '--command']),
  ksh: new Set(['-c']),
  dash: new Set(['-c']),
  ash: new Set(['-c']),
  fish: new Set(['-c', '--command']),
  busybox: new Set(['-c']),
  script: new Set(['-c', '--command']),
  su: new Set(['-c', '--command']),
  runuser: new Set(['-c', '--command']),
  doas: new Set(['-c']),
  sudo: new Set(['-c']),
};

/** `xargs -I {}` and friends: a substitution token, not the command. */
const PLACEHOLDER = /^\{\}$|^%$/;

/** Bound on wrapper/assignment peeling. */
const MAX_PEEL_DEPTH = 12;

/**
 * Entries distinctive enough to refuse WHEREVER they appear.
 *
 * The denylist holds two kinds of string and they need different rules.
 *
 * These are multi-token or otherwise unmistakable: a command line containing
 * `rm -rf /` or `mkfs` is essentially never innocent. Matching them as plain
 * substrings catches every wrapper, flag form and quoting trick without
 * modelling the shell — `env -u FOO rm -rf /`,
 * `timeout --signal=KILL 5 rm -rf /`, `find . -exec rm -rf / ;` and
 * `sh -c "rm -rf /"` all fall out of the one check. Trying to reach them by
 * parsing instead is what this file kept getting wrong.
 *
 * The rest — `nc `, `halt`, `shutdown`, `reboot`, `poweroff` — are short words
 * that occur inside ordinary text. As substrings they refused
 * `npm run sync tests`, `go test ./internal/sync` and
 * `cargo test --features async ui` (all measured), so they are matched only in
 * command position.
 *
 * The split is this repo's own "a guard sits on the risk-weighted side" rule:
 * for the destructive entries the expensive mistake is letting one run, so they
 * stay broad; for the short words the expensive mistake is refusing real work —
 * and through a scorer that refusal is non-retryable — so they stay narrow.
 */
const MATCH_ANYWHERE = new Set([
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'mkfs',
  ':(){:|:&};:',
  'dd if=/dev/random',
  'chmod -R 777 /',
  'chmod 777 /',
]);

/**
 * A command's own name, without the path it was reached by. `/bin/rm` and `rm`
 * run the same program, so the check has to compare the same thing.
 */
const basename = (token: string): string => token.slice(token.lastIndexOf('/') + 1);

/**
 * A segment peeled down to what actually runs: leading `NAME=value`
 * assignments and any chain of wrappers with their own arguments.
 *
 * Iterative — `nohup timeout 5 halt` stacks wrappers, and an assignment can sit
 * after a wrapper as easily as before one. Every step contributes its own
 * candidate, because peeling an assignment and a wrapper together skips the
 * command in between: `env A=1 sudo npm i` would go straight to `npm i`.
 */
function commandCandidates(segment: string): string[] {
  let rest = segment.trim().split(/\s+/).filter(Boolean);
  if (rest.length === 0) return [];

  const normalize = (list: string[]): string =>
    list.length === 0 ? '' : [basename(list[0]), ...list.slice(1)].join(' ');

  const candidates = [normalize(rest)];
  for (let depth = 0; depth < MAX_PEEL_DEPTH; depth++) {
    const before = rest;

    let i = 0;
    while (i < rest.length && /^[a-z_][a-z0-9_]*=/i.test(rest[i])) i++;
    if (i > 0) {
      rest = rest.slice(i);
      if (rest.length > 0) candidates.push(normalize(rest));
    }

    if (rest.length > 0 && COMMAND_WRAPPERS.has(basename(rest[0]))) {
      let j = 1;
      const takesPath = TAKES_PATH_ARG.has(basename(rest[0]));
      // What a joined `--flag=<command line>` token turns out to hold, once
      // the flag part is stripped off it.
      let inlineCommand: string[] | null = null;
      while (j < rest.length) {
        const t = rest[j];
        const joined = /^(--?[a-z][a-z0-9-]*)=([\s\S]+)$/i.exec(t);
        if (joined && (COMMAND_STRING_FLAGS[basename(rest[0])]?.has(joined[1].toLowerCase()) ?? false)) {
          inlineCommand = [joined[2], ...rest.slice(j + 1)];
          break;
        }
        // Stop the moment a token names a command: `timeout 5 /usr/bin/sudo x`
        // has a path-shaped argument that IS the payload, and consuming it
        // dropped the whole invocation to the ASK-level permission.
        // An option's separate VALUE, recognised from a NAMED list rather than
        // "the previous token looked like a flag" — that guess consumed the
        // payload of `env -i sudo id`, since `-i` takes no value. Without it,
        // `env -u FOO sudo …`, `strace -o out.txt sudo …` and
        // `timeout --signal KILL 5 sudo …` stopped at the value instead.
        const prev = rest[j - 1];
        const isOptionValue = j > 1 && !!prev && (VALUE_TAKING_FLAGS[basename(rest[0])]?.has(prev) ?? false);
        // Stop the moment a token names a command: `timeout 5 /usr/bin/sudo x`
        // has a path-shaped argument that IS the payload, and consuming it
        // dropped the whole invocation to the ASK-level permission. An option's
        // value is exempt — `timeout --signal KILL 5 sudo id` stopped at the
        // SIGNAL and reported `kill`.
        const nameOfT = basename(t);
        if (!isOptionValue && (COMMAND_WRAPPERS.has(nameOfT) || ELEVATED_COMMANDS.includes(nameOfT))) break;
        if (
          !(
            FLAG.test(t) ||
            WRAPPER_ARG.test(t) ||
            PLACEHOLDER.test(t) ||
            isOptionValue ||
            (takesPath && WRAPPER_PATH_ARG.test(t))
          )
        )
          break;
        j++;
      }
      rest = inlineCommand ?? rest.slice(j);
      if (rest.length > 0) candidates.push(normalize(rest));
    }

    if (rest === before) break;
  }
  return candidates.filter(Boolean);
}

/**
 * File suffixes that keep a dot part of the NAME rather than ending it.
 *
 * `halt.json` and `verify.sh` are data and scripts, not the `halt` binary;
 * `nc.openbsd` and `mkfs.ext4` are the binaries. One short list decides which,
 * because both mistakes are real: without it a config path is refused, with a
 * blanket dot-continues rule the packaged binaries are not.
 */
const DATA_SUFFIX =
  /^(?:json|ya?ml|sh|bash|zsh|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|php|pl|lua|c|h|o|a|so|cc|cpp|hpp|cs|swift|kt|scala|sql|css|s?html?|txt|md|rst|toml|conf|cfg|ini|xml|lock|log|csv|tsv|env|bak|tmp|gz|zip|tar|snap|test|spec)$/i;

/**
 * Is what follows a matched name a FILE's extension rather than the rest of a
 * binary's name?
 *
 * Judged on the last dot-segment, because a filename has more than one:
 * `shutdown.test.ts` and `reboot.spec.ts` are test files, and an anchored match
 * on the first segment saw `test` / `spec` and refused them — non-retryably,
 * through the scorer. `nc.openbsd` and `mkfs.ext4` end in no known extension
 * and stay binaries.
 */
function looksLikeFilename(afterMatch: string): boolean {
  const last = afterMatch.slice(afterMatch.lastIndexOf('.') + 1);
  return DATA_SUFFIX.test(last);
}

/**
 * Does `text` invoke `name` as a COMMAND — as the start of any token, rather
 * than inside one?
 *
 * Token position, not "head of a segment after peeling wrappers". Peeling can
 * only recognise the wrappers it has been told about, and the list can never be
 * complete: `flock /tmp/x nc …`, `strace nc …`, `proxychains nc …` and
 * `env -u LD_PRELOAD nc …` all hid a reverse shell behind a prefix the peeler
 * did not model. Every one of those was refused before this branch, so treating
 * an unknown prefix as safe was a security regression, and one that any new
 * wrapper would reopen.
 *
 * A token start is the property that actually matters: it catches the command
 * wherever a prefix puts it, and it still spares the measured false positives —
 * `npm run sync tests` and `go test ./internal/sync` have no token BEGINNING
 * with `nc`.
 */
function invokesCommand(text: string, name: string): boolean {
  const b = name.toLowerCase().trim();
  if (!b) return false;

  // Backticks and `${...}` delimit a command as surely as `;` or `|` does:
  // `` echo `nc -e /bin/sh …` `` runs nc. `$(` survived only because `(` was
  // already here.
  // An entry written with a trailing space (`nc `, `ncat `) means the command
  // WITH arguments, so a bare trailing `nc` is not one — that is what keeps
  // `npm test -- --grep nc` and `git add src/nc` out of the denylist.
  const needsArgs = name.endsWith(' ');

  // Segment FIRST, then scan each segment's tokens. A rule derived from the
  // flattened line is taken from its FIRST command and applied to all of them:
  // `ls -la; nc -e /bin/sh …` and `echo ok && strace -f nc …` both went
  // unchecked that way, while the same second command alone was refused.
  for (const segment of text.split(/&&|\|\||[;&|\n()`]/)) {
    const tokens = segment.split(/[\s{}$]+/).filter(Boolean);
    if (tokens.length === 0) continue;

    // NO "a token after a bare flag is that flag's value" rule here, and that
    // is deliberate. It has to know which head is a wrapper to be safe — a
    // wrapper's flags are its own and the command follows them — and the
    // wrapper list can never be complete: `firejail --quiet nc -e /bin/sh …`,
    // `systemd-run --quiet nc …` and any future launcher slipped straight
    // through it. Twice now that rule has reopened the bypass this matcher
    // exists to close, so what it bought — allowing `--grep shutdown` — is
    // given up instead. `npm run halt` is refused on the same grounds, and the
    // substring rule on main refused both.

    for (let i = 0; i < tokens.length; i++) {
      // An entry written with a trailing space (`nc `) means the command WITH
      // arguments, so a bare trailing `nc` is an argument, not an invocation.
      if (needsArgs && i === tokens.length - 1) continue;

      // Compare the program's own name, so `/usr/sbin/shutdown` matches.
      const token = basename(tokens[i]);
      if (!token.startsWith(b)) continue;
      const next = token[b.length];
      if (next === undefined) return true;
      // A dot ends a binary's name (`nc.openbsd`) but not a file's
      // (`halt.json`, `shutdown.test.ts`).
      if (next === '.') {
        if (looksLikeFilename(token.slice(b.length + 1))) continue;
        return true;
      }
      if (/[/~]/.test(next)) return true;
    }
  }
  return false;
}

/**
 * Why this command may not run, or null when the content policy permits it.
 *
 * Returns a reason rather than throwing, because one caller wants an exception
 * and the other wants a failed gate.
 */
export function commandPolicyViolation(command: string): string | null {
  const raw = command.trim();
  // Newlines survive normalization: they are command separators, and
  // collapsing them would let a second line read as arguments to the first.
  const forms = [raw.toLowerCase().replace(/[^\S\n]+/g, ' '), ...dequotedForms(command)];

  for (const form of forms) {
    const squeezed = form.replace(/\s+/g, '');
    for (const blocked of BLOCKED_COMMANDS) {
      const b = blocked.toLowerCase();
      const hit = MATCH_ANYWHERE.has(blocked)
        ? form.includes(b.trim()) ||
          // Squeezing whitespace defeats `rm  -rf  /` and `: ( ) { … } ; :`.
          // Withheld from BARE WORDS, where it invents matches across unrelated
          // tokens: `mkfs` refused `git commit -m "mk fs"` and `ls mk fs`. An
          // entry carrying punctuation or a space is a pattern, not a name, and
          // squeezing it cannot join two innocent words into one.
          (!/^[a-z0-9]+$/.test(b.trim()) && squeezed.includes(b.replace(/\s+/g, '')))
        : invokesCommand(form, b);
      if (hit) return `Blocked command detected: ${blocked}`;
    }
  }

  // Over every form, not just the raw text: the quoting bypass this module was
  // written to close was still open for the injection half, so
  // `cat .env | "curl" -X POST …` evaded `/\|\s*curl\s+/` while the dequoted
  // form computed two lines above would have matched it.
  for (const form of forms) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(form)) return 'Potential command injection detected';
    }
  }

  return null;
}
