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
 * is the one file the content hash leaves out, so it is held tightly instead:
 * only the canonical form `octi plugin sign` writes is accepted (exactly these
 * three keys, at most 1 KiB), and the sha256 of its bytes is pinned on the
 * package row beside the content hash (service.ts), checked at every start.
 *
 * The host trusts the keys listed in `plugins.trustedPublishers`; a signature
 * by any other key proves nothing here. An entry can be revoked (`revoked:
 * true`, or its key id in `plugins.revokedKeys`) or expire (`notAfter`): its
 * key then trusts nothing, and a signature by it reads as `revoked` or
 * `expired`, never valid. What a valid signature says: these exact files are
 * what the holder of that key signed. Not that they are safe.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, randomBytes, sign, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PLUGIN_MANIFEST_FILE } from '@/shared/plugin-package';
import { hashPackageContent, SIGNATURE_FILE } from './integrity';
import { parseManifest } from './manifest';
import { checkPackageTree } from './tree';

export { SIGNATURE_FILE } from './integrity';

const MESSAGE_PREFIX = 'octipus-plugin-signature/v1\n';
/** A signature file larger than this is not one (the canonical form is about 200 bytes). */
const MAX_SIGNATURE_BYTES = 1024;
const KEY_ID_RE = /^ed25519:[0-9a-f]{64}$/;
/** Base64 of exactly 64 bytes, padded. */
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A `plugins.trustedPublishers` entry. */
export interface TrustedPublisher {
  name: string;
  /** PEM (SPKI), or base64 of the raw 32-byte key or of its DER SPKI. */
  publicKey: string;
  /** ISO date or date-time after which the key trusts nothing (a date alone: its start, UTC). */
  notAfter?: string;
  /** The key was withdrawn (leaked, replaced): it trusts nothing, and a signature by it shows as revoked. */
  revoked?: boolean;
}

/** A key the host knows: trusted, or listed but revoked or expired (`untrusted`). A key revoked only by id has no key object. */
export interface KnownKey {
  name: string;
  key: KeyObject | null;
  untrusted: null | { status: 'revoked' | 'expired'; detail: string };
}

/** The known keys by key id (`trustedKeys`). */
export type KeyRing = Map<string, KnownKey>;

/** Revocation and the clock, beside the publishers (`plugins.revokedKeys`; `now` for tests). */
export interface KeyTrustOptions {
  revokedKeys?: readonly string[];
  now?: Date;
}

/** The contents of `octipus-plugin.sig`. */
export interface SignatureFile {
  alg: 'ed25519';
  keyId: string;
  signature: string;
}

/** A signature file read from a package: its contents and the sha256 of its bytes (`sha256:<hex>`, pinned on the row). */
export interface SignatureOnDisk {
  file: SignatureFile;
  sha256: string;
}

/** What `checkPackageSignature` found. */
export type SignatureCheck =
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: string }
  | { status: 'unknown_key'; keyId: string }
  | { status: 'revoked' | 'expired'; keyId: string; publisher: string | null; detail: string }
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
 * The one form a signature file may have, byte for byte: the three keys in
 * this order, two-space indented, with a trailing newline (what `octi plugin
 * sign` writes). Anything else is refused, so the file — the one the content
 * hash leaves out — has no room for other content.
 */
export function serializeSignature(sig: SignatureFile): string {
  return `${JSON.stringify({ alg: sig.alg, keyId: sig.keyId, signature: sig.signature }, null, 2)}\n`;
}

/** Parse a signature file, refusing anything but the canonical form (`serializeSignature`). */
export function parseSignatureFile(text: string): SignatureFile {
  if (Buffer.byteLength(text, 'utf8') > MAX_SIGNATURE_BYTES) throw new SignatureError(`${SIGNATURE_FILE} is larger than ${MAX_SIGNATURE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SignatureError(`${SIGNATURE_FILE} is not valid JSON`);
  }
  const sig = parsed as Record<string, unknown> | null;
  const keys = typeof sig === 'object' && sig !== null && !Array.isArray(sig) ? Object.keys(sig) : [];
  if (
    keys.length !== 3 || sig === null
    || sig.alg !== 'ed25519'
    || typeof sig.keyId !== 'string' || !KEY_ID_RE.test(sig.keyId)
    || typeof sig.signature !== 'string' || !SIGNATURE_RE.test(sig.signature)
    || Buffer.from(sig.signature, 'base64').length !== 64
  ) {
    throw new SignatureError(`${SIGNATURE_FILE} must be exactly { "alg": "ed25519", "keyId": "ed25519:<64 hex>", "signature": "<base64 of 64 bytes>" }`);
  }
  const file: SignatureFile = { alg: 'ed25519', keyId: sig.keyId, signature: sig.signature };
  if (serializeSignature(file) !== text) throw new SignatureError(`${SIGNATURE_FILE} is not in the canonical form \`octi plugin sign\` writes; sign the package again`);
  return file;
}

/**
 * Sign a package directory in place: check its tree (no symbolic links or
 * special files, as install requires), hash it (the signature file left out)
 * and write `octipus-plugin.sig` through a temporary file and a rename, never
 * through a link. Signing again replaces the signature.
 *
 * The temporary file is made in the package's PARENT directory, not in the
 * package: a crash between the write and the rename (where no cleanup runs)
 * would otherwise leave a stray file in the package and change its content
 * hash. The parent is on the same filesystem in practice, so the rename stays
 * atomic; a package directory that is itself a mount point fails with EXDEV
 * and is reported. On any failure the temporary file is removed.
 */
export async function signPackage(dir: string, privateKeyPem: string): Promise<{ contentHash: string; keyId: string; file: string }> {
  await checkPackageTree(dir);
  const manifest = parseManifest(JSON.parse(await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')));
  const contentHash = await hashPackageContent(dir, manifest);
  const sig = signContentHash(contentHash, privateKeyPem);
  const file = join(dir, SIGNATURE_FILE);
  try {
    if (!(await lstat(file)).isFile()) throw new SignatureError(`${file} exists and is not a regular file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const abs = resolve(dir);
  if (dirname(abs) === abs) throw new SignatureError('a filesystem root cannot be signed as a package');
  const temp = join(dirname(abs), `.${basename(abs)}.${SIGNATURE_FILE}.${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    // `wx`: never through a file or link already at that name.
    await writeFile(temp, serializeSignature(sig), { flag: 'wx', mode: 0o644 });
    await rename(temp, file);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      throw new SignatureError(`${dir} is on another filesystem than its parent directory, where the signature is written first; sign a copy of the package that is not a mount point`);
    }
    throw err;
  }
  return { contentHash, keyId: sig.keyId, file };
}

/** Whether `value` is a key id (`ed25519:<64 hex>`), the form `plugins.revokedKeys` lists. */
export function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID_RE.test(value);
}

/** The instant a `notAfter` value names (a date alone: its start, UTC), or null when it is not an ISO date. */
export function parseNotAfter(value: string): Date | null {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(text)) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The known keys by key id. An entry whose key cannot be read is skipped and
 * reported (`onInvalid`): it trusts nothing, so a package it signed reads as
 * signed by an unknown key. An entry that is revoked, whose key id is in
 * `revokedKeys`, or whose `notAfter` has passed (or cannot be read) is kept
 * as untrusted, so a signature by it says why it no longer counts. When a
 * key is listed twice, a revocation or expiry wins over a trusting entry. A
 * key id in `revokedKeys` with no entry is known as revoked, without a key.
 */
export function trustedKeys(publishers: readonly TrustedPublisher[], onInvalid?: (name: string, reason: string) => void, opts: KeyTrustOptions = {}): KeyRing {
  const keys: KeyRing = new Map();
  const now = (opts.now ?? new Date()).getTime();
  const revokedIds = new Set(opts.revokedKeys ?? []);
  for (const p of publishers) {
    let key: KeyObject;
    try {
      key = parsePublicKey(p.publicKey);
    } catch (err) {
      onInvalid?.(p.name, (err as Error).message);
      continue;
    }
    const id = keyFingerprint(key);
    let untrusted: KnownKey['untrusted'] = null;
    if (p.revoked === true || revokedIds.has(id)) {
      untrusted = { status: 'revoked', detail: `the key of ${p.name} (${id}) is revoked` };
    } else if (p.notAfter !== undefined) {
      const until = parseNotAfter(p.notAfter);
      if (until === null) {
        onInvalid?.(p.name, `notAfter "${p.notAfter}" is not an ISO date; the key trusts nothing`);
        untrusted = { status: 'expired', detail: `the key of ${p.name} (${id}) has an unreadable notAfter ("${p.notAfter}")` };
      } else if (now > until.getTime()) {
        untrusted = { status: 'expired', detail: `the key of ${p.name} (${id}) expired at ${until.toISOString()}` };
      }
    }
    const existing = keys.get(id);
    if (!existing || (existing.untrusted === null && untrusted !== null)) keys.set(id, { name: p.name, key, untrusted });
  }
  for (const id of revokedIds) {
    if (!keys.has(id)) keys.set(id, { name: id, key: null, untrusted: { status: 'revoked', detail: `the key ${id} is in plugins.revokedKeys` } });
  }
  return keys;
}

/**
 * The signature file of a package directory, or null when there is none.
 * Opened without following a link; throws `SignatureError` for anything that
 * is not a regular file in the canonical form.
 */
export async function readSignatureFile(dir: string): Promise<SignatureOnDisk | null> {
  const path = join(dir, SIGNATURE_FILE);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new SignatureError(`${SIGNATURE_FILE} is a symbolic link`);
    throw err;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SignatureError(`${SIGNATURE_FILE} is not a regular file`);
    if (info.size > MAX_SIGNATURE_BYTES) throw new SignatureError(`${SIGNATURE_FILE} is larger than ${MAX_SIGNATURE_BYTES} bytes`);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_SIGNATURE_BYTES) throw new SignatureError(`${SIGNATURE_FILE} is larger than ${MAX_SIGNATURE_BYTES} bytes`);
    return { file: parseSignatureFile(bytes.toString('utf8')), sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  } finally {
    await handle.close();
  }
}

/**
 * Check a signature against a content hash and the known keys (null:
 * unsigned). A signature that does not verify is `invalid`, whoever's key it
 * names; one that verifies by a revoked or expired key is `revoked` or
 * `expired`, never valid. A key revoked only by id (no key object) cannot be
 * verified and is `revoked` outright.
 */
export function verifySignature(contentHash: string, sig: SignatureFile | null, trusted: KeyRing): SignatureCheck {
  if (sig === null) return { status: 'unsigned' };
  const known = trusted.get(sig.keyId);
  if (!known) return { status: 'unknown_key', keyId: sig.keyId };
  if (known.key === null) {
    return { status: 'revoked', keyId: sig.keyId, publisher: null, detail: known.untrusted?.detail ?? `the key ${sig.keyId} is revoked` };
  }
  if (!verify(null, message(contentHash), known.key, Buffer.from(sig.signature, 'base64'))) {
    return { status: 'invalid', reason: `The signature by ${known.name} (${sig.keyId}) does not match the package content` };
  }
  if (known.untrusted) return { status: known.untrusted.status, keyId: sig.keyId, publisher: known.name, detail: known.untrusted.detail };
  return { status: 'valid', publisher: known.name, keyId: sig.keyId };
}

/** Check the text of a signature file (null: none) against a content hash and the known keys. */
export function checkSignature(contentHash: string, text: string | null, trusted: KeyRing): SignatureCheck {
  if (text === null) return { status: 'unsigned' };
  try {
    return verifySignature(contentHash, parseSignatureFile(text), trusted);
  } catch (err) {
    if (err instanceof SignatureError) return { status: 'invalid', reason: err.message };
    throw err;
  }
}

/** Check a signature file already read (`readSignatureFile`) against a content hash and the publishers. */
export function checkSignatureOnDisk(
  onDisk: SignatureOnDisk | null,
  contentHash: string,
  publishers: readonly TrustedPublisher[],
  onInvalidKey?: (name: string, reason: string) => void,
  opts?: KeyTrustOptions,
): SignatureCheck {
  return verifySignature(contentHash, onDisk?.file ?? null, trustedKeys(publishers, onInvalidKey, opts));
}

/** Read and check the signature file of a package directory against its content hash. */
export async function checkPackageSignature(
  dir: string,
  contentHash: string,
  publishers: readonly TrustedPublisher[],
  onInvalidKey?: (name: string, reason: string) => void,
  opts?: KeyTrustOptions,
): Promise<SignatureCheck> {
  let onDisk: SignatureOnDisk | null;
  try {
    onDisk = await readSignatureFile(dir);
  } catch (err) {
    if (err instanceof SignatureError) return { status: 'invalid', reason: err.message };
    throw err;
  }
  return checkSignatureOnDisk(onDisk, contentHash, publishers, onInvalidKey, opts);
}
