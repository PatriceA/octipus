/**
 * devMode authorization policy.
 *
 * devMode/projectPath let the caller point the agent's filesystem tools at an
 * arbitrary host path. Allowed on a single-user install (the caller is the
 * operator) or for an admin; denied for a non-admin on a multiuser instance,
 * where it would be a sandbox escape.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { devModeAllowed } from './devmode';

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
async function reload() {
  const { resetConfig, loadConfig } = await import('@/config');
  resetConfig();
  loadConfig();
}

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  const { resetConfig } = await import('@/config');
  resetConfig();
});

describe('devModeAllowed', () => {
  test('multiuser OFF → allowed for anyone (single-user / local install)', async () => {
    setEnv('MULTIUSER', 'false');
    await reload();
    expect(devModeAllowed(false)).toBe(true);
    expect(devModeAllowed(true)).toBe(true);
  });

  test('multiuser ON → allowed only for admins', async () => {
    setEnv('MULTIUSER', 'true');
    await reload();
    expect(devModeAllowed(true)).toBe(true);
    expect(devModeAllowed(false)).toBe(false);
  });
});
