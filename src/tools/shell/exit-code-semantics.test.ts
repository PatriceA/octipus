import { describe, expect, test } from 'vitest';
import { interpretExit } from './exit-code-semantics';

describe('interpretExit', () => {
  test('exit 0 always ok', () => {
    expect(interpretExit('grep foo bar.txt', 0).outcome).toBe('ok');
    expect(interpretExit('anything', 0).outcome).toBe('ok');
  });

  test('grep 1 = no_match', () => {
    const r = interpretExit('grep foo bar.txt', 1);
    expect(r.outcome).toBe('expected_nonzero');
    expect(r.semantic).toBe('no_match');
  });

  test('grep 2 = error', () => {
    expect(interpretExit('grep foo missing.txt', 2).semantic).toBe('error');
  });

  test('diff 1 = files_differ', () => {
    const r = interpretExit('diff a.txt b.txt', 1);
    expect(r.outcome).toBe('expected_nonzero');
    expect(r.semantic).toBe('files_differ');
  });

  test('git diff --exit-code 1 = has_changes', () => {
    const r = interpretExit('git diff --exit-code', 1);
    expect(r.outcome).toBe('expected_nonzero');
    expect(r.semantic).toBe('has_changes');
  });

  test('git diff 1 (without --exit-code) = error', () => {
    expect(interpretExit('git diff', 1).outcome).toBe('error');
  });

  test('test -f false = 1', () => {
    const r = interpretExit('test -f /tmp/missing', 1);
    expect(r.outcome).toBe('expected_nonzero');
    expect(r.semantic).toBe('false');
  });

  test('[ false ] = 1', () => {
    expect(interpretExit('[ -f /nope ]', 1).semantic).toBe('false');
  });

  test('unknown command non-zero = error', () => {
    expect(interpretExit('ls', 1).outcome).toBe('error');
    expect(interpretExit('cat file', 127).outcome).toBe('error');
  });

  test('rg 1 = no_match (ripgrep is grep-compatible)', () => {
    expect(interpretExit('rg pattern', 1).semantic).toBe('no_match');
  });

  test('handles absolute path binaries', () => {
    expect(interpretExit('/usr/bin/grep x y.txt', 1).semantic).toBe('no_match');
  });

  test('empty command falls through to error', () => {
    expect(interpretExit('', 1).outcome).toBe('error');
  });

  test('a compound exit is not attributed to an earlier search', () => {
    expect(interpretExit('grep foo x.txt | head', 1).outcome).toBe('error');
  });
});


test.each([
  "git grep -l -I -E '(BEGIN PRIVATE KEY|AKIA[0-9]+|gh[pousr]_)'",
  "git -C '/repo with space' grep -q secret",
  "git -c color.ui=false grep -q secret",
  "rg -n 'chmod|shutdown|USER|VOLUME' Dockerfile",
  '/usr/bin/grep -q secret file',
])('search exit 1 with empty stderr means no matches: %s (#73)', command => {
  expect(interpretExit(command, 1, '')).toEqual({ outcome: 'expected_nonzero', semantic: 'no_match' });
  expect(interpretExit(command, 1, 'permission denied').outcome).toBe('error');
  expect(interpretExit(command, 2, '').outcome).toBe('error');
});

test.each(['git grep x; false', 'rg x && false', 'grep x | failing-filter', 'echo "$(rg x)"'])('does not hide a compound-command failure: %s', command => {
  expect(interpretExit(command, 1).outcome).toBe('error');
});
