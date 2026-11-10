/**
 * The manifest's `ui` and `host` fields (docs/PLUGIN-PACKAGES.md#pages,
 * #host-api): pages served from one directory by plain relative paths, and a
 * host scope list from the fixed set.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ManifestError, parseManifest } from './manifest';
import { isPlainRelativePath, uiDirOf } from './manifest-ui-host';

const HOST = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'host-plugin', 'octipus-plugin.json'), 'utf8'));

function problems(value: unknown): string[] {
  try {
    parseManifest(value);
  } catch (err) {
    if (err instanceof ManifestError) return err.problems;
    throw err;
  }
  throw new Error('expected a ManifestError');
}

const page = (over: Record<string, unknown> = {}) => ({ path: 'dashboard', title: 'Dashboard', entry: 'index.html', ...over });

describe('ui and host in the manifest', () => {
  test('the host fixture fits the contract', () => {
    const m = parseManifest(HOST);
    expect(m.ui?.pages.map((p) => p.path)).toEqual(['dashboard']);
    expect(m.host).toContain('notes:write');
    expect(uiDirOf(m.ui)).toBe('ui');
    expect(uiDirOf({ dir: 'web/dist' })).toBe('web/dist');
  });

  test('a package without them is unchanged', () => {
    const { ui: _ui, host: _host, ...rest } = HOST;
    void _ui; void _host;
    expect(parseManifest(rest).ui).toBeUndefined();
  });

  test.each([
    '../secret.html', 'ui/../../x.html', '/etc/passwd.html', '.hidden/x.html', 'a/./b.html', 'a\\b.html', 'a//b.html', '', 'a/.env.html',
  ])('the entry %j is refused', (entry) => {
    expect(problems({ ...HOST, ui: { pages: [page({ entry })] } }).some((p) => p.startsWith('ui.pages.entry:') || p.startsWith('ui.pages'))).toBe(true);
  });

  test('a ui dir outside the package, a non-HTML entry, bad paths and icons, duplicates and an empty list are refused', () => {
    expect(problems({ ...HOST, ui: { dir: '../x', pages: [page()] } })).toEqual(expect.arrayContaining([expect.stringMatching(/^ui\.dir:/)]));
    expect(problems({ ...HOST, ui: { pages: [page({ entry: 'app.js' })] } })).toContain('ui.pages: an entry is an .html file');
    expect(problems({ ...HOST, ui: { pages: [page({ path: 'Bad Path' })] } }).length).toBeGreaterThan(0);
    expect(problems({ ...HOST, ui: { pages: [page({ path: '../up' })] } }).length).toBeGreaterThan(0);
    expect(problems({ ...HOST, ui: { pages: [page({ icon: 'Not An Icon' })] } }).length).toBeGreaterThan(0);
    expect(problems({ ...HOST, ui: { pages: [page(), page()] } })).toContain('ui.pages: "dashboard" is declared twice');
    expect(problems({ ...HOST, ui: { pages: [] } })).toContain('ui.pages: declare at least one page');
    expect(problems({ ...HOST, ui: { pages: [page({ extra: 1 })] } }).length).toBeGreaterThan(0);
  });

  test('host scopes come from the fixed set, each once', () => {
    expect(problems({ ...HOST, host: ['notes:read', 'admin:all'] }).some((p) => p.startsWith('host: a scope is one of'))).toBe(true);
    expect(problems({ ...HOST, host: ['notes:read', 'notes:read'] })).toContain('host: a scope is declared twice');
    expect(parseManifest({ ...HOST, host: [] }).host).toEqual([]);
  });

  test('a plain relative path', () => {
    expect(isPlainRelativePath('index.html')).toBe(true);
    expect(isPlainRelativePath('assets/app.min.js')).toBe(true);
    for (const p of ['..', '../a', 'a/..', '.', './a', '/a', 'a\\b', 'a//b', '.git/config', 'a/'] as const) expect(isPlainRelativePath(p)).toBe(false);
  });
});
