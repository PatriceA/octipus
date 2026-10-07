/**
 * The install's federation identity (docs/plans/federation-spec.md §4.1,
 * §11 item 1): created once, read strictly, and out of the admin vault
 * routes' reach.
 *
 * Backed by ephemeral PGlite and the real vault.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { App } from '@/api/http';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const fixture = vi.hoisted(() => ({
  user: null as { id: string; username: string; isAdmin: boolean } | null,
}));
vi.mock('@/api/context', async () => {
  const { App } = await import('@/api/http');
  const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');
  return {
    apiContext: new App().derive(() => ({
      user: fixture.user,
      session: null,
      principal: fixture.user ? principalFromUser(fixture.user) : ANONYMOUS_PRINCIPAL,
    })),
  };
});

const ADMIN = { id: '7f000001-0000-4000-8000-000000000001', username: 'root', isAdmin: true };
const NAME = 'federation.identity';

// biome-ignore lint/suspicious/noExplicitAny: raw rows
async function q(sql: string, params: unknown[] = []): Promise<any[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

async function identityRows(): Promise<{ id: string }[]> {
  return q(`SELECT id FROM vault WHERE name = $1 AND scope = 'system' AND is_active`, [NAME]);
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-fed-identity-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault, _resetVaultForTests } = await import('@/security/vault');
  _resetVaultForTests();
  await initializeVault();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: ADMIN.id, username: ADMIN.username, isAdmin: true }]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { _resetInstanceIdentityForTests } = await import('./identity');
  _resetInstanceIdentityForTests();
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('instance identity', () => {
  test('concurrent first calls store one key and agree on it', async () => {
    const { loadInstanceIdentity } = await import('./identity');
    expect(await identityRows()).toHaveLength(0);
    const ids = await Promise.all(Array.from({ length: 6 }, () => loadInstanceIdentity()));
    expect(new Set(ids.map((i) => i.instanceId)).size).toBe(1);
    expect(await identityRows()).toHaveLength(1);

    // And the memoised accessor reads the same key.
    const { getInstanceIdentity } = await import('./identity');
    expect((await getInstanceIdentity()).instanceId).toBe(ids[0].instanceId);
  });

  test('the id is base32(sha256(spki))[:26] and signs verifiably', async () => {
    const { getInstanceIdentity, instanceIdOf, isInstanceId, shortInstanceLabel, verifyEd25519 } = await import('./identity');
    const id = await getInstanceIdentity();
    expect(isInstanceId(id.instanceId)).toBe(true);
    expect(id.instanceId).toBe(instanceIdOf(id.publicKeySpkiB64));
    expect(id.display.replaceAll('-', '')).toBe(id.instanceId);
    expect(id.display.split('-')).toHaveLength(4);
    expect(shortInstanceLabel(id.instanceId)).toBe(id.instanceId.slice(0, 8));
    const msg = Buffer.from('hello');
    expect(verifyEd25519(id.publicKeySpkiB64, msg, id.sign(msg))).toBe(true);
    expect(verifyEd25519(id.publicKeySpkiB64, Buffer.from('hellO'), id.sign(msg))).toBe(false);
  });

  test('a vault error throws instead of minting a new key, and stays off for this start', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    const before = await identityRows();
    const read = vi.spyOn(vault, 'getReservedSystemSecret').mockRejectedValue(new Error('connection terminated'));
    const create = vi.spyOn(vault, 'createSystemSecretOnce');
    const { getInstanceIdentity } = await import('./identity');
    await expect(getInstanceIdentity()).rejects.toThrow('connection terminated');
    read.mockRestore();
    // The failure is kept: the vault is back, but this start does not retry.
    await expect(getInstanceIdentity()).rejects.toThrow('connection terminated');
    expect(create).not.toHaveBeenCalled();
    expect(await identityRows()).toEqual(before);
  });

  test('the lenient read reports a vault error as absent; the reserved one throws', async () => {
    const { getVault } = await import('@/security/vault');
    const vault = getVault();
    // biome-ignore lint/suspicious/noExplicitAny: the private reader both go through
    vi.spyOn(vault as any, 'readByName').mockRejectedValue(new Error('db down'));
    expect(await vault.getSystemSecret('some_api_key')).toBeNull();
    await expect(vault.getReservedSystemSecret(NAME)).rejects.toThrow('db down');
    await expect(vault.getReservedSystemSecret('some_api_key')).rejects.toThrow(/not a reserved/);
  });
});

describe('verifyEd25519', () => {
  test('accepts SPKI DER and raw 32-byte keys, as bytes or base64', async () => {
    const { verifyEd25519 } = await import('./identity');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const raw = spki.subarray(-32);
    const msg = Buffer.from('payload');
    const sig = sign(null, msg, privateKey);
    for (const key of [spki, raw, spki.toString('base64'), raw.toString('base64')]) {
      expect(verifyEd25519(key, msg, sig)).toBe(true);
    }
    expect(verifyEd25519(raw, msg, Buffer.alloc(64))).toBe(false);
    expect(verifyEd25519(raw, msg, sig.subarray(0, 63))).toBe(false);
  });

  test('throws for a key that is not Ed25519', async () => {
    const { verifyEd25519 } = await import('./identity');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' });
    expect(() => verifyEd25519(rsa, Buffer.from('x'), Buffer.alloc(64))).toThrow();
    expect(() => verifyEd25519(Buffer.alloc(31), Buffer.from('x'), Buffer.alloc(64))).toThrow();
  });
});

describe('the admin vault routes refuse the reserved name', () => {
  async function call(method: string, path: string, body?: unknown) {
    const { vaultRoutes } = await import('@/api/routes/vault');
    const app = new App().group('/api', (route) => route.use(vaultRoutes));
    return app.handle(new Request(`http://test/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }

  test('list, write, update, rotate and delete', async () => {
    fixture.user = ADMIN;
    const { getInstanceIdentity } = await import('./identity');
    const before = await getInstanceIdentity();
    const [{ id }] = await identityRows();

    const list = await (await call('GET', '/vault')).json() as { credentials: { name: string }[] };
    expect(list.credentials.some((c) => c.name === NAME)).toBe(false);

    for (const systemLevel of [true, false]) {
      const res = await call('POST', '/vault', { name: NAME, value: 'x', credentialType: 'certificate', systemLevel });
      expect(res.status).toBe(403);
    }
    expect((await call('PATCH', `/vault/${id}`, { value: 'x' })).status).toBe(403);
    expect((await call('POST', `/vault/${id}/rotate`, { value: 'x' })).status).toBe(403);
    expect((await call('DELETE', `/vault/${id}`)).status).toBe(403);

    // Untouched: the same key, one row.
    expect(await identityRows()).toEqual([{ id }]);
    const { _resetInstanceIdentityForTests } = await import('./identity');
    _resetInstanceIdentityForTests();
    expect((await getInstanceIdentity()).instanceId).toBe(before.instanceId);

    // An ordinary system secret still goes through.
    const ok = await call('POST', '/vault', { name: 'some_api_key', value: 'v', credentialType: 'api_key', systemLevel: true });
    expect(ok.status).toBe(200);
  });
});

describe('a corrupt stored key', () => {
  test('fails the start instead of being replaced', async () => {
    const [{ id }] = await identityRows();
    await q(`UPDATE vault SET encrypted_value = $1 WHERE id = $2`, [randomBytes(48).toString('base64'), id]);
    const { getInstanceIdentity } = await import('./identity');
    await expect(getInstanceIdentity()).rejects.toThrow();
    expect(await identityRows()).toEqual([{ id }]);
  });
});
