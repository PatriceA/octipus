import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseScorers, requoteSplitPath, runScorers } from './scorers';

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

describe('the gate really spawns commands (live)', () => {
  it('runs an unquoted absolute path with a space, and any_of takes the second branch', async () => {
    // A workspace whose path has a space, like the one this was found in.
    const live = mkdtempSync(join(tmpdir(), 'Github Rep '));
    const marker = join(live, 'GATE_RAN');
    writeFileSync(join(live, 'gate_marker.py'),
      'import pathlib, sys\n' +
      'pathlib.Path(__file__).with_name("GATE_RAN").write_text("yes")\n' +
      'sys.exit(1)\n');

    const permissions = await import('@/security/permissions');
    const spy = vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({
      check: async () => ({ allowed: true, level: 'ALLOW', requiresApproval: false }),
    } as never);

    const out = await runScorers(
      [{ kind: 'any_of', scorers: [
        // Unquoted, absolute, and containing a space: without the repair the
        // interpreter is handed '/…/Github' and the file is never touched.
        { kind: 'command_exit_zero', command: `python3 ${join(live, 'gate_marker.py')}` },
        { kind: 'command_exit_zero', command: 'python3 --version' }] }],
      { output: 'x' },
      { canRunCommands: true, userId: 'system', role: 'coding', projectPath: live },
    );
    spy.mockRestore();

    // The marker is the proof the first command actually ran, path intact.
    expect(existsSync(marker)).toBe(true);
    // …and the gate still passed, because the second branch exits zero.
    expect(out.failures).toEqual([]);
    expect(out.passed).toBe(true);
  });
});
