/**
 * Signed plugin packages (docs/PLUGIN-PACKAGES.md#signed-packages): a
 * signature made with a key verifies against that key only, any change to
 * the files invalidates it, the signature file itself is not part of the
 * hash, and public keys are read as PEM, raw base64 or SPKI base64.
 */
import { createPublicKey } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// `rename` passes through unless a test makes it fail (`renameHook`).
let renameHook: ((from: string, to: string) => void) | undefined;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (from: string, to: string) => { renameHook?.(from, to); return actual.rename(from, to); } };
});
import { hashPackageContent, SIGNATURE_FILE } from './integrity';
import {
  checkPackageSignature,
  checkSignature,
  generateSigningKey,
  keyFingerprint,
  parsePublicKey,
  readSignatureFile,
  serializeSignature,
  signContentHash,
  signPackage,
  trustedKeys,
} from './signature';

const dirs: string[] = [];
const MANIFEST = {
  apiVersion: '1.0.0',
  name: 'demo',
  version: '1.0.0',
  title: 'Demo',
  description: 'A demo package',
  server: { command: 'node', args: ['server.mjs'] },
  tools: { echo: { effect: 'read' } },
};

function pkg(): string {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-signature-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(dir, 'server.mjs'), 'console.log(1)\n');
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'a.js'), 'a');
  return dir;
}

afterEach(() => {
  renameHook = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const publisher = generateSigningKey();
const other = generateSigningKey();
const TRUSTED = [{ name: 'Acme', publicKey: publisher.publicKeyPem }];

describe('signing and verifying', () => {
  test('a signed package verifies against its publisher', async () => {
    const dir = pkg();
    const before = await hashPackageContent(dir, MANIFEST);
    const { contentHash, keyId, file } = await signPackage(dir, publisher.privateKeyPem);
    expect(file).toBe(join(dir, SIGNATURE_FILE));
    expect(keyId).toBe(publisher.keyId);
    expect(keyId).toMatch(/^ed25519:[0-9a-f]{64}$/);
    // The signature file is not part of the hash it signs.
    expect(contentHash).toBe(before);
    expect(await hashPackageContent(dir, MANIFEST)).toBe(before);
    const sig = JSON.parse(readFileSync(file, 'utf8'));
    expect(sig).toMatchObject({ alg: 'ed25519', keyId: publisher.keyId });
    expect(await checkPackageSignature(dir, contentHash, TRUSTED)).toEqual({ status: 'valid', publisher: 'Acme', keyId: publisher.keyId });
    // Signing again gives a signature over the same hash.
    expect((await signPackage(dir, publisher.privateKeyPem)).contentHash).toBe(before);
  });

  test('a changed, added or removed file invalidates the signature', async () => {
    const dir = pkg();
    await signPackage(dir, publisher.privateKeyPem);
    appendFileSync(join(dir, 'server.mjs'), '// tampered\n');
    const tampered = await checkPackageSignature(dir, await hashPackageContent(dir, MANIFEST), TRUSTED);
    expect(tampered).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/does not match/) });

    const added = pkg();
    await signPackage(added, publisher.privateKeyPem);
    writeFileSync(join(added, 'lib', 'extra.js'), '');
    expect((await checkPackageSignature(added, await hashPackageContent(added, MANIFEST), TRUSTED)).status).toBe('invalid');

    // Another name or version is another hash.
    const renamed = pkg();
    const { contentHash } = await signPackage(renamed, publisher.privateKeyPem);
    expect((await checkPackageSignature(renamed, await hashPackageContent(renamed, { name: 'demo', version: '1.0.1' }), TRUSTED)).status).toBe('invalid');
    expect((await checkPackageSignature(renamed, contentHash, TRUSTED)).status).toBe('valid');
  });

  test('a tampered signature or one copied under a trusted key id is invalid', async () => {
    const dir = pkg();
    const { contentHash } = await signPackage(dir, publisher.privateKeyPem);
    const sig = JSON.parse(readFileSync(join(dir, SIGNATURE_FILE), 'utf8'));
    const bytes = Buffer.from(sig.signature, 'base64');
    bytes[0] ^= 1;
    const keys = trustedKeys(TRUSTED);
    expect(checkSignature(contentHash, serializeSignature({ ...sig, signature: bytes.toString('base64') }), keys).status).toBe('invalid');
    // Made with another key but naming the trusted one.
    const forged = signContentHash(contentHash, other.privateKeyPem);
    expect(checkSignature(contentHash, serializeSignature({ ...forged, keyId: publisher.keyId }), keys).status).toBe('invalid');
    // Malformed files.
    expect(checkSignature(contentHash, 'not json', keys).status).toBe('invalid');
    expect(checkSignature(contentHash, JSON.stringify({ ...sig, alg: 'rsa' }), keys).status).toBe('invalid');
    expect(checkSignature(contentHash, JSON.stringify({ ...sig, signature: 'AAAA' }), keys).status).toBe('invalid');
  });

  test('only the canonical form of the signature file is accepted', async () => {
    const dir = pkg();
    const { contentHash } = await signPackage(dir, publisher.privateKeyPem);
    const text = readFileSync(join(dir, SIGNATURE_FILE), 'utf8');
    const sig = JSON.parse(text);
    const keys = trustedKeys(TRUSTED);
    expect(text).toBe(serializeSignature(sig));
    expect(checkSignature(contentHash, text, keys).status).toBe('valid');
    const refused = [
      JSON.stringify(sig), // compact
      `${JSON.stringify({ keyId: sig.keyId, alg: sig.alg, signature: sig.signature }, null, 2)}\n`, // reordered
      serializeSignature(sig).replace('\n}', ',\n  "payload": "console.log(1)"\n}'), // an extra key
      `${JSON.stringify({ ...sig, payload: 'x' }, null, 2)}\n`,
      serializeSignature(sig).trimEnd(), // no trailing newline
      `${serializeSignature(sig)}${' '.repeat(2000)}`, // over 1 KiB
      serializeSignature({ ...sig, keyId: 'ed25519:XYZ' }),
      serializeSignature({ ...sig, signature: sig.signature.replace('==', '=A') }),
    ];
    for (const variant of refused) expect(checkSignature(contentHash, variant, keys).status).toBe('invalid');
    // On disk the same way, and its bytes are hashed for the row.
    expect((await readSignatureFile(dir))?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    writeFileSync(join(dir, SIGNATURE_FILE), refused[2]);
    await expect(readSignatureFile(dir)).rejects.toThrow(/exactly/);
    expect((await checkPackageSignature(dir, contentHash, TRUSTED)).status).toBe('invalid');
  });

  test('a signature file that is a link is refused; signing refuses links anywhere in the package', async () => {
    const dir = pkg();
    const outside = join(mkdtempSync(join(tmpdir(), 'octipus-sig-outside-')), 'target');
    dirs.push(join(outside, '..'));
    writeFileSync(outside, 'host file');
    symlinkSync(outside, join(dir, SIGNATURE_FILE));
    await expect(readSignatureFile(dir)).rejects.toThrow(/symbolic link/);
    await expect(signPackage(dir, publisher.privateKeyPem)).rejects.toThrow(/symbolic link/);
    expect(readFileSync(outside, 'utf8')).toBe('host file');

    const linked = pkg();
    symlinkSync(outside, join(linked, 'lib', 'evil.js'));
    await expect(signPackage(linked, publisher.privateKeyPem)).rejects.toThrow(/symbolic link/);
  });

  test('a signature by a key that is not trusted is an unknown key; none at all is unsigned', async () => {
    const dir = pkg();
    const { contentHash } = await signPackage(dir, other.privateKeyPem);
    expect(await checkPackageSignature(dir, contentHash, TRUSTED)).toEqual({ status: 'unknown_key', keyId: other.keyId });
    expect(await checkPackageSignature(dir, contentHash, [])).toEqual({ status: 'unknown_key', keyId: other.keyId });
    const unsigned = pkg();
    expect(await checkPackageSignature(unsigned, await hashPackageContent(unsigned, MANIFEST), TRUSTED)).toEqual({ status: 'unsigned' });
  });

  test('a directory in place of the signature file is refused, and still hashed', async () => {
    const dir = pkg();
    const before = await hashPackageContent(dir, MANIFEST);
    mkdirSync(join(dir, SIGNATURE_FILE));
    writeFileSync(join(dir, SIGNATURE_FILE, 'x'), 'x');
    const after = await hashPackageContent(dir, MANIFEST);
    expect(after).not.toBe(before);
    expect(await checkPackageSignature(dir, after, TRUSTED)).toMatchObject({ status: 'invalid', reason: expect.stringMatching(/not a regular file/) });
    // Only the root file is left out of the hash: one deeper counts.
    const nested = pkg();
    const base = await hashPackageContent(nested, MANIFEST);
    writeFileSync(join(nested, 'lib', SIGNATURE_FILE), '{}');
    expect(await hashPackageContent(nested, MANIFEST)).not.toBe(base);
  });
});

describe('the temporary signature file', () => {
  /** A package in a parent directory of its own, so both can be listed. */
  function nested(): { parent: string; dir: string } {
    const parent = mkdtempSync(join(tmpdir(), 'octipus-signature-parent-'));
    dirs.push(parent);
    const dir = join(parent, 'demo');
    mkdirSync(dir);
    writeFileSync(join(dir, 'octipus-plugin.json'), JSON.stringify(MANIFEST));
    writeFileSync(join(dir, 'server.mjs'), 'console.log(1)\n');
    return { parent, dir };
  }

  test('is written outside the package: between the write and the rename the package holds no extra file', async () => {
    const { parent, dir } = nested();
    const before = await hashPackageContent(dir, MANIFEST);
    let seen: { pkg: string[]; from: string } | undefined;
    renameHook = (from) => { seen = { pkg: readdirSync(dir).sort(), from }; };
    const { contentHash } = await signPackage(dir, publisher.privateKeyPem);
    expect(seen?.pkg).toEqual(['octipus-plugin.json', 'server.mjs']);
    expect(join(seen?.from as string, '..')).toBe(parent);
    expect(contentHash).toBe(before);
    expect(readdirSync(parent)).toEqual(['demo']);
    expect(readdirSync(dir).sort()).toEqual(['octipus-plugin.json', SIGNATURE_FILE, 'server.mjs']);
  });

  test('a failed rename leaves nothing in the package or its parent', async () => {
    const { parent, dir } = nested();
    const before = await hashPackageContent(dir, MANIFEST);
    renameHook = () => { throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' }); };
    await expect(signPackage(dir, publisher.privateKeyPem)).rejects.toThrow('simulated rename failure');
    expect(readdirSync(dir).sort()).toEqual(['octipus-plugin.json', 'server.mjs']);
    expect(readdirSync(parent)).toEqual(['demo']);
    expect(await hashPackageContent(dir, MANIFEST)).toBe(before);
  });

  test('a rename across filesystems is reported, and cleaned up', async () => {
    const { parent, dir } = nested();
    renameHook = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
    await expect(signPackage(dir, publisher.privateKeyPem)).rejects.toThrow(/another filesystem/);
    expect(readdirSync(parent)).toEqual(['demo']);
    expect(readdirSync(dir).sort()).toEqual(['octipus-plugin.json', 'server.mjs']);
  });
});

describe('public keys', () => {
  test('are read as PEM, raw base64 or SPKI base64, all with one fingerprint', () => {
    const der = createPublicKey(publisher.publicKeyPem).export({ format: 'der', type: 'spki' });
    const raw = der.subarray(12).toString('base64');
    for (const text of [publisher.publicKeyPem, `  ${publisher.publicKeyPem}\n`, raw, der.toString('base64')]) {
      expect(keyFingerprint(parsePublicKey(text))).toBe(publisher.keyId);
    }
  });

  test('a private key, a non-Ed25519 key or garbage is refused, and trusts nothing', () => {
    expect(() => parsePublicKey(publisher.privateKeyPem)).toThrow(/private key/);
    expect(() => parsePublicKey('hello world')).toThrow(/PEM or base64/);
    expect(() => parsePublicKey(Buffer.alloc(16).toString('base64'))).toThrow(/16 bytes/);
    const invalid: string[] = [];
    const keys = trustedKeys([{ name: 'Broken', publicKey: 'nope' }, ...TRUSTED], (name) => invalid.push(name));
    expect(invalid).toEqual(['Broken']);
    expect([...keys.values()].map((k) => k.name)).toEqual(['Acme']);
  });

  test('signing refuses a key that is not an Ed25519 private key', () => {
    expect(() => signContentHash('sha256:00', publisher.publicKeyPem)).toThrow(/private key/);
  });
});

describe('revoked and expired keys', () => {
  const HASH = `sha256:${'ab'.repeat(32)}`;
  const text = serializeSignature(signContentHash(HASH, publisher.privateKeyPem));

  test('a revoked entry trusts nothing: a valid signature by it reads as revoked', () => {
    const keys = trustedKeys([{ name: 'Acme', publicKey: publisher.publicKeyPem, revoked: true }]);
    expect(checkSignature(HASH, text, keys)).toEqual({ status: 'revoked', keyId: publisher.keyId, publisher: 'Acme', detail: expect.stringContaining('revoked') });
  });

  test('plugins.revokedKeys revokes a listed key, and one with no entry at all', () => {
    const listed = trustedKeys(TRUSTED, undefined, { revokedKeys: [publisher.keyId] });
    expect(checkSignature(HASH, text, listed)).toMatchObject({ status: 'revoked', publisher: 'Acme' });
    const unlisted = trustedKeys([], undefined, { revokedKeys: [publisher.keyId] });
    expect(checkSignature(HASH, text, unlisted)).toMatchObject({ status: 'revoked', publisher: null, keyId: publisher.keyId });
    // Another key is untouched.
    expect(checkSignature(HASH, text, trustedKeys(TRUSTED, undefined, { revokedKeys: [other.keyId] })).status).toBe('valid');
  });

  test('notAfter: trusted until then, expired after; a date alone is its start (UTC)', () => {
    const entry = [{ name: 'Acme', publicKey: publisher.publicKeyPem, notAfter: '2027-01-01' }];
    expect(checkSignature(HASH, text, trustedKeys(entry, undefined, { now: new Date('2026-12-31T23:59:59Z') })).status).toBe('valid');
    expect(checkSignature(HASH, text, trustedKeys(entry, undefined, { now: new Date('2027-01-01T00:00:01Z') })))
      .toMatchObject({ status: 'expired', publisher: 'Acme', detail: expect.stringContaining('2027-01-01T00:00:00.000Z') });
    const withTime = [{ name: 'Acme', publicKey: publisher.publicKeyPem, notAfter: '2027-01-01T12:00:00+02:00' }];
    expect(checkSignature(HASH, text, trustedKeys(withTime, undefined, { now: new Date('2027-01-01T10:30:00Z') })).status).toBe('expired');
  });

  test('an unreadable notAfter trusts nothing and is reported', () => {
    const reported: string[] = [];
    const keys = trustedKeys([{ name: 'Acme', publicKey: publisher.publicKeyPem, notAfter: 'next year' }], (_n, reason) => reported.push(reason));
    expect(checkSignature(HASH, text, keys).status).toBe('expired');
    expect(reported).toEqual([expect.stringContaining('not an ISO date')]);
  });

  test('a key listed twice: the revocation wins, whichever comes first', () => {
    for (const list of [
      [{ name: 'Acme', publicKey: publisher.publicKeyPem }, { name: 'Acme (old)', publicKey: publisher.publicKeyPem, revoked: true }],
      [{ name: 'Acme (old)', publicKey: publisher.publicKeyPem, revoked: true }, { name: 'Acme', publicKey: publisher.publicKeyPem }],
    ]) {
      expect(checkSignature(HASH, text, trustedKeys(list)).status).toBe('revoked');
    }
  });

  test('a signature that does not verify is invalid, even by a revoked key', () => {
    const keys = trustedKeys([{ name: 'Acme', publicKey: publisher.publicKeyPem, revoked: true }]);
    expect(checkSignature(`sha256:${'cd'.repeat(32)}`, text, keys).status).toBe('invalid');
  });

  test('rotation: the new key is trusted while the old one is revoked', async () => {
    const dir = pkg();
    await signPackage(dir, other.privateKeyPem);
    const contentHash = await hashPackageContent(dir, MANIFEST);
    const rotated = [{ name: 'Acme', publicKey: publisher.publicKeyPem, revoked: true }, { name: 'Acme 2027', publicKey: other.publicKeyPem }];
    expect(await checkPackageSignature(dir, contentHash, rotated)).toEqual({ status: 'valid', publisher: 'Acme 2027', keyId: other.keyId });
  });
});
