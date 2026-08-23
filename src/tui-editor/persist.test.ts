import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PERSISTED_STATE, loadPersistedState, pathForProject, savePersistedState } from './persist';

const tmps: string[] = [];
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
    expect(loadPersistedState(path)).toEqual(DEFAULT_PERSISTED_STATE);
  });

  test('round-trip preserves fields', () => {
    const path = tmp();
    const state = {
      version: 1 as const,
      openPaths: ['/a.ts', '/b.ts'],
      activePath: '/a.ts',
      treeVisible: false,
      chatVisible: true,
      theme: 'light' as const,
      editorMode: 'vim' as const,
      cursorByPath: { '/a.ts': { line: 4, col: 7 } },
    };
    expect(savePersistedState(state, path)).toBe(true);
    expect(loadPersistedState(path)).toEqual(state);
  });

  test('corrupt json falls back to default', () => {
    const path = tmp();
    require('node:fs').writeFileSync(path, '{ this is not json', 'utf8');
    expect(loadPersistedState(path)).toEqual(DEFAULT_PERSISTED_STATE);
  });

  test('wrong version falls back to default', () => {
    const path = tmp();
    require('node:fs').writeFileSync(path, JSON.stringify({ version: 99 }), 'utf8');
    expect(loadPersistedState(path)).toEqual(DEFAULT_PERSISTED_STATE);
  });

  test('non-string openPaths entries are filtered', () => {
    const path = tmp();
    require('node:fs').writeFileSync(path, JSON.stringify({
      version: 1,
      openPaths: ['/a', 42, null, '/b'],
      activePath: '/a',
    }), 'utf8');
    expect(loadPersistedState(path).openPaths).toEqual(['/a', '/b']);
  });

  test('save writes atomically (no .tmp left behind)', () => {
    const path = tmp();
    savePersistedState(DEFAULT_PERSISTED_STATE, path);
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
