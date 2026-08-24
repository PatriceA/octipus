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

  it('still refuses a command whose RAW text contains a blocked entry', () => {
    // Pre-existing behaviour, asserted so the argv anchoring above is not
    // mistaken for a loosening. The raw-string scan is untouched, so a command
    // that spells a blocked entry in its own text — `grep -r "rm -rf /" .`, or
    // `find . -name mkfs.conf` — is refused now exactly as it was before this
    // branch. Coarse, and left alone: tightening it is a separate change with
    // its own risk, and widening what runs is not this commit's business.
    expect(commandPolicyViolation('grep -r "rm -rf /" .')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('find . -name mkfs.conf')).toMatch(/Blocked command detected/);
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

  it('inherits the raw scan’s coarseness, and says so', () => {
    // `haltcheck` and `shutdownctl` contain a bare denylist entry in their own
    // text, so the untouched raw substring scan refuses them — as it did before
    // this branch. Recorded rather than quietly fixed: loosening that rule is a
    // separate change with its own risk, and this commit only owes the argv
    // path it added.
    expect(commandPolicyViolation('haltcheck --x y')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('shutdownctl --status')).toMatch(/Blocked command detected/);
  });

  it('still refuses the real command after a separator', () => {
    expect(commandPolicyViolation('echo x && shutdown')).toMatch(/Blocked command detected/);
    expect(commandPolicyViolation('true; halt')).toMatch(/Blocked command detected/);
  });
});
