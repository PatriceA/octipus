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

const uuidSchema = z.string().uuid();
const spaceRef = { spaceId: uuidSchema };
/** A path relative to the space's files root ('' is the root). */
const filePathSchema = z.string().max(4096).refine((p) => !p.includes('\0'), { message: 'path contains a null byte' });

/**
 * The gateway client frame types a visitor may send for its virtual
 * connection (§7.2). Generic `subscribe`/`unsubscribe`, chat, commands and
 * every other type are refused before the gateway sees them.
 */
export const GATEWAY_FRAME_ALLOWLIST = [
  'room.subscribe', 'room.unsubscribe', 'room.post', 'room.typing', 'room.read',
  'space.subscribe', 'doc.join', 'doc.update', 'doc.awareness', 'doc.leave', 'ping',
] as const;

/**
 * Request types and their bodies. `ping` is the heartbeat (either side asks,
 * the other answers). Every other type is a visitor's request to the host
 * (§6–§7); all but `space.join` name the visitor in `as` (its member
 * handle), and `gateway.frame` / `conn.close` name its client connection
 * in `conn`. A type with no handler is answered `unsupported`.
 */
export const requestBodySchemas = {
  'ping': z.object({}).strict(),
  /** Redeem an invite (§6.2): `user.ref` is the user id on the visitor install, `name` its display name. */
  'space.join': z.object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    user: z.object({ ref: z.string().min(1).max(200), name: z.string().trim().min(1).max(40) }).strict(),
  }).strict(),
  'space.leave': z.object(spaceRef).strict(),
  'space.info': z.object(spaceRef).strict(),
  'space.members': z.object(spaceRef).strict(),
  'space.rooms': z.object(spaceRef).strict(),
  'room.page': z.object({
    ...spaceRef,
    roomId: uuidSchema,
    before: uuidSchema.optional(),
    after: uuidSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).strict(),
  'note.list': z.object(spaceRef).strict(),
  'note.read': z.object({ ...spaceRef, noteId: uuidSchema }).strict(),
  /** A proposed new body (and title) of a note, made from the text whose sha the visitor read. */
  'note.propose': z.object({
    ...spaceRef,
    noteId: uuidSchema,
    baseSha256: z.string().regex(/^[0-9a-f]{64}$/),
    body: z.string().max(1_000_000),
    title: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  'task.list': z.object({ ...spaceRef, status: z.enum(['open', 'in_progress', 'done', 'archived']).optional() }).strict(),
  'task.read': z.object({ ...spaceRef, taskId: uuidSchema }).strict(),
  'task.create': z.object({
    ...spaceRef,
    title: z.string().trim().min(1).max(500),
    notes: z.string().max(10_000).optional(),
    priority: z.number().int().min(0).max(3).optional(),
  }).strict(),
  'task.checkout': z.object({ ...spaceRef, taskId: uuidSchema }).strict(),
  'task.release': z.object({ ...spaceRef, taskId: uuidSchema }).strict(),
  'task.comment': z.object({ ...spaceRef, taskId: uuidSchema, body: z.string().min(1).max(10_000) }).strict(),
  'file.list': z.object({ ...spaceRef, path: filePathSchema.optional() }).strict(),
  'file.read': z.object({ ...spaceRef, path: filePathSchema.min(1) }).strict(),
  'memory.list': z.object(spaceRef).strict(),
  /** A gateway client frame for the visitor's virtual connection `conn` (§7.2); its type must be allowlisted. */
  'gateway.frame': z.object({
    frame: z.object({ type: z.enum(GATEWAY_FRAME_ALLOWLIST) }).passthrough(),
  }).strict(),
  /** B's client connection `conn` closed: drop its virtual connection. */
  'conn.close': z.object({}).strict(),
} as const;
export type FederationRequestType = keyof typeof requestBodySchemas;
export type FederationRequestBody<T extends FederationRequestType> = z.infer<(typeof requestBodySchemas)[T]>;

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
