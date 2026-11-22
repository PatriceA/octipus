import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERSISTED_STATE, loadPersistedState, pathForProject, savePersistedState } from './persist';

const tmps: string[] = [];
const problems: string[] = [];
const report = (problem: string) => { problems.push(problem); };
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-tui-persist-'));
  tmps.push(dir);
  return join(dir, 'state.json');
}

afterEach(() => {
  for (const t of tmps.splice(0)) {
    try { rmSync(t.replace(/\/state\.json$/, ''), { recursive: true, force: true }); } catch { /* */ }
  }
});

describe('persist', () => {
  test('missing file returns default state', () => {
    const path = tmp();
    expect(loadPersistedState(path, report)).toEqual(DEFAULT_PERSISTED_STATE);
  });

  test('round-trip preserves fields', () => {
    const path = tmp();
    const state = {
      version: 1 as const,
      openPaths: ['/a.ts', '/b.ts'],
      activePath: '/a.ts',
      treeVisible: false,
      chatVisible: true,
      editorMode: 'vim' as const,
      cursorByPath: { '/a.ts': { line: 4, col: 7 } },
    };
    expect(savePersistedState(state, path, report)).toBe(true);
    expect(loadPersistedState(path, report)).toEqual({ ...state, drafts: [] });
  });

  test('corrupt json falls back to default, and says why', () => {
    const path = tmp();
    require('node:fs').writeFileSync(path, '{ this is not json', 'utf8');
    problems.length = 0;
    expect(loadPersistedState(path, report)).toEqual(DEFAULT_PERSISTED_STATE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`The editor's saved state (${path}) could not be read`);
  });

  test('a missing file or another version is the default without a word; a failed save says why', () => {
    const path = tmp();
    problems.length = 0;
    loadPersistedState(path, report);
    require('node:fs').writeFileSync(path, JSON.stringify({ version: 99 }), 'utf8');
    loadPersistedState(path, report);
    expect(problems).toEqual([]);
    // A folder where the file's parent should be: the write cannot happen.
    require('node:fs').writeFileSync(`${path}-parent`, 'a file', 'utf8');
    expect(savePersistedState(DEFAULT_PERSISTED_STATE, `${path}-parent/state.json`, report)).toBe(false);
    expect(problems[0]).toContain('The recovery checkpoint');
  });

  test('wrong version falls back to default', () => {
    const path = tmp();
    require('node:fs').writeFileSync(path, JSON.stringify({ version: 99 }), 'utf8');
    expect(loadPersistedState(path, report)).toEqual(DEFAULT_PERSISTED_STATE);
  });

  test('non-string openPaths entries are filtered', () => {
    const path = tmp();
    require('node:fs').writeFileSync(path, JSON.stringify({
      version: 1,
      openPaths: ['/a', 42, null, '/b'],
      activePath: '/a',
    }), 'utf8');
    expect(loadPersistedState(path, report).openPaths).toEqual(['/a', '/b']);
  });

  test('save writes atomically (no .tmp left behind)', () => {
    const path = tmp();
    savePersistedState(DEFAULT_PERSISTED_STATE, path, report);
    const fs = require('node:fs');
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.existsSync(`${path}.tmp`)).toBe(false);
  });

  test('pathForProject scopes per absolute project path', () => {
    const a = pathForProject('/repo-a');
    const b = pathForProject('/repo-b');
    expect(a).not.toEqual(b);
    expect(a).toMatch(/projects[\\/][0-9a-f]+[\\/]tui-editor\.json$/);
    // Same input → same output (deterministic).
    expect(pathForProject('/repo-a')).toEqual(a);
  });

  test('pathForProject falls back to legacy location when omitted', () => {
    const legacy = pathForProject();
    expect(legacy).toMatch(/tui-editor\.json$/);
    expect(legacy).not.toContain('projects');
  });
});

test('drafts beyond the file-open limit round-trip without silent loss', () => {
  const path = tmp();
  const text = 'x'.repeat(5 * 1024 * 1024 + 1);
  const state = { ...DEFAULT_PERSISTED_STATE, drafts: [{ path: '/large.txt', label: 'large.txt', text }] };
  expect(savePersistedState(state, path, report)).toBe(true);
  expect(loadPersistedState(path, report).drafts?.[0].text).toBe(text);
  // POSIX only — Windows has no mode bits for `chmod` to set (see the spill
  // and cli-session suites for the same note).
  if (process.platform !== 'win32') {
    expect(require('node:fs').statSync(path).mode & 0o777).toBe(0o600);
  }
});
