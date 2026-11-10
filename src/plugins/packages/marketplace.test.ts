/**
 * The marketplace's pure parts (docs/PLUGIN-PACKAGES.md#marketplace), no
 * database: placeholder root keys fail closed, `plugins.marketplace: false`
 * turns it off, index v2 is parsed strictly (malformed, oversized and
 * deceptive input refused or dropped), the root-key revocation rule, the
 * keys file checks, compatibility, the permissions words, diff and
 * declarations, and the image sniffer.
 *
 * Keys are generated here, in the test, and never written anywhere.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { declarationItems, permissionsGuidance } from '@/shared/plugin-declarations';
import { diffPermissions, foldForSearch, permissionsAskSummary } from '@/shared/plugin-permissions';
import type { PluginPermissionsSummary } from '@/shared/plugin-package';
import { IndexFormatError, parseIndexDocument } from './index-v2';
import { sniffImage } from './marketplace-assets';
import { keysFileUrl, MARKETPLACE_UNCONFIGURED_MESSAGE, marketplaceSettings } from './marketplace-config';
import { MARKETPLACE_ROOT_KEYS } from './marketplace-keys';
import { KeysFileError, parseKeysFile, rootRevocationProblem, signingPublishers } from './marketplace-keys-file';
import { compatibility } from './marketplace';
import { generateSigningKey, keyFingerprint, parsePublicKey, serializeSignature, signMarketplaceKeys, signRegistryIndex, verifyMarketplaceKeys, verifyRegistryIndex } from './signature';

const REG = { name: 'marketplace', url: 'https://mp.example.com/index.json' };
const SHA = 'ab'.repeat(32);
const HASH = `sha256:${'cd'.repeat(32)}`;

function perms(over: Partial<PluginPermissionsSummary> = {}): PluginPermissionsSummary {
  return {
    name: 'weekly', version: '1.0.0', apiVersion: '1.0.0', runtime: 'package', host: ['tasks:read'], network: [],
    tools: [{ name: 'review', effect: 'read' }], effects: { read: 1, write: 0, external: 0 },
    contributions: { commands: [], schedules: [], events: [], prompt: false, context: false }, pages: 0, trustedInput: false, maxProtection: 4,
    ...over,
  };
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'weekly', version: '1.0.0', description: 'A weekly review', url: 'https://mp.example.com/dl/weekly-1.0.0.tar.gz', sha256: SHA,
    contentHash: HASH, apiVersion: '1.0.0', minOctipus: null, title: 'Weekly review', summary: 'Looks back on the week',
    category: 'productivity', tags: ['tasks'], icon: 'https://mp.example.com/weekly/icon.png', screenshots: ['https://mp.example.com/weekly/s1.png'],
    homepage: 'https://example.org/weekly', author: { name: 'Ada', url: 'https://example.org' }, readme: '# Weekly\n\nHello', changelog: '## 1.0.0\n',
    publisher: 'Octipus', license: 'MIT', publishedAt: '2026-11-01T00:00:00Z', keyId: `ed25519:${'0'.repeat(64)}`,
    permissions: perms(), deprecated: null,
    ...over,
  };
}

const index = (packages: unknown[], over: Record<string, unknown> = {}) => ({ schema: 2, generatedAt: '2026-11-10T12:00:00Z', publisher: 'Octipus', packages, revoked: [], ...over });

describe('placeholder root keys fail closed', () => {
  test('the built-in root keys are placeholders, and the marketplace is not configured', () => {
    expect(MARKETPLACE_ROOT_KEYS.root).toMatchObject({ placeholder: true, publicKey: null });
    expect(MARKETPLACE_ROOT_KEYS.rootBackup).toMatchObject({ placeholder: true, publicKey: null });
    expect(marketplaceSettings(true)).toMatchObject({ state: 'unconfigured', reason: expect.stringMatching(/placeholder/) });
    expect(marketplaceSettings(undefined)).toMatchObject({ state: 'unconfigured' });
    expect(marketplaceSettings({ url: 'https://mp.example.com/index.json' })).toMatchObject({ state: 'unconfigured' });
    expect(MARKETPLACE_UNCONFIGURED_MESSAGE).toBe('The Octipus marketplace is not configured in this build');
  });

  test('a placeholder never becomes a key, even with a key pasted in but still marked placeholder', () => {
    const real = generateSigningKey();
    const tampered = { root: { placeholder: true, publicKey: real.publicKeyPem, note: '' }, rootBackup: { placeholder: true, publicKey: real.publicKeyPem, note: '' } };
    expect(marketplaceSettings(true, tampered as never)).toMatchObject({ state: 'unconfigured' });
    // One real root and one placeholder: still not configured.
    expect(marketplaceSettings(true, { root: { placeholder: false, publicKey: real.publicKeyPem }, rootBackup: MARKETPLACE_ROOT_KEYS.rootBackup })).toMatchObject({ state: 'unconfigured' });
  });

  test('with placeholder roots, nothing verifies: no keys file, no index', () => {
    const attacker = generateSigningKey();
    const bytes = Buffer.from('{"schema":1}');
    const sig = serializeSignature(signMarketplaceKeys(bytes, attacker.privateKeyPem));
    const settings = marketplaceSettings(true);
    expect(settings.state).toBe('unconfigured');
    const roots = settings.state === 'ready' ? settings.roots.map((r) => ({ name: 'root', publicKey: r.publicKey })) : [];
    expect(roots).toEqual([]);
    expect(verifyMarketplaceKeys(bytes, sig, roots).status).toBe('unknown_key');
    const indexSig = serializeSignature(signRegistryIndex(bytes, attacker.privateKeyPem));
    expect(verifyRegistryIndex(bytes, indexSig, 'Octipus', roots).status).toBe('unknown_key');
  });
});

describe('plugins.marketplace', () => {
  test('false or enabled: false turns it off entirely', () => {
    expect(marketplaceSettings(false)).toEqual({ state: 'off' });
    const root = generateSigningKey().publicKeyPem;
    expect(marketplaceSettings({ enabled: false, rootKeys: { root } })).toEqual({ state: 'off' });
  });

  test('root keys in the config count as configured; keys.json is on the index origin', () => {
    const root = generateSigningKey();
    const backup = generateSigningKey();
    const s = marketplaceSettings({ url: 'https://mp.example.com/sub/index.json', rootKeys: { root: root.publicKeyPem, rootBackup: backup.publicKeyPem } });
    expect(s).toMatchObject({ state: 'ready', keySource: 'config', keysUrl: 'https://mp.example.com/keys.json' });
    expect(s.state === 'ready' && s.roots.map((r) => [r.role, r.keyId])).toEqual([['root', root.keyId], ['rootBackup', backup.keyId]]);
    expect(keysFileUrl('https://plugins.octipus.cc/index.json')).toBe('https://plugins.octipus.cc/keys.json');
  });

  test('the same key twice is not configured', () => {
    const root = generateSigningKey().publicKeyPem;
    expect(marketplaceSettings({ rootKeys: { root, rootBackup: root } })).toMatchObject({ state: 'unconfigured' });
  });
});

describe('index v2 parsing', () => {
  test('a well-formed v2 index is read with its listing fields', () => {
    const parsed = parseIndexDocument(index([entry()], { revoked: [{ name: 'old', version: '0.1.0', reason: 'bug' }, { keyId: `ed25519:${'1'.repeat(64)}`, reason: 'leak' }] }), REG, { tarballSameOrigin: true });
    expect(parsed.schema).toBe(2);
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries[0]).toMatchObject({ name: 'weekly', sha256: `sha256:${SHA}`, icon: 'https://mp.example.com/weekly/icon.png', readme: '# Weekly\n\nHello', permissions: perms() });
    expect(parsed.entries[0]).not.toHaveProperty('keyId');
    expect(parsed.revoked).toEqual({ packages: [{ name: 'old', version: '0.1.0', reason: 'bug' }], keys: [{ keyId: `ed25519:${'1'.repeat(64)}`, reason: 'leak' }] });
  });

  test('an unknown schema greater than 2 is refused; v1 keeps working', () => {
    expect(() => parseIndexDocument(index([entry()], { schema: 3 }), REG)).toThrow(/schema 3/);
    expect(() => parseIndexDocument(index([entry()], { schema: 2.5 }), REG)).toThrow(IndexFormatError);
    expect(() => parseIndexDocument([entry()], REG)).toThrow(IndexFormatError);
    const v1 = parseIndexDocument({ packages: [{ name: 'finapi', version: '1.0.0', url: 'https://cdn.example.com/x.tar.gz', sha256: SHA }] }, REG);
    expect(v1.schema).toBe(1);
    expect(v1.entries[0]).toMatchObject({ name: 'finapi', permissions: null, contentHash: null });
  });

  test('a malformed header or revocation list refuses the whole index', () => {
    expect(() => parseIndexDocument(index([entry()], { generatedAt: 'yesterday' }), REG)).toThrow(IndexFormatError);
    expect(() => parseIndexDocument(index([entry()], { revoked: [{ name: 'x' }] }), REG)).toThrow(IndexFormatError);
    expect(() => parseIndexDocument(index([entry()], { revoked: [{ keyId: 'nope' }] }), REG)).toThrow(IndexFormatError);
    expect(() => parseIndexDocument(index([entry()], { revoked: { packages: [], keys: [] } }), REG)).toThrow(IndexFormatError);
    expect(() => parseIndexDocument(index(Array.from({ length: 5001 }, () => ({}))), REG)).toThrow(IndexFormatError);
  });

  test('an entry that is malformed, oversized or deceptive is skipped, the rest kept', () => {
    const bad = [
      entry({ name: 'a1', title: 'x'.repeat(101), permissions: perms({ name: 'a1' }) }),
      entry({ name: 'a2', readme: 'x'.repeat(200_001), permissions: perms({ name: 'a2' }) }),
      entry({ name: 'a3', title: 'Safe‮exe.txt', permissions: perms({ name: 'a3' }) }),
      entry({ name: 'a4', summary: 'line\nbreak', permissions: perms({ name: 'a4' }) }),
      entry({ name: 'a5', readme: 'bell\u0007', permissions: perms({ name: 'a5' }) }),
      entry({ name: 'a6', tags: Array.from({ length: 9 }, (_, i) => `t${i}`), permissions: perms({ name: 'a6' }) }),
      entry({ name: 'a7', permissions: { ...perms({ name: 'a7' }), extra: 1 } }),
      entry({ name: 'a8', permissions: perms({ name: 'other' }) }),
      entry({ name: 'a9', contentHash: 'sha256:short', permissions: perms({ name: 'a9' }) }),
      entry({ name: 'b1', url: 'http://mp.example.com/x.tar.gz', permissions: perms({ name: 'b1' }) }),
      entry({ name: 'b2', url: 'https://evil.example.com/x.tar.gz', permissions: perms({ name: 'b2' }) }),
      entry({ name: 'b3', permissions: perms({ name: 'b3', host: ['tasks:read', 'notes:read'] }) }),
      entry({ name: 'b4', permissions: undefined }),
      entry({ name: 'ok', permissions: perms({ name: 'ok' }) }),
    ];
    const parsed = parseIndexDocument(index(bad), REG, { tarballSameOrigin: true });
    expect(parsed.entries.map((e) => e.name)).toEqual(['ok']);
    expect(parsed.problems).toHaveLength(bad.length - 1);
  });

  test('off-origin or off-path images and non-https links are dropped, never followed', () => {
    const parsed = parseIndexDocument(index([entry({
      icon: 'https://evil.example.com/weekly/icon.png',
      screenshots: ['https://mp.example.com/other/s.png', 'https://mp.example.com/weekly/ok.png', 'http://mp.example.com/weekly/s.png',
        'https://u:p@mp.example.com/weekly/s.png', 'https://mp.example.com/weekly/s.png#x', 'https://mp.example.com/weekly/s.png?a=1'],
      homepage: 'http://example.org', author: { name: 'Ada', url: 'javascript:alert(1)' },
    })]), REG);
    expect(parsed.entries[0]).toMatchObject({ icon: null, screenshots: ['https://mp.example.com/weekly/ok.png'], homepage: null, author: { name: 'Ada', url: null } });
  });

  test('a name and version listed twice are both skipped', () => {
    const parsed = parseIndexDocument(index([entry(), entry({ sha256: 'ef'.repeat(32) })]), REG);
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems.join(' ')).toMatch(/more than once/);
  });
});

describe('root keys and keys.json', () => {
  const root = generateSigningKey();
  const backup = generateSigningKey();
  const roots = [
    { role: 'root' as const, publicKey: root.publicKeyPem, keyId: root.keyId },
    { role: 'rootBackup' as const, publicKey: backup.publicKeyPem, keyId: backup.keyId },
  ];
  const signer = generateSigningKey();

  test('the backup root may revoke the root; the root may never revoke the backup; a key may retire itself', () => {
    expect(rootRevocationProblem(backup.keyId, roots, [root.keyId])).toBeNull();
    expect(rootRevocationProblem(root.keyId, roots, [backup.keyId])).toMatch(/may not revoke the rootBackup/);
    expect(rootRevocationProblem(root.keyId, roots, [root.keyId, signer.keyId])).toBeNull();
    expect(rootRevocationProblem(signer.keyId, roots, [])).toMatch(/not a root key/);
  });

  test('keys.json: the key id must be the key\'s, a root is never a signing key, no key twice', () => {
    const file = (signingKeys: unknown[], over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ schema: 1, version: 1, generatedAt: '2026-11-10T00:00:00Z', signingKeys, revokedKeys: [], ...over }));
    expect(parseKeysFile(file([{ keyId: signer.keyId, publicKey: signer.publicKeyPem }]), roots).signingKeys).toHaveLength(1);
    expect(() => parseKeysFile(file([{ keyId: root.keyId, publicKey: signer.publicKeyPem }]), roots)).toThrow(KeysFileError);
    expect(() => parseKeysFile(file([{ keyId: root.keyId, publicKey: root.publicKeyPem }]), roots)).toThrow(/root key/);
    expect(() => parseKeysFile(file([{ keyId: signer.keyId, publicKey: signer.publicKeyPem }, { keyId: signer.keyId, publicKey: signer.publicKeyPem }]), roots)).toThrow(/twice/);
    expect(() => parseKeysFile(file([], { version: 0 }), roots)).toThrow(KeysFileError);
    expect(() => parseKeysFile(file([], { extra: true }), roots)).toThrow(KeysFileError);
    expect(() => parseKeysFile(Buffer.from('not json'), roots)).toThrow(KeysFileError);
  });

  test('a revoked signing key is not trusted, even when still listed', () => {
    const other = generateSigningKey();
    const file = parseKeysFile(Buffer.from(JSON.stringify({
      schema: 1, version: 2, generatedAt: '2026-11-10T00:00:00Z',
      signingKeys: [{ keyId: signer.keyId, publicKey: signer.publicKeyPem }, { keyId: other.keyId, publicKey: other.publicKeyPem, notAfter: '2030-01-01' }],
      revokedKeys: [{ keyId: signer.keyId, reason: 'leaked' }],
    })), roots);
    expect(signingPublishers(file, []).map((p) => keyFingerprint(parsePublicKey(p.publicKey)))).toEqual([other.keyId]);
    expect(signingPublishers(file, [other.keyId])).toEqual([]);
    expect(signingPublishers(file, [])[0]).toMatchObject({ name: 'Octipus', notAfter: '2030-01-01' });
  });

  test('a keys file signature never passes as an index or package signature, nor back', () => {
    const bytes = Buffer.from('{"schema":1}');
    const pub = [{ name: 'Octipus', publicKey: root.publicKeyPem }];
    const asIndex = serializeSignature(signRegistryIndex(bytes, root.privateKeyPem));
    const asKeys = serializeSignature(signMarketplaceKeys(bytes, root.privateKeyPem));
    expect(verifyMarketplaceKeys(bytes, asKeys, pub).status).toBe('valid');
    expect(verifyMarketplaceKeys(bytes, asIndex, pub).status).toBe('invalid');
    expect(verifyRegistryIndex(bytes, asKeys, 'Octipus', pub).status).toBe('invalid');
    expect(verifyMarketplaceKeys(Buffer.from('{"schema":2}'), asKeys, pub).status).toBe('invalid');
  });
});

describe('compatibility', () => {
  const base = { apiVersion: '1.0.0', minOctipus: null, permissions: perms(), registry: 'marketplace' };
  test('minOctipus and apiVersion gate a listed version', () => {
    expect(compatibility(base, '0.6.0')).toEqual({ ok: true, reason: null });
    expect(compatibility({ ...base, minOctipus: '0.7.0' }, '0.6.0')).toEqual({ ok: false, reason: 'Needs Octipus 0.7.0 or newer (this is 0.6.0)' });
    expect(compatibility({ ...base, minOctipus: '0.6.0' }, '0.6.0').ok).toBe(true);
    expect(compatibility({ ...base, apiVersion: '2.0.0' }, '0.6.0')).toMatchObject({ ok: false, reason: expect.stringMatching(/not supported/) });
    expect(compatibility({ ...base, apiVersion: '1.9.0' }, '0.6.0')).toMatchObject({ ok: false, reason: expect.stringMatching(/newer than this host/) });
  });

  test('the marketplace carries sandboxed packages only (the sandbox boundary)', () => {
    expect(compatibility({ ...base, permissions: perms({ runtime: 'in-process' }) }, '0.6.0').ok).toBe(false);
    expect(compatibility({ ...base, registry: 'acme', permissions: perms({ runtime: 'in-process' }) }, '0.6.0').ok).toBe(true);
  });
});

describe('permissions in words, the update diff and declarations', () => {
  test('the ask summary says what it reads, writes and reaches', () => {
    expect(permissionsAskSummary(perms({ host: ['notes:write', 'tasks:read'] }))).toEqual(expect.arrayContaining(['Writes notes', 'Reads your tasks', 'No network access', 'Tools: 1 read tool']));
    expect(permissionsAskSummary(perms({ network: ['api.example.com'] }))).toContain('Connects to api.example.com');
  });

  test('the diff names what widens and what narrows', () => {
    const before = perms();
    const after = perms({ host: ['notes:write', 'tasks:read'], network: ['api.example.com'], tools: [{ name: 'review', effect: 'write' }], maxProtection: 4, pages: 1 });
    const diff = diffPermissions(before, after);
    expect(diff.widened).toBe(true);
    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'host', change: 'added', text: 'host API scope notes:write', widens: true }),
      expect.objectContaining({ kind: 'network', change: 'added', widens: true }),
      expect.objectContaining({ kind: 'tool', change: 'wider', text: 'tool review: read → write' }),
      expect.objectContaining({ kind: 'pages', change: 'added' }),
    ]));
    expect(diffPermissions(after, before).widened).toBe(false);
    expect(diffPermissions(before, before)).toEqual({ widened: false, changes: [] });
  });

  test('declarations are stable, ordered, and carry guidance instead of refusals', () => {
    const p = perms({ host: ['model:complete', 'notes:read'], network: ['api.example.com'], contributions: { commands: ['go'], schedules: [], events: [], prompt: true, context: false }, trustedInput: true });
    const items = declarationItems(p, { tools: { review: { effect: 'read', description: 'Reviews' } }, secrets: [{ key: 'TOKEN', label: 'Token', required: true }] });
    expect(items.map((i) => i.id)).toEqual(['runtime', 'network:api.example.com', 'host:model:complete', 'host:notes:read', 'tool:review', 'command:go', 'prompt', 'secret:TOKEN', 'model:cli-tools', 'protection']);
    expect(items.find((i) => i.id === 'host:notes:read')?.guidance).toMatch(/send what it reads anywhere/);
    expect(declarationItems(p, null).map((i) => i.id)).toEqual(declarationItems(p, null).map((i) => i.id));
    expect(permissionsGuidance(p).map((g) => g.code)).toEqual(['egress_with_read', 'model_cli_tools']);
  });

  test('search folds case and diacritics', () => {
    expect(foldForSearch('Café Révisión')).toBe('cafe revision');
  });
});

describe('the image sniffer', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  test('PNG, JPEG, GIF and WebP by their bytes; SVG, HTML and a renamed file are not images', () => {
    expect(sniffImage(png)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from('<!doctype html><html>'))).toBeNull();
    expect(sniffImage(Buffer.from('\u0089PNG'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

test('the test keys are made here and differ every run', () => {
  const a = generateSigningKey();
  const b = generateSigningKey();
  expect(a.keyId).not.toBe(b.keyId);
  expect(createHash('sha256').update(a.privateKeyPem).digest('hex')).not.toBe(createHash('sha256').update(b.privateKeyPem).digest('hex'));
});
