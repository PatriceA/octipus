/**
 * The per-user store (docs/PLUGIN-PACKAGES.md#store), without a database:
 * the manifest's `store` and its scopes, the quota bounds, the permissions
 * summary and its diff, the words and the declaration item, the index v2
 * schema, the key and value rules, the effect narrowing and the aggregated audit.
 */
import { describe, expect, test } from 'vitest';
import { declarationItems, egressReadWarning } from '@/shared/plugin-declarations';
import {
  formatStoreBytes,
  modelCliToolsSourcesWarning,
  PLUGIN_HOST_WRITE_SCOPES,
  PLUGIN_STORE_DEFAULT_QUOTA_BYTES,
  PLUGIN_STORE_MAX_QUOTA_BYTES,
  pluginStoreQuota,
} from '@/shared/plugin-package';
import { diffPermissions, permissionsAskSummary } from '@/shared/plugin-permissions';
import { grantableScopes } from './host-api';
import { indexPermissionsSchema } from './index-v2';
import { ManifestError, parseManifest } from './manifest';
import { computePermissions } from './permissions';
import { encodeStoreValue, storeKeyFromPath, storeKeyProblem, storePrefixProblem } from './store';
import { storeAuditAggregator } from './store-audit';

const base = {
  name: 'notebook', version: '1.0.0', apiVersion: '1.0.0', title: 'Notebook', description: 'Keeps notes per user',
  server: { command: 'node', args: ['server.mjs'] },
  tools: { save: { effect: 'write' }, load: { effect: 'read' } },
};

const problems = (m: unknown): string[] => {
  try {
    parseManifest(m);
    return [];
  } catch (err) {
    if (err instanceof ManifestError) return err.problems;
    throw err;
  }
};

describe('the manifest', () => {
  test('a store with its scopes parses; the quota defaults to 5 MB', () => {
    const m = parseManifest({ ...base, host: ['store:read', 'store:write'], store: {} });
    expect(pluginStoreQuota(m)).toBe(PLUGIN_STORE_DEFAULT_QUOTA_BYTES);
    expect(PLUGIN_STORE_DEFAULT_QUOTA_BYTES).toBe(5 * 1024 * 1024);
    expect(pluginStoreQuota(parseManifest({ ...base, host: ['store:read'], store: { quotaBytes: 1_000_000 } }))).toBe(1_000_000);
    expect(pluginStoreQuota(parseManifest(base))).toBeNull();
  });

  test('the quota is at most 20 MB per user, at least 1 KB, a whole number', () => {
    expect(PLUGIN_STORE_MAX_QUOTA_BYTES).toBe(20 * 1024 * 1024);
    expect(problems({ ...base, host: ['store:write'], store: { quotaBytes: PLUGIN_STORE_MAX_QUOTA_BYTES } })).toEqual([]);
    expect(problems({ ...base, host: ['store:write'], store: { quotaBytes: PLUGIN_STORE_MAX_QUOTA_BYTES + 1 } }).join()).toMatch(/at most .* per user/);
    expect(problems({ ...base, host: ['store:write'], store: { quotaBytes: 10 } }).join()).toMatch(/at least 1024/);
    expect(problems({ ...base, host: ['store:write'], store: { quotaBytes: 2048.5 } }).join()).toMatch(/whole number/);
    expect(problems({ ...base, host: ['store:write'], store: { quotaBytes: 2048, shared: true } }).length).toBeGreaterThan(0);
  });

  test('a store needs a store scope, and a store scope needs a store', () => {
    expect(problems({ ...base, store: {} }).join()).toMatch(/store: declare the host scope store:read and\/or store:write/);
    expect(problems({ ...base, host: ['notes:read'], store: {} }).join()).toMatch(/store: declare/);
    expect(problems({ ...base, host: ['store:read'] }).join()).toMatch(/need a "store" declaration/);
    expect(problems({ ...base, host: ['store:read', 'store:write'] }).join()).toMatch(/store:read and store:write need/);
  });
});

describe('permissions', () => {
  const withStore = (quotaBytes?: number) => computePermissions(parseManifest({
    ...base, host: ['store:read', 'store:write'], store: quotaBytes === undefined ? {} : { quotaBytes },
  }));
  const without = computePermissions(parseManifest(base));

  test('store sits right after settings, the quota defaulted; null without one', () => {
    const p = withStore();
    expect(p.store).toEqual({ quotaBytes: PLUGIN_STORE_DEFAULT_QUOTA_BYTES });
    const keys = Object.keys(p);
    expect(keys.indexOf('store')).toBe(keys.indexOf('settings') + 1);
    expect(without.store).toBeNull();
  });

  test('the index v2 schema takes it, bounds it, and reads an older listing as none', () => {
    const p = withStore(2 * 1024 * 1024);
    expect(indexPermissionsSchema.parse(p).store).toEqual({ quotaBytes: 2 * 1024 * 1024 });
    expect(indexPermissionsSchema.safeParse({ ...p, store: { quotaBytes: PLUGIN_STORE_MAX_QUOTA_BYTES + 1 } }).success).toBe(false);
    expect(indexPermissionsSchema.safeParse({ ...p, store: { quotaBytes: 4096, shared: true } }).success).toBe(false);
    const { store: _store, ...older } = without;
    expect(indexPermissionsSchema.parse(older).store).toBeNull();
  });

  test('a new store or a larger quota widens; a smaller one narrows; removing one does not widen', () => {
    const added = diffPermissions(without, withStore());
    expect(added.widened).toBe(true);
    expect(added.changes).toContainEqual({ kind: 'store', change: 'added', text: 'store (5 MB per user)', widens: true });
    const larger = diffPermissions(withStore(), withStore(10 * 1024 * 1024));
    expect(larger.changes).toContainEqual({ kind: 'store', change: 'wider', text: 'store quota 5 MB → 10 MB per user', widens: true });
    const smaller = diffPermissions(withStore(10 * 1024 * 1024), withStore());
    expect(smaller).toEqual({ widened: false, changes: [{ kind: 'store', change: 'narrower', text: 'store quota 10 MB → 5 MB per user', widens: false }] });
    const removed = diffPermissions(withStore(), without);
    expect(removed.changes.find((c) => c.kind === 'store')).toEqual({ kind: 'store', change: 'removed', text: 'store (5 MB per user)', widens: false });
    expect(diffPermissions(withStore(), withStore()).changes).toEqual([]);
    // A summary from before the store (no key at all) reads as none.
    const { store: _s, ...older } = without;
    expect(diffPermissions(older as typeof without, withStore()).changes.some((c) => c.kind === 'store' && c.widens)).toBe(true);
  });

  test('in words and as a declaration item, between settings and protection', () => {
    expect(permissionsAskSummary(withStore())).toContain('Keeps up to 5 MB of its own data per user');
    expect(permissionsAskSummary(withStore(20 * 1024 * 1024))).toContain('Keeps up to 20 MB of its own data per user');
    expect(permissionsAskSummary(without).join()).not.toMatch(/its own data/);
    const items = declarationItems(withStore());
    const store = items.find((i) => i.id === 'store');
    expect(store).toMatchObject({ kind: 'store', label: 'Keeps up to 5 MB of its own data per user', detail: 'store: up to 5242880 bytes per user (store:read, store:write)' });
    expect(store?.guidance).toMatch(/never another user/);
    const ids = items.map((i) => i.id);
    expect(ids.indexOf('store')).toBe(ids.indexOf('protection') - 1);
    expect(items.find((i) => i.id === 'host:store:read')?.label).toBe('Reads the data it keeps for you');
    expect(declarationItems(without).some((i) => i.id === 'store')).toBe(false);
  });

  test('store:read is not the user\'s data: no egress warning, no CLI-lane source', () => {
    expect(egressReadWarning(['web:read', 'store:read'])).toBeNull();
    expect(egressReadWarning(['web:read', 'store:read', 'notes:read'])).toMatch(/notes:read/);
    expect(modelCliToolsSourcesWarning({ host: ['model:complete', 'store:read', 'store:write'] })).toBeNull();
  });
});

describe('effects', () => {
  test('a read tool gets store:read only, never store:write', () => {
    expect(PLUGIN_HOST_WRITE_SCOPES).toContain('store:write');
    const declared = ['store:read', 'store:write'] as const;
    expect(grantableScopes([...declared], [...declared], 'read')).toEqual(['store:read']);
    expect(grantableScopes([...declared], [...declared], 'write')).toEqual(['store:read', 'store:write']);
    expect(grantableScopes([...declared], ['store:read'], 'external')).toEqual(['store:read']);
  });
});

describe('keys and values', () => {
  test('a key is 1-200 of A-Za-z0-9._:/- with no empty, "." or ".." segment', () => {
    for (const key of ['a', 'notes/2026-11/today.json', 'user:prefs', 'A.b_c-d', 'x'.repeat(200), 'a.b..c']) expect(storeKeyProblem(key), key).toBeNull();
    for (const key of ['', 'x'.repeat(201), 'with space', 'a%2Fb', 'é', '/lead', 'trail/', 'a//b', './a', 'a/../b', '..', 'a\\b', 'a?b', 'a#b', 12]) {
      expect(storeKeyProblem(key), String(key)).not.toBeNull();
    }
    expect(storePrefixProblem('')).toBeNull();
    expect(storePrefixProblem(undefined)).toBeNull();
    expect(storePrefixProblem('notes/')).toBeNull();
    expect(storePrefixProblem('no space')).not.toBeNull();
  });

  test('the key comes from the path, decoded once', () => {
    expect(storeKeyFromPath('http://h/api/plugin-host/store/notes/a.json', '/plugin-host/store/')).toBe('notes/a.json');
    expect(storeKeyFromPath('http://h/api/plugins/x/store/a%3Ab', '/x/store/')).toBe('a:b');
    expect(storeKeyFromPath('http://h/api/plugins/x/store/%E0%A4%A', '/x/store/')).toBe('');
  });

  test('a value is JSON of at most 64 KB, without NUL', () => {
    expect(encodeStoreValue({ a: [1, 'two', null] })).toEqual({ json: '{"a":[1,"two",null]}' });
    expect(encodeStoreValue(null)).toEqual({ json: 'null' });
    expect(encodeStoreValue('x'.repeat(64 * 1024 - 2))).toEqual({ json: `"${'x'.repeat(64 * 1024 - 2)}"` });
    expect(encodeStoreValue('x'.repeat(64 * 1024 - 1))).toMatchObject({ status: 413, code: 'too_large' });
    // Bytes, not characters: 3 bytes each in UTF-8.
    expect(encodeStoreValue('€'.repeat(22_000))).toMatchObject({ status: 413, code: 'too_large' });
    expect(encodeStoreValue(undefined)).toMatchObject({ status: 400, code: 'invalid_value' });
    expect(encodeStoreValue(() => 1)).toMatchObject({ status: 400, code: 'invalid_value' });
    expect(encodeStoreValue('a\u0000b')).toMatchObject({ status: 400, code: 'invalid_value' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(encodeStoreValue(cyclic)).toMatchObject({ status: 400, code: 'invalid_value' });
  });

  test('sizes read in words', () => {
    expect(formatStoreBytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatStoreBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(formatStoreBytes(512 * 1024)).toBe('512 KB');
    expect(formatStoreBytes(1)).toBe('1 byte');
    expect(formatStoreBytes(0)).toBe('0 bytes');
  });
});

describe('the aggregated audit', () => {
  test('one row per kind per window, carrying the requests counted since the last row', async () => {
    const audit = storeAuditAggregator(60_000);
    const rows: Array<{ kind: string; count: number }> = [];
    const write = (kind: string) => async (count: number) => { rows.push({ kind, count }); };
    await audit.count('put', write('put'), 0);
    for (let t = 1; t < 10; t++) await audit.count('put', write('put'), t * 1000);
    await audit.count('delete', write('delete'), 5000);
    expect(rows).toEqual([{ kind: 'put', count: 1 }, { kind: 'delete', count: 1 }]);
    await audit.count('put', write('put'), 61_000);
    expect(rows.at(-1)).toEqual({ kind: 'put', count: 10 });
  });
});
