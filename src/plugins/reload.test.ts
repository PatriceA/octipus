import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getLoadedPlugin, loadPlugins, PluginReloadError, reloadPlugin } from './loader';

/**
 * The loader against a real legacy plugin directory (`~/.octipus/legacy-plugins`): the hot reload must pick
 * up edited code (Node caches ESM by URL), keep the running plugin when the new
 * copy fails, and shut the old module down exactly once.
 */
let root: string;
let pluginDir: string;
let savedHome: string | undefined;

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

const source = (version: string, opts: { failInit?: boolean } = {}) => `
globalThis.__reloadProbe ??= { shutdowns: [], inits: [] };
export default {
  name: 'reload-probe',
  tools: { which: async () => ({ version: ${JSON.stringify(version)} }) },
  async initialize() {
    globalThis.__reloadProbe.inits.push(${JSON.stringify(version)});
    ${opts.failInit ? "throw new Error('port in use');" : ''}
  },
  async shutdown() { globalThis.__reloadProbe.shutdowns.push(${JSON.stringify(version)}); },
};
`;

const probe = () => (globalThis as unknown as { __reloadProbe: { shutdowns: string[]; inits: string[] } }).__reloadProbe;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'octipus-plugin-reload-'));
  pluginDir = join(root, '.octipus', 'legacy-plugins', 'reload-probe');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), manifest());
  writeFileSync(join(pluginDir, 'index.mjs'), source('v1'));
  // os.homedir() reads HOME on POSIX: the loader's default directory is under it.
  savedHome = process.env.HOME;
  process.env.HOME = root;
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  (globalThis as unknown as { __reloadProbe?: unknown }).__reloadProbe = { shutdowns: [], inits: [] };
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const call = async () => (await getLoadedPlugin('reload-probe')!.module.tools.which({})) as { version: string };

describe('plugin hot reload', () => {
  test('a capabilities-only manifest loads with its effective tool list in `tools`', async () => {
    await loadPlugins();
    expect(getLoadedPlugin('reload-probe')!.manifest.tools.map((t) => t.name)).toEqual(['which']);
  });

  test('picks up edited code; the old copy is shut down once, before the new one initializes', async () => {
    await loadPlugins();
    expect(await call()).toEqual({ version: 'v1' });
    writeFileSync(join(pluginDir, 'index.mjs'), source('v2'));
    await reloadPlugin('reload-probe');
    expect(await call()).toEqual({ version: 'v2' });
    expect(probe().shutdowns).toEqual(['v1']);
    // A plugin that binds a port in initialize can bind it again.
    expect(probe().inits).toEqual(['v1', 'v2']);
  });

  test('retire replaces the default shutdown (the API unregisters the tool instead)', async () => {
    await loadPlugins();
    writeFileSync(join(pluginDir, 'index.mjs'), source('v2'));
    const retired: string[] = [];
    await reloadPlugin('reload-probe', { retire: async (previous) => { retired.push(previous.manifest.version); } });
    expect(retired).toEqual(['1.0.0']);
    expect(probe().shutdowns).toEqual([]);
  });

  test('a copy whose initialize throws is shut down, and the previous copy comes back', async () => {
    await loadPlugins();
    writeFileSync(join(pluginDir, 'index.mjs'), source('v2', { failInit: true }));
    const restored: string[] = [];
    const err = await reloadPlugin('reload-probe', { restore: async (p) => { restored.push(p.manifest.version); } }).catch((e) => e);
    expect(err).toBeInstanceOf(PluginReloadError);
    expect(err).toMatchObject({ status: 500, restored: true });
    expect(probe().shutdowns).toEqual(['v1', 'v2']);
    expect(probe().inits).toEqual(['v1', 'v2', 'v1']);
    expect(restored).toEqual(['1.0.0']);
    expect(await call()).toEqual({ version: 'v1' });
  });

  test('an unknown name is a 404 and an overlapping reload a 409', async () => {
    await expect(reloadPlugin('nope')).rejects.toMatchObject({ status: 404 });
    await loadPlugins();
    let release!: () => void;
    const first = reloadPlugin('reload-probe', { retire: () => new Promise<void>((r) => { release = r; }) });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(reloadPlugin('reload-probe')).rejects.toMatchObject({ status: 409 });
    release();
    await first;
  });

  test('a copy that fails to load leaves the running plugin loaded and untouched', async () => {
    await loadPlugins();
    writeFileSync(join(pluginDir, 'index.mjs'), 'export default {'); // syntax error
    await expect(reloadPlugin('reload-probe')).rejects.toMatchObject({ status: 500, restored: true });
    expect(await call()).toEqual({ version: 'v1' });
    expect(probe().shutdowns).toEqual([]);
  });

  test('a renamed manifest is refused rather than stored under the old name', async () => {
    await loadPlugins();
    writeFileSync(join(pluginDir, 'plugin.json'), manifest({ name: 'renamed-probe' }));
    await expect(reloadPlugin('reload-probe')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/renamed-probe/) });
    expect(await call()).toEqual({ version: 'v1' });
  });
});
