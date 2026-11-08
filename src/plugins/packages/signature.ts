/**
 * Signed plugin packages (docs/PLUGIN-PACKAGES.md#signed-packages).
 *
 * A publisher signs the content hash of a package (./integrity.ts) with an
 * Ed25519 key and puts the signature in the package root as
 * `octipus-plugin.sig`:
 *
 *   { "alg": "ed25519", "keyId": "ed25519:<sha256 hex of the raw public key>",
 *     "signature": "<base64>" }
 *
 * The signed message is `octipus-plugin-signature/v1\n<content hash>`: the
 * hash string (`sha256:<hex>`, which already binds the package name, version
 * and every file), behind a prefix so a signature made for this cannot be
 * mistaken for one over anything else the same key signs. The signature file
 * is the one file the content hash leaves out.
 *
 * The host trusts the keys listed in `plugins.trustedPublishers`; a signature
 * by any other key proves nothing here. What a valid signature says: these
 * exact files are what the holder of that key signed. Not that they are safe.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PLUGIN_MANIFEST_FILE } from '@/shared/plugin-package';
import { hashPackageContent, SIGNATURE_FILE } from './integrity';
import { parseManifest } from './manifest';

export { SIGNATURE_FILE } from './integrity';

const MESSAGE_PREFIX = 'octipus-plugin-signature/v1\n';
/** A signature file larger than this is not one (it holds three short strings). */
const MAX_SIGNATURE_BYTES = 4096;
/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A `plugins.trustedPublishers` entry. */
export interface TrustedPublisher {
  name: string;
  /** PEM (SPKI), or base64 of the raw 32-byte key or of its DER SPKI. */
  publicKey: string;
}

/** The contents of `octipus-plugin.sig`. */
export interface SignatureFile {
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** What `checkPackageSignature` found. */
export type SignatureCheck =
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: string }
  | { status: 'unknown_key'; keyId: string }
  | { status: 'valid'; publisher: string; keyId: string };

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

/** The bytes a signature is made over, for a content hash. */
function message(contentHash: string): Buffer {
  return Buffer.from(`${MESSAGE_PREFIX}${contentHash}`, 'utf8');
}

function requireEd25519(key: KeyObject, what: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') throw new SignatureError(`${what} is a ${key.asymmetricKeyType ?? 'non-asymmetric'} key, not Ed25519`);
  return key;
}

/** Read a public key given as PEM, or as base64 of the raw 32 bytes or of the DER SPKI. */
export function parsePublicKey(text: string): KeyObject {
  const trimmed = text.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    if (trimmed.includes('PRIVATE KEY')) throw new SignatureError('This is a private key; give the public key');
    let key: KeyObject;
    try {
      key = createPublicKey(trimmed);
    } catch (err) {
      throw new SignatureError(`Not a readable public key: ${(err as Error).message}`);
    }
    return requireEd25519(key, 'The public key');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new SignatureError('Not a PEM or base64 public key');
  const bytes = Buffer.from(trimmed, 'base64');
  let der: Buffer;
  if (bytes.length === 32) der = Buffer.concat([ED25519_SPKI_PREFIX, bytes]);
  else if (bytes.length === ED25519_SPKI_PREFIX.length + 32 && bytes.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) der = bytes;
  else throw new SignatureError(`A base64 public key is the raw 32-byte Ed25519 key or its 44-byte SPKI; this one has ${bytes.length} bytes`);
  return requireEd25519(createPublicKey({ key: der, format: 'der', type: 'spki' }), 'The public key');
}

/** The fingerprint a signature names its key by: `ed25519:<sha256 hex of the raw public key>`. */
export function keyFingerprint(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return `ed25519:${createHash('sha256').update(der.subarray(ED25519_SPKI_PREFIX.length)).digest('hex')}`;
}

/** Sign a content hash with a private key (PEM, PKCS#8): the signature file's contents. */
export function signContentHash(contentHash: string, privateKeyPem: string): SignatureFile {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new SignatureError(`Not a readable private key: ${(err as Error).message}`);
  }
  requireEd25519(key, 'The private key');
  return {
    alg: 'ed25519',
    keyId: keyFingerprint(createPublicKey(key)),
    signature: sign(null, message(contentHash), key).toString('base64'),
  };
}

/** A new Ed25519 key pair, PEM-encoded (private: PKCS#8, public: SPKI), with its key id. */
export function generateSigningKey(): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    keyId: keyFingerprint(publicKey),
  };
}

/**
 * Sign a package directory in place: hash it (the signature file left out)
 * and write `octipus-plugin.sig`. Signing again replaces the signature.
 */
export async function signPackage(dir: string, privateKeyPem: string): Promise<{ contentHash: string; keyId: string; file: string }> {
  const manifest = parseManifest(JSON.parse(await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')));
  const contentHash = await hashPackageContent(dir, manifest);
  const sig = signContentHash(contentHash, privateKeyPem);
  const file = join(dir, SIGNATURE_FILE);
  await writeFile(file, `${JSON.stringify(sig, null, 2)}\n`);
  return { contentHash, keyId: sig.keyId, file };
}

/**
 * The trusted keys by key id. An entry whose key cannot be read is skipped
 * and reported (`onInvalid`): it trusts nothing, so a package it signed reads
 * as signed by an unknown key.
 */
export function trustedKeys(publishers: readonly TrustedPublisher[], onInvalid?: (name: string, reason: string) => void): Map<string, { name: string; key: KeyObject }> {
  const keys = new Map<string, { name: string; key: KeyObject }>();
  for (const p of publishers) {
    try {
      const key = parsePublicKey(p.publicKey);
      const id = keyFingerprint(key);
      if (!keys.has(id)) keys.set(id, { name: p.name, key });
    } catch (err) {
      onInvalid?.(p.name, (err as Error).message);
    }
  }
  return keys;
}

/** The signature file of a package directory, as text; null when there is none. Throws `SignatureError` for one that cannot be a signature. */
export async function readSignatureFile(dir: string): Promise<string | null> {
  const path = join(dir, SIGNATURE_FILE);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!info.isFile()) throw new SignatureError(`${SIGNATURE_FILE} is not a regular file`);
  if (info.size > MAX_SIGNATURE_BYTES) throw new SignatureError(`${SIGNATURE_FILE} is larger than ${MAX_SIGNATURE_BYTES} bytes`);
  return readFile(path, 'utf8');
}

/** Check the text of a signature file against a content hash and the trusted keys. */
export function checkSignature(contentHash: string, text: string | null, trusted: Map<string, { name: string; key: KeyObject }>): SignatureCheck {
  if (text === null) return { status: 'unsigned' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'invalid', reason: `${SIGNATURE_FILE} is not valid JSON` };
  }
  const sig = parsed as Partial<SignatureFile> | null;
  if (typeof sig !== 'object' || sig === null || sig.alg !== 'ed25519' || typeof sig.keyId !== 'string' || typeof sig.signature !== 'string') {
    return { status: 'invalid', reason: `${SIGNATURE_FILE} must be { "alg": "ed25519", "keyId": "…", "signature": "<base64>" }` };
  }
  const known = trusted.get(sig.keyId);
  if (!known) return { status: 'unknown_key', keyId: sig.keyId };
  const bytes = Buffer.from(sig.signature, 'base64');
  if (bytes.length !== 64 || !verify(null, message(contentHash), known.key, bytes)) {
    return { status: 'invalid', reason: `The signature by ${known.name} (${sig.keyId}) does not match the package content` };
  }
  return { status: 'valid', publisher: known.name, keyId: sig.keyId };
}

/** Check the signature file of a package directory against its content hash. */
export async function checkPackageSignature(
  dir: string,
  contentHash: string,
  publishers: readonly TrustedPublisher[],
  onInvalidKey?: (name: string, reason: string) => void,
): Promise<SignatureCheck> {
  let text: string | null;
  try {
    text = await readSignatureFile(dir);
  } catch (err) {
    if (err instanceof SignatureError) return { status: 'invalid', reason: err.message };
    throw err;
  }
  return checkSignature(contentHash, text, trustedKeys(publishers, onInvalidKey));
}
