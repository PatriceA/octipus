import { describe, expect, test } from 'vitest';
import { commandScorerShapeError, parseScorers } from './scorers';

/**
 * A verification command that cannot run is a guaranteed gate failure, and the
 * gate runs AFTER a full child has been paid for.
 *
 * Measured 2026-08-29 on a single chat turn: the root attached
 * `cd <dir> && python3 -m unittest discover` as its `command_exit_zero` check.
 * The scorer runs argv-only, so `&&` is refused and `cd` is a builtin with no
 * binary to spawn — it could never have passed. The turn spent SIX `qa`
 * children, 460,321 tokens and 200 seconds re-discovering that, while the work
 * being verified had finished correctly in 39 seconds.
 *
 * `timeoutMs` was already rejected at parse time for exactly this reason, with
 * the rationale written above it ("it also buys a whole extra child run"). The
 * command itself was not.
 */

describe('commands that can never pass the gate', () => {
  test('a leading cd — the mistake that actually happened', () => {
    const err = commandScorerShapeError('cd /home/me/project && python3 -m unittest discover');
    expect(err).toMatch(/shell syntax/i);
    // The message has to say what to write instead, or it is just a wall.
    expect(err).toMatch(/unittest discover/);
  });

  test('a bare cd, which tokenizes cleanly and still cannot spawn', () => {
    // No metacharacter here, so only the builtin check catches it.
    expect(commandScorerShapeError('cd /tmp')).toMatch(/builtin/i);
  });

  test.each([
    'npm test && npm run lint',
    'pytest | tee out.txt',
    'python3 -m unittest; echo done',
    'echo $(whoami)',
    'npm test > results.txt',
  ])('shell syntax is refused: %s', (command) => {
    expect(commandScorerShapeError(command)).toMatch(/shell syntax/i);
  });

  test('a shell invoked with a command string', () => {
    expect(commandScorerShapeError('sh -c "npm test"')).toMatch(/shell with a command string/i);
    expect(commandScorerShapeError('bash -c "pytest"')).toMatch(/shell with a command string/i);
  });
});

describe('commands a verification gate is actually for', () => {
  test.each([
    'npm test',
    'pytest -q',
    'python3 -m unittest discover',
    'cargo test --all',
    'npx tsc --noEmit',
    'make check',
  ])('%s is fine', (command) => {
    expect(commandScorerShapeError(command)).toBeNull();
  });
});

describe('the spawn is rejected, not the child', () => {
  test('parseScorers refuses the unrunnable command up front', () => {
    const result = parseScorers([
      { kind: 'command_exit_zero', command: 'cd /tmp/project && npm test' },
    ]);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/scorers\[0\]\.command/);
  });

  test('a runnable command still parses', () => {
    const result = parseScorers([{ kind: 'command_exit_zero', command: 'npm test' }]);
    expect(result).not.toHaveProperty('error');
    expect((result as { scorers: unknown[] }).scorers).toHaveLength(1);
  });

  test('the other scorer kinds are unaffected', () => {
    const result = parseScorers([
      { kind: 'non_empty' },
      { kind: 'file_exists', path: 'report.md' },
      { kind: 'contains', value: 'PASS' },
    ]);
    expect(result).not.toHaveProperty('error');
  });
});

describe('the gate checks the tree the work happened in', () => {
  /**
   * `command_exit_zero` resolved its cwd to the per-user workspace root
   * unconditionally, on the stated grounds that "a child never receives a
   * projectPath". That holds on the pipeline path. It does not hold on a
   * dev-mode chat turn: `worker-spawner` sets `context.metadata.projectPath` on
   * the child, so the child's `shell__run` executes in the project while the
   * gate ran `python3 -m unittest discover` in a directory with no tests.
   *
   * The gate then failed work that was already correct — and the model's
   * apparent carelessness (`cd <project> && <test>`, which an argv-only gate
   * refuses) turns out to have been it compensating for exactly this.
   */
  test('the child working directory is part of the scorer context', async () => {
    const { buildScorerContext } = await import('./spawner');
    const ctx = buildScorerContext({
      userId: 'u1',
      filesTouched: null,
      childTools: [],
      childRole: 'qa',
      projectPath: '/tmp/some-project',
    });
    expect(ctx.projectPath).toBe('/tmp/some-project');
  });

  test('an ordinary session carries none, and the workspace root still applies', async () => {
    const { buildScorerContext } = await import('./spawner');
    const ctx = buildScorerContext({
      userId: 'u1',
      filesTouched: null,
      childTools: [],
      childRole: 'qa',
    });
    expect(ctx.projectPath).toBeUndefined();
  });
});
