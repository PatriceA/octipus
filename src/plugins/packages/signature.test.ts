/**
 * Signed plugin packages (docs/PLUGIN-PACKAGES.md#signed-packages): a
 * signature made with a key verifies against that key only, any change to
 * the files invalidates it, the signature file itself is not part of the
 * hash, and public keys are read as PEM, raw base64 or SPKI base64.
 */
import { createPublicKey } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { hashPackageContent, SIGNATURE_FILE } from './integrity';
import {
  checkPackageSignature,
  checkSignature,
  generateSigningKey,
  keyFingerprint,
  parsePublicKey,
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
    expect(checkSignature(contentHash, JSON.stringify({ ...sig, signature: bytes.toString('base64') }), keys).status).toBe('invalid');
    // Made with another key but naming the trusted one.
    const forged = signContentHash(contentHash, other.privateKeyPem);
    expect(checkSignature(contentHash, JSON.stringify({ ...forged, keyId: publisher.keyId }), keys).status).toBe('invalid');
    // Malformed files.
    expect(checkSignature(contentHash, 'not json', keys).status).toBe('invalid');
    expect(checkSignature(contentHash, JSON.stringify({ ...sig, alg: 'rsa' }), keys).status).toBe('invalid');
    expect(checkSignature(contentHash, JSON.stringify({ ...sig, signature: 'AAAA' }), keys).status).toBe('invalid');
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
