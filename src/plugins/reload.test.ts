import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getLoadedPlugin, loadPlugins, reloadPlugin } from './loader';

/**
 * The loader against a real `extensions/` directory: the hot reload must pick
 * up edited code (Node caches ESM by URL), keep the running plugin when the new
 * copy fails, and shut the old module down exactly once.
 */
let root: string;
let pluginDir: string;

const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({
  name: 'reload-probe',
  version: '1.0.0',
  description: 'probe',
  apiVersion: '1.0.0',
  main: 'index.mjs',
  // Tools declared the way the shipped example does: only under capabilities.
  capabilities: { tools: [{ name: 'which', description: 'version marker', parameters: {} }] },
  ...extra,
});

const source = (version: string) => `
globalThis.__reloadProbe ??= { shutdowns: [] };
export default {
  name: 'reload-probe',
  tools: { which: async () => ({ version: ${JSON.stringify(version)} }) },
  async shutdown() { globalThis.__reloadProbe.shutdowns.push(${JSON.stringify(version)}); },
};
`;

const probe = () => (globalThis as unknown as { __reloadProbe: { shutdowns: string[] } }).__reloadProbe;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octipus-plugin-reload-'));
  pluginDir = join(root, 'extensions', 'reload-probe');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), manifest());
  writeFileSync(join(pluginDir, 'index.mjs'), source('v1'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  (globalThis as unknown as { __reloadProbe?: unknown }).__reloadProbe = { shutdowns: [] };
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const call = async () => (await getLoadedPlugin('reload-probe')!.module.tools.which({})) as { version: string };

describe('plugin hot reload', () => {
  test('a capabilities-only manifest loads with its effective tool list in `tools`', async () => {
    await loadPlugins();
    expect(getLoadedPlugin('reload-probe')!.manifest.tools.map((t) => t.name)).toEqual(['which']);
  });

  test('picks up edited code, and shuts the previous module down once', async () => {
    await loadPlugins();
    expect(await call()).toEqual({ version: 'v1' });
    writeFileSync(join(pluginDir, 'index.mjs'), source('v2'));
    await reloadPlugin('reload-probe');
    expect(await call()).toEqual({ version: 'v2' });
    expect(probe().shutdowns).toEqual(['v1']);
  });

  test('retire replaces the default shutdown (the API unregisters the tool instead)', async () => {
    await loadPlugins();
    writeFileSync(join(pluginDir, 'index.mjs'), source('v2'));
    const retired: string[] = [];
    await reloadPlugin('reload-probe', async (previous) => { retired.push(previous.manifest.version); });
    expect(retired).toEqual(['1.0.0']);
    expect(probe().shutdowns).toEqual([]);
  });

  test('a copy that fails to load leaves the running plugin loaded and untouched', async () => {
    await loadPlugins();
    writeFileSync(join(pluginDir, 'index.mjs'), 'export default {'); // syntax error
    await expect(reloadPlugin('reload-probe')).rejects.toThrow();
    expect(await call()).toEqual({ version: 'v1' });
    expect(probe().shutdowns).toEqual([]);
  });

  test('a renamed manifest is refused rather than stored under the old name', async () => {
    await loadPlugins();
    writeFileSync(join(pluginDir, 'plugin.json'), manifest({ name: 'renamed-probe' }));
    await expect(reloadPlugin('reload-probe')).rejects.toThrow(/renamed-probe/);
    expect(await call()).toEqual({ version: 'v1' });
  });
});
