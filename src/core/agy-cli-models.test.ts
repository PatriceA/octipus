import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mock = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mock.exec }));
vi.mock('./cli-executable', () => ({ configuredCliBinary: () => '/configured/agy' }));
import { parseAgyModels, discoverAgyModels, resetAgyModelCatalog } from './agy-cli-models';
const roots: string[] = [];
afterEach(() => { resetAgyModelCatalog(); vi.unstubAllEnvs(); mock.exec.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('AGY authenticated CLI catalog', () => {
  it('parses vendor IDs and human-readable labels without inventing a model', () => {
    expect(parseAgyModels('vendor-a\tModel A\nvendor-b\tModel B\n')).toEqual([{ id: 'vendor-a', label: 'Model A' }, { id: 'vendor-b', label: 'Model B' }]);
    expect(() => parseAgyModels('sign in required')).toThrow('invalid');
    expect(() => parseAgyModels('')).toThrow('empty');
  });
  it.each([false, true])('coalesces and caches catalog lookups without inference (failure=%s)', async failure => {
    const root = mkdtempSync(join(tmpdir(), 'agy-catalog-')); roots.push(root);
    vi.stubEnv('ANTIGRAVITY_GEMINI_DIR', root);
    mock.exec.mockImplementation((_binary: string, args: string[], opts: { env: Record<string, string> }, cb: (error: Error | null, stdout: string) => void) => {
      expect(args).toEqual(['--settings', expect.stringContaining('settings.json'), 'models']); expect(opts.env.HOME).not.toBe(process.env.HOME);
      expect(opts.env).not.toHaveProperty('DATABASE_URL');
      queueMicrotask(() => cb(failure ? new Error('sensitive failure output') : null, 'vendor-a\tModel A\n'));
    });
    const results = await Promise.allSettled([discoverAgyModels(), discoverAgyModels()]);
    expect(results.every(r => r.status === (failure ? 'rejected' : 'fulfilled'))).toBe(true);
    if (failure) await expect(discoverAgyModels()).rejects.toThrow('catalog unavailable');
    else await expect(discoverAgyModels()).resolves.toEqual([{ id: 'vendor-a', label: 'Model A' }]);
    expect(mock.exec).toHaveBeenCalledTimes(1);
  });
});
