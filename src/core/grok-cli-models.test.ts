import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ exec: vi.fn(), root: '', preparationFails: false }));
vi.mock('node:child_process', () => ({ execFile: fixture.exec }));
vi.mock('./cli-executable', () => ({ configuredCliBinary: () => '/configured/grok' }));
vi.mock('./grok-cli-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('./grok-cli-runtime')>();
  return { ...actual, prepareGrokRuntime: (options: Parameters<typeof actual.prepareGrokRuntime>[0]) => {
    if (fixture.preparationFails) throw new Error('private preparation diagnostic');
    return actual.prepareGrokRuntime({ ...options, stateRoot: join(fixture.root, 'state'), temporaryRoot: join(fixture.root, 'temporary') });
  } };
});
import { discoverGrokModels, parseGrokModels, resetGrokModelCatalog } from './grok-cli-models';

const freeCatalog = 'You are logged in with grok.com.\n\nDefault model: account-free\n\nAvailable models:\n  * account-free (default)\n';
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'grok-catalog-'));
  vi.stubEnv('GROK_AUTH_PATH', join(fixture.root, 'original-auth.json'));
  vi.stubEnv('XAI_API_KEY', 'server-key-not-for-account-catalog');
  vi.stubEnv('DATABASE_URL', 'private-database-url');
  vi.stubEnv('GROK_CONFIG', '{"host_overlay":true}');
});
afterEach(() => {
  resetGrokModelCatalog(); fixture.exec.mockReset(); fixture.preparationFails = false;
  vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(fixture.root, { recursive: true, force: true });
});

describe('Grok account model catalog', () => {
  it('returns only the free-account model, not banners or a separately mentioned default', () => {
    expect(parseGrokModels(freeCatalog)).toEqual([{ id: 'account-free', label: 'account-free (default)' }]);
    expect(parseGrokModels(freeCatalog.replace('Default model: account-free', 'Default model: unavailable-model'))).toHaveLength(1);
  });
  it('accepts multiple account models, terminal coloring and CRLF, and removes duplicate IDs', () => {
    expect(parseGrokModels('\u001b[32mAvailable models:\u001b[0m\r\n  * account-a (default)\r\n    account-b\r\n  * account-a (default)\r\n'))
      .toEqual([{ id: 'account-a', label: 'account-a (default)' }, { id: 'account-b', label: 'account-b' }]);
  });
  it.each(['', 'Login required', 'Default model: account-free', 'Available models:\n', 'Available models:\n  Error: network unavailable'])('rejects unavailable or malformed output: %j', text => {
    expect(() => parseGrokModels(text)).toThrow(/invalid|empty/);
  });
  it.each([false, true])('coalesces requests, caches results and failures, and cleans isolated config (failure=%s)', async failure => {
    let isolatedHome = '';
    fixture.exec.mockImplementation((binary: string, args: string[], options: { env: Record<string, string>; cwd: string; timeout: number }, callback: (error: Error | null, stdout: string) => void) => {
      expect(binary).toBe('/configured/grok'); expect(args).toEqual(['--no-leader', 'models']);
      expect(options.cwd).toContain(join(fixture.root, 'state'));
      expect(options.timeout).toBe(20_000);
      expect(options.env.GROK_AUTH_PATH).toBe(join(fixture.root, 'original-auth.json'));
      expect(options.env).not.toHaveProperty('XAI_API_KEY');
      expect(options.env).not.toHaveProperty('DATABASE_URL');
      expect(options.env).not.toHaveProperty('GROK_CONFIG');
      isolatedHome = options.env.HOME;
      expect(existsSync(isolatedHome)).toBe(true);
      queueMicrotask(() => callback(failure ? new Error('private token-shaped diagnostic') : null, freeCatalog));
    });
    const results = await Promise.allSettled([discoverGrokModels(), discoverGrokModels()]);
    expect(results.every(r => r.status === (failure ? 'rejected' : 'fulfilled'))).toBe(true);
    if (failure) await expect(discoverGrokModels()).rejects.toThrow('Run grok login and grok models');
    else expect(await discoverGrokModels()).toEqual([{ id: 'account-free', label: 'account-free (default)' }]);
    expect(fixture.exec).toHaveBeenCalledTimes(1);
    expect(existsSync(isolatedHome)).toBe(false);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + (failure ? 31_000 : 301_000));
    if (failure) await expect(discoverGrokModels()).rejects.toThrow('catalog unavailable');
    else await expect(discoverGrokModels()).resolves.toHaveLength(1);
    expect(fixture.exec).toHaveBeenCalledTimes(2);
    expect(existsSync(isolatedHome)).toBe(false);
  });
  it('sanitizes and caches configuration-preparation failures', async () => {
    fixture.preparationFails = true;
    await expect(discoverGrokModels()).rejects.toThrow('catalog unavailable');
    await expect(discoverGrokModels()).rejects.not.toThrow('private preparation diagnostic');
    expect(fixture.exec).not.toHaveBeenCalled();
  });
});
