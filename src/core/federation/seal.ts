/**
 * Link sealing (docs/plans/federation-spec.md §5.3, F-D4).
 *
 * The handshake binds an ephemeral X25519 exchange into both signatures, and
 * both ends derive
 *
 *     HKDF-SHA256(X25519(x, x'), salt = nA ‖ nB, info = "octipus-fed-1") → 64 bytes
 *
 * split into two direction keys: the first 32 bytes seal host → visitor, the
 * last 32 visitor → host. Every frame after `welcome` is ChaCha20-Poly1305
 * under its direction's key with a fresh random 96-bit nonce; the sequence
 * number (from 0, +1 per frame, per direction) is bound in the associated
 * data, so a frame that is tampered with, replayed, reordered or reflected
 * back at its sender fails to open. That holds over TLS too: frames stay
 * integrity-protected through a TLS-terminating proxy.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { PROTOCOL_VERSION, type SealedFrame } from './protocol';

const HKDF_INFO = 'octipus-fed-1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The DER prefix that wraps a raw 32-byte X25519 key into SPKI (RFC 8410). */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export type LinkRole = 'host' | 'visitor';

/** A failed open: a bad tag, a wrong sequence number or a malformed frame. Closes the link (4401). */
export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

/**
 * The canonical transcript `T(...)`: each field as a 4-byte big-endian
 * length followed by its UTF-8 bytes. Length prefixes make the encoding
 * injective — no two field lists produce the same bytes — which a plain
 * join with a separator does not guarantee.
 */
export function transcript(fields: readonly (string | number)[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const bytes = Buffer.from(String(field), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    parts.push(len, bytes);
  }
  return Buffer.concat(parts);
}

/**
 * What each side signs (§5.3): `T(role, nA, nB, A, B, xA_pub, xB_pub, ts)`.
 * The role label keeps the visitor's signature from being replayed as the
 * host's; both ephemeral keys inside it are what makes a relay that swaps
 * them fail.
 */
export function handshakeTranscript(signer: LinkRole, f: {
  nonceA: string;
  nonceB: string;
  hostId: string;
  visitorId: string;
  hostEph: string;
  visitorEph: string;
  ts: number;
}): Buffer {
  return transcript([signer, f.nonceA, f.nonceB, f.hostId, f.visitorId, f.hostEph, f.visitorEph, f.ts]);
}

export interface EphemeralKey {
  privateKey: KeyObject;
  /** The raw 32-byte public key, base64. */
  publicRawB64: string;
}

/** A fresh X25519 keypair for one handshake. */
export function generateEphemeral(): EphemeralKey {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicRawB64: raw.toString('base64') };
}

export interface LinkKeys {
  /** Seals host → visitor. */
  hostToVisitor: Buffer;
  /** Seals visitor → host. */
  visitorToHost: Buffer;
}

/**
 * Derive both direction keys from our ephemeral private key, the peer's raw
 * ephemeral public key and the two handshake nonces (base64, as on the wire).
 */
export function deriveLinkKeys(own: KeyObject, peerEphRawB64: string, nonceA: string, nonceB: string): LinkKeys {
  const peerRaw = Buffer.from(peerEphRawB64, 'base64');
  if (peerRaw.length !== 32) throw new SealError('peer ephemeral key must be 32 bytes');
  const peer = createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, peerRaw]), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: own, publicKey: peer });
  // A low-order peer point yields the all-zero secret: refuse it rather than
  // derive keys an attacker can compute too.
  if (shared.every((b) => b === 0)) throw new SealError('degenerate X25519 shared secret');
  const salt = Buffer.concat([Buffer.from(nonceA, 'base64'), Buffer.from(nonceB, 'base64')]);
  const okm = Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, KEY_BYTES * 2));
  return { hostToVisitor: okm.subarray(0, KEY_BYTES), visitorToHost: okm.subarray(KEY_BYTES) };
}

/** Associated data of frame `seq` in direction `from`. */
function aad(from: LinkRole, seq: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(seq));
  return Buffer.concat([Buffer.from(`${HKDF_INFO}|${from}|`, 'utf8'), out]);
}

/**
 * One end's sealing state: its send key and counter, its receive key and the
 * sequence number it expects next.
 */
export class SealedChannel {
  private sendSeq = 0;
  private recvSeq = 0;
  private readonly sendKey: Buffer;
  private readonly recvKey: Buffer;
  private readonly peer: LinkRole;

  constructor(keys: LinkKeys, private readonly role: LinkRole) {
    this.sendKey = role === 'host' ? keys.hostToVisitor : keys.visitorToHost;
    this.recvKey = role === 'host' ? keys.visitorToHost : keys.hostToVisitor;
    this.peer = role === 'host' ? 'visitor' : 'host';
  }

  /** Seal `plaintext` as the next frame in our direction. */
  seal(plaintext: Buffer): SealedFrame {
    const s = this.sendSeq++;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('chacha20-poly1305', this.sendKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(this.role, s), { plaintextLength: plaintext.length });
    const c = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { v: PROTOCOL_VERSION, s, n: nonce.toString('base64'), c: c.toString('base64') };
  }

  /**
   * Open the peer's next frame. Throws `SealError` unless it carries exactly
   * the next sequence number and its tag verifies; the expected number moves
   * on only after a successful open.
   */
  open(frame: SealedFrame): Buffer {
    if (frame.s !== this.recvSeq) {
      throw new SealError(`out-of-order frame: expected ${this.recvSeq}, got ${frame.s}`);
    }
    const nonce = Buffer.from(frame.n, 'base64');
    const sealed = Buffer.from(frame.c, 'base64');
    if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) throw new SealError('malformed sealed frame');
    const body = sealed.subarray(0, sealed.length - TAG_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const decipher = createDecipheriv('chacha20-poly1305', this.recvKey, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(this.peer, frame.s), { plaintextLength: body.length });
    decipher.setAuthTag(tag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new SealError('sealed frame failed authentication');
    }
    this.recvSeq++;
    return plaintext;
  }
}
