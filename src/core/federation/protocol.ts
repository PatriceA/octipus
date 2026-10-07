/**
 * Wire schemas of the peer link (docs/plans/federation-spec.md §5.2–5.3).
 *
 * Two layers:
 *
 *  - Before `welcome`, frames are plain JSON `{ v: 1, type, body }`: the two
 *    `hello`s and the `welcome`. Nothing else is accepted before the link is
 *    sealed.
 *  - After `welcome`, every frame on the wire is a sealed envelope
 *    `{ v: 1, s, c }` (seal.ts). Its plaintext is a request, a result or a
 *    host event.
 *
 * Everything is parsed strictly: an extra field is a malformed frame, and a
 * request type with no handler is answered `unsupported` (F-D14).
 */
import { z } from 'zod';
import { INSTANCE_ID_LENGTH } from './identity';

/** The link protocol's major version. A peer on another one is refused (4409). */
export const PROTOCOL_VERSION = 1;

/** Close codes (§5.4). */
export const CLOSE = {
  /** Normal close. */
  normal: 4000,
  /** Authentication or seal failure. */
  auth: 4401,
  /** Blocked, or federation off. */
  forbidden: 4403,
  /** Protocol mismatch. */
  protocol: 4409,
  /** Rate or queue limit. */
  limit: 4429,
} as const;

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/** A WebSocket close reason is at most 123 bytes of UTF-8 (RFC 6455 §5.5); `ws` throws past that. */
const MAX_CLOSE_REASON_BYTES = 123;

/** `reason` cut to fit a close frame, never splitting a character. */
export function closeReason(reason: string): string {
  if (Buffer.byteLength(reason, 'utf8') <= MAX_CLOSE_REASON_BYTES) return reason;
  let out = '';
  let bytes = 0;
  for (const ch of reason) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > MAX_CLOSE_REASON_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * Largest plain frame before `welcome`: a hello is well under 1 KiB, so a
 * bigger one is refused before it is parsed (`maxPayload` alone would let an
 * unauthenticated peer make us JSON-parse a full sealed-frame budget).
 */
export const MAX_HANDSHAKE_FRAME_BYTES = 4096;

/** Base64 of exactly `bytes` bytes. */
function b64Bytes(bytes: number) {
  return z.string().max(Math.ceil(bytes / 3) * 4 + 4).refine((s) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
    return Buffer.from(s, 'base64').length === bytes;
  }, { message: `must be base64 of ${bytes} bytes` });
}

const instanceIdSchema = z.string().length(INSTANCE_ID_LENGTH).regex(/^[a-z2-7]+$/);
/** An Ed25519 SPKI DER key is 44 bytes. */
const publicKeySchema = b64Bytes(44);
/** Handshake nonces: 32 random bytes. */
export const NONCE_BYTES = 32;
const nonceSchema = b64Bytes(NONCE_BYTES);
/** An X25519 public key, raw. */
const ephSchema = b64Bytes(32);

/** The host's `hello` (step 1). */
export const hostHelloSchema = z.object({
  protocol: z.number().int().min(0),
  instanceId: instanceIdSchema,
  publicKey: publicKeySchema,
  nonce: nonceSchema,
  ts: z.number().int().min(0),
  eph: ephSchema,
  appVersion: z.string().max(64),
}).strict();
export type HostHello = z.infer<typeof hostHelloSchema>;

/** The visitor's `hello` (step 3): the host's fields plus its signature over T("visitor", …). */
export const visitorHelloSchema = hostHelloSchema.extend({
  sig: b64Bytes(64),
}).strict();
export type VisitorHello = z.infer<typeof visitorHelloSchema>;

/** The host's `welcome` (step 5): its signature over T("host", …). */
export const welcomeSchema = z.object({
  sig: b64Bytes(64),
}).strict();
export type Welcome = z.infer<typeof welcomeSchema>;

/** A pre-handshake frame. `protocol` is read before the body is held to this version's shape. */
export const plainFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.enum(['hello', 'welcome']),
  body: z.unknown(),
}).strict();
export type PlainFrame = z.infer<typeof plainFrameSchema>;

/**
 * A sealed frame on the wire (seal.ts): sequence number and ciphertext with
 * tag. The AEAD nonce is derived from the sequence number, so it is not sent.
 */
export const sealedFrameSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  s: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  c: z.string().min(1),
}).strict();
export type SealedFrame = z.infer<typeof sealedFrameSchema>;

/**
 * Request types and their bodies. `ping` is the heartbeat (either side asks,
 * the other answers). The `space.*`, content and gateway operations are named
 * here and filled with their bodies by the slices that build them (§6–§7);
 * until a handler is registered they are answered `unsupported`.
 */
export const requestBodySchemas = {
  'ping': z.object({}).strict(),
  'space.join': z.unknown(),
  'space.leave': z.unknown(),
  'space.info': z.unknown(),
  'space.members': z.unknown(),
  'space.rooms': z.unknown(),
  'room.page': z.unknown(),
  'note.list': z.unknown(),
  'note.read': z.unknown(),
  'note.propose': z.unknown(),
  'task.list': z.unknown(),
  'task.read': z.unknown(),
  'task.create': z.unknown(),
  'task.checkout': z.unknown(),
  'task.release': z.unknown(),
  'task.comment': z.unknown(),
  'file.list': z.unknown(),
  'file.read': z.unknown(),
  'memory.list': z.unknown(),
  /** A gateway client frame for the visitor's virtual connection `conn` (§7.2). */
  'gateway.frame': z.unknown(),
  /** B's client connection `conn` closed: drop its virtual connection. */
  'conn.close': z.unknown(),
} as const;
export type FederationRequestType = keyof typeof requestBodySchemas;

/**
 * Host event bodies, delivered as `{ type: 'event', as, conn, body }`. A
 * gateway server message for a virtual connection, or a link-level notice
 * such as `space.revoked { spaceId }` (§7.6).
 */
export const eventBodySchema = z.unknown();

const idSchema = z.string().min(1).max(64);
/** Request type names: dotted lowercase words. Unknown names parse and get `unsupported`. */
const typeSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/)
  .refine((t) => t !== 'result' && t !== 'event', { message: 'reserved type' });
/** A visitor handle (`as`) or a client connection reference (`conn`). */
const refSchema = z.string().min(1).max(200);

export const linkRequestSchema = z.object({
  id: idSchema,
  type: typeSchema,
  as: refSchema.optional(),
  conn: refSchema.optional(),
  body: z.unknown(),
}).strict();
export type LinkRequest = z.infer<typeof linkRequestSchema>;

export const linkErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(1000).optional(),
}).strict();
export type LinkError = z.infer<typeof linkErrorSchema>;

export const linkResultSchema = z.union([
  z.object({ id: idSchema, type: z.literal('result'), re: idSchema, ok: z.literal(true), body: z.unknown() }).strict(),
  z.object({ id: idSchema, type: z.literal('result'), re: idSchema, ok: z.literal(false), error: linkErrorSchema }).strict(),
]);
export type LinkResult = z.infer<typeof linkResultSchema>;

export const linkEventSchema = z.object({
  id: idSchema,
  type: z.literal('event'),
  as: refSchema,
  conn: refSchema,
  body: eventBodySchema,
}).strict();
export type LinkEvent = z.infer<typeof linkEventSchema>;

/** The plaintext of a sealed frame. */
export const linkMessageSchema = z.union([linkResultSchema, linkEventSchema, linkRequestSchema]);
export type LinkMessage = z.infer<typeof linkMessageSchema>;
