import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Where the legacy loader looks: `~/.octipus/legacy-plugins`, never the
 * Octipus checkout or the server's working directory. Plugins left in
 * `<cwd>/extensions` are not loaded; the operator is told once where they go.
 */
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/logger')>();
  const child = { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { ...actual, createChildLogger: () => child };
});

const { getLoadedPlugin, legacyPluginsDir, loadPlugins, resetFormerDirWarningForTests } = await import('./loader');

let root: string;

function writePlugin(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'plugin.json'), JSON.stringify({
    name, version: '1.0.0', description: 'd', apiVersion: '1.0.0', main: 'index.mjs',
    capabilities: { tools: [{ name: 'ping', description: 'p', parameters: {} }] },
  }));
  writeFileSync(join(dir, name, 'index.mjs'), `export default { name: ${JSON.stringify(name)}, tools: { ping: async () => 'pong' } };`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octipus-legacy-dir-'));
  warn.mockClear();
  resetFormerDirWarningForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('legacy plugin directory', () => {
  test('defaults to ~/.octipus/legacy-plugins', () => {
    expect(legacyPluginsDir('/home/u')).toBe(join('/home/u', '.octipus', 'legacy-plugins'));
  });

  test('loads from the per-user directory, not from <cwd>/extensions', async () => {
    const home = join(root, 'home');
    const cwd = join(root, 'checkout');
    writePlugin(legacyPluginsDir(home), 'home-plugin');
    writePlugin(join(cwd, 'extensions'), 'checkout-plugin');

    const loaded = await loadPlugins({ dir: legacyPluginsDir(home), cwd });

    expect(loaded.map((p) => p.manifest.name)).toEqual(['home-plugin']);
    expect(getLoadedPlugin('checkout-plugin')).toBeUndefined();
  });

  test('warns once, naming the plugins left in <cwd>/extensions and where they go', async () => {
    const cwd = join(root, 'checkout');
    const dir = legacyPluginsDir(join(root, 'home'));
    writePlugin(join(cwd, 'extensions'), 'left-a');
    writePlugin(join(cwd, 'extensions'), 'left-b');
    mkdirSync(join(cwd, 'extensions', 'not-a-plugin'));

    await loadPlugins({ dir, cwd });
    await loadPlugins({ dir, cwd });

    const calls = warn.mock.calls.filter(([, msg]) => typeof msg === 'string' && msg.includes('no longer loaded'));
    expect(calls).toHaveLength(1);
    const [fields, msg] = calls[0] as [{ plugins: string[] }, string];
    expect(fields.plugins.sort()).toEqual(['left-a', 'left-b']);
    expect(msg).toContain(dir);
    expect(msg).toContain('octi plugin convert');
    expect(msg).not.toContain('not-a-plugin');
  });

  test('says nothing when <cwd>/extensions is absent or holds no plugins', async () => {
    const cwd = join(root, 'checkout');
    mkdirSync(join(cwd, 'extensions'), { recursive: true });
    writeFileSync(join(cwd, 'extensions', '.gitkeep'), '');
    await loadPlugins({ dir: legacyPluginsDir(join(root, 'home')), cwd });
    expect(warn.mock.calls.some(([, msg]) => typeof msg === 'string' && msg.includes('no longer loaded'))).toBe(false);
  });
});
