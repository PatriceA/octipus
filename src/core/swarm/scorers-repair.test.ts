import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScorers, requoteSplitPath } from './scorers';

// A workspace whose path contains a space — the whole point of the repair.
const root = mkdtempSync(join(tmpdir(), 'Github Rep '));
const cwd = join(root, 'proj');
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, 'test_x.py'), 'print("ok")\n');

describe('requoteSplitPath', () => {
  it('re-quotes an absolute path split by a space', () => {
    const cmd = `python3 ${join(cwd, 'test_x.py')}`;
    expect(existsSync(join(cwd, 'test_x.py'))).toBe(true);
    expect(requoteSplitPath(cmd, cwd)).toBe(`python3 '${join(cwd, 'test_x.py')}'`);
  });

  it('leaves an ordinary command alone', () => {
    for (const cmd of ['pytest -q', 'python3 -m unittest discover', 'npm test']) {
      expect(requoteSplitPath(cmd, cwd)).toBe(cmd);
    }
  });

  it('leaves a command the author already quoted alone', () => {
    const cmd = `python3 '${join(cwd, 'test_x.py')}'`;
    expect(requoteSplitPath(cmd, cwd)).toBe(cmd);
  });

  it('does not invent a path that does not exist', () => {
    const cmd = `python3 ${join(cwd, 'missing file.py')}`;
    expect(requoteSplitPath(cmd, cwd)).toBe(cmd);
  });
});

describe('any_of', () => {
  it('accepts two alternatives', () => {
    const out = parseScorers([
      { kind: 'any_of', scorers: [
        { kind: 'command_exit_zero', command: 'pytest -q' },
        { kind: 'command_exit_zero', command: 'python3 -m unittest discover' }] },
    ]);
    expect('scorers' in out).toBe(true);
    if ('scorers' in out) expect(out.scorers[0]).toMatchObject({ kind: 'any_of' });
  });

  it('refuses fewer than two alternatives', () => {
    const out = parseScorers([{ kind: 'any_of', scorers: [{ kind: 'non_empty' }] }]);
    expect('error' in out).toBe(true);
  });

  it('refuses nesting', () => {
    const out = parseScorers([
      { kind: 'any_of', scorers: [
        { kind: 'non_empty' },
        { kind: 'any_of', scorers: [{ kind: 'non_empty' }, { kind: 'non_empty' }] }] },
    ]);
    expect('error' in out).toBe(true);
  });
});
