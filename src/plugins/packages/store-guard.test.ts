/**
 * The plugin store and data directories never resolve inside
 * `<install>/plugins`, where only the plugins Octipus ships live
 * (docs/PLUGIN-PACKAGES.md#where-plugins-live).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { octipusRoot } from '@/utils/install-root';

const state = vi.hoisted(() => ({ rootPath: '' }));
vi.mock('@/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/config')>(),
  getConfig: () => ({ workspace: { rootPath: state.rootPath } }),
}));

const { assertStoreOutsideInstall, installFromDirectory } = await import('./service');

describe('the plugin store guard', () => {
  test('a workspace outside the install is accepted', () => {
    state.rootPath = join(tmpdir(), 'octipus-ws');
    expect(() => assertStoreOutsideInstall()).not.toThrow();
  });

  test('a workspace inside <install>/plugins is refused, before anything is copied', async () => {
    for (const rootPath of [join(octipusRoot(), 'plugins'), join(octipusRoot(), 'plugins', 'ws')]) {
      state.rootPath = rootPath;
      expect(() => assertStoreOutsideInstall()).toThrow(/only the plugins Octipus ships live/);
      await expect(installFromDirectory(join(tmpdir(), 'nowhere'), 'u')).rejects.toMatchObject({ code: 'invalid' });
    }
  });
});
