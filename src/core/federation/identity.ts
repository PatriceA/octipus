/**
 * The install's federation identity (docs/plans/federation-spec.md §4.1, F-D2).
 *
 * One Ed25519 keypair per install. The private key is the vault system secret
 * `federation.identity` (PKCS8 PEM), which the admin vault routes refuse to
 * touch. The instance id is `base32(sha256(spki))` cut to 26 characters (130
 * bits); peers pin it, so it must never change behind their back:
 *
 *  - The read tells **absent** from **error** (`getSystemSecretStrict`). A
 *    vault or decryption failure throws and federation stays off for this
 *    start, rather than minting a second identity that every peer would see
 *    as a stranger.
 *  - An absent key is created under an advisory lock (`createSystemSecretOnce`),
 *    so concurrent first calls, in one process or several, store one key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';
import { getVault, RESERVED_SECRET_NAMES } from '@/security/vault';
import { logger } from '@/utils/logger';

const log = logger.child({ component: 'federation-identity' });

/** The vault system secret holding the identity's private key. */
export const IDENTITY_SECRET_NAME = 'federation.identity';
if (!RESERVED_SECRET_NAMES.has(IDENTITY_SECRET_NAME)) {
  throw new Error(`${IDENTITY_SECRET_NAME} must be a reserved vault name`);
}

/** Length of an instance id, in base32 characters (130 bits). */
export const INSTANCE_ID_LENGTH = 26;

/** The DER prefix that wraps a raw 32-byte Ed25519 key into SPKI (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export interface InstanceIdentity {
  /** `base32(sha256(spki))[:26]`, lowercase. */
  instanceId: string;
  /** The public key, SPKI DER, base64. */
  publicKeySpkiB64: string;
  /** Ed25519 signature over `bytes`. */
  sign(bytes: Uint8Array): Buffer;
  /** The id in four groups, for people to compare. */
  display: string;
}

/** RFC 4648 base32, lowercase, unpadded. */
function base32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** The instance id of an SPKI public key (base64 DER). */
export function instanceIdOf(spkiB64: string): string {
  const spki = Buffer.from(spkiB64, 'base64');
  if (spki.length === 0) throw new Error('instanceIdOf: empty public key');
  return base32(createHash('sha256').update(spki).digest()).slice(0, INSTANCE_ID_LENGTH);
}

/** Whether `id` has the shape of an instance id. */
export function isInstanceId(id: string): boolean {
  return id.length === INSTANCE_ID_LENGTH && /^[a-z2-7]+$/.test(id);
}

/** The first 8 characters, shown only next to a badge. Identity is always the full id. */
export function shortInstanceLabel(id: string): string {
  return id.slice(0, 8);
}

/** `abcdefg-hijklmn-opqrst-uvwxyz`: four groups, for reading aloud or comparing. */
export function displayInstanceId(id: string): string {
  return [id.slice(0, 7), id.slice(7, 14), id.slice(14, 20), id.slice(20)].join('-');
}

/**
 * An Ed25519 public key from SPKI DER or a raw 32-byte key (base64 string
 * or bytes). Throws on anything else: a malformed key is a configuration or
 * protocol error, not a failed signature.
 */
function ed25519PublicKey(publicKey: string | Uint8Array): KeyObject {
  const bytes = typeof publicKey === 'string' ? Buffer.from(publicKey, 'base64') : Buffer.from(publicKey);
  const der = bytes.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, bytes]) : bytes;
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Expected an Ed25519 public key, got ${key.asymmetricKeyType ?? 'unknown'}`);
  }
  return key;
}

/**
 * Verify an Ed25519 signature. `publicKey` is SPKI DER or a raw 32-byte key,
 * as bytes or base64. False for a wrong signature; throws for a key that is
 * not an Ed25519 key.
 */
export function verifyEd25519(publicKey: string | Uint8Array, bytes: Uint8Array, sig: Uint8Array): boolean {
  const key = ed25519PublicKey(publicKey);
  if (sig.length !== 64) return false;
  return verify(null, bytes, key, sig);
}

/** An identity from its PKCS8 PEM private key. */
export function identityFromPrivateKeyPem(pem: string): InstanceIdentity {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${IDENTITY_SECRET_NAME} is not an Ed25519 key (${privateKey.asymmetricKeyType ?? 'unknown'})`);
  }
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKeySpkiB64 = spki.toString('base64');
  const instanceId = instanceIdOf(publicKeySpkiB64);
  return {
    instanceId,
    publicKeySpkiB64,
    sign: (bytes) => sign(null, bytes, privateKey),
    display: displayInstanceId(instanceId),
  };
}

/** A fresh Ed25519 private key as PKCS8 PEM. */
export function generateIdentityPem(): string {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

/**
 * Read the identity, creating it when absent. Not memoised: two concurrent
 * calls race into `createSystemSecretOnce`, which stores one key, and both
 * read that key back.
 */
export async function loadInstanceIdentity(): Promise<InstanceIdentity> {
  const vault = getVault();
  let pem = await vault.getSystemSecretStrict(IDENTITY_SECRET_NAME);
  if (pem === null) {
    const created = await vault.createSystemSecretOnce(IDENTITY_SECRET_NAME, generateIdentityPem, {
      credentialType: 'certificate',
      description: 'Federation identity of this install (Ed25519). Peers pin it: never edit or delete.',
      tags: ['system', 'federation'],
    });
    pem = await vault.getSystemSecretStrict(IDENTITY_SECRET_NAME);
    if (pem === null) throw new Error(`${IDENTITY_SECRET_NAME} is absent right after it was stored`);
    if (created) log.info({ instanceId: identityFromPrivateKeyPem(pem).instanceId }, 'Federation identity created');
  }
  return identityFromPrivateKeyPem(pem);
}

let pending: Promise<InstanceIdentity> | null = null;

/**
 * The install's identity, read once per start. A failure is kept too:
 * federation stays off until the next start rather than retrying into a
 * vault that just failed (§4.1).
 */
export function getInstanceIdentity(): Promise<InstanceIdentity> {
  pending ??= loadInstanceIdentity().catch((err: unknown) => {
    log.error({ err }, 'Federation identity could not be read: federation stays off until restart');
    throw err;
  });
  return pending;
}

/** Forget the cached identity (tests). */
export function _resetInstanceIdentityForTests(): void {
  pending = null;
}
