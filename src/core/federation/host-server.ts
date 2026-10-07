/**
 * The host endpoint `/federation` (docs/plans/federation-spec.md §5.1, §5.3).
 *
 * Registered next to `/gateway` only when `federation.mode` hosts; a mode
 * change while the server runs is enforced after the upgrade (4403), and
 * turning hosting off closes every inbound link.
 *
 * WebSocket upgrades bypass the HTTP hooks, so the endpoint bounds itself:
 * at most 10 links per source address that have not finished the handshake,
 * at most 30 handshakes per address per minute, and 5 seconds to finish one.
 * Plain `ws://` is accepted only from an address inside `federation.lanCidrs`;
 * anything else must arrive through a trusted proxy that terminated TLS.
 *
 * The handshake (host side):
 *
 *  1. send `hello { protocol, instanceId, publicKey, nonce: nA, ts, eph: xA, appVersion }`;
 *     `nA` is recorded in the key-value store (TTL 120 s);
 *  2. check the visitor's `hello`: protocol (4409), `instanceIdOf(publicKey)`,
 *     ts within ±60 s, its signature over T("visitor", …), that `nA` was ours
 *     and is consumed now (single use), that `nB` was never seen (4401), and
 *     that its instance is not blocked (4403);
 *  3. answer `welcome { sig: sign(T("host", …)) }` and seal the link.
 *
 * No `federation_instances` row is written here: an instance exists for the
 * host from its first successful `space.join` (§6.2), not from a handshake.
 *
 * Requests on a sealed link go to the handlers registered with
 * `registerHostHandler`; a type with no handler is answered `unsupported`.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Elysia } from '@/api/http';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { federationInstances } from '@/db/schema/federation';
import { getStorageProvider } from '@/db/storage';
import { addressInList, clientIp, isTrustedProxy, parseAddressList } from '@/security/client-ip';
import { logger } from '@/utils/logger';
import { getAppVersion } from '@/utils/version';
import { getInstanceIdentity, type InstanceIdentity, instanceIdOf, verifyEd25519 } from './identity';
import { type LinkSocket, LinkRequestError, PeerLink, sealedWireLimit } from './link';
import { federationHosts, onFederationModeChanged } from './mode';
import {
  CLOSE,
  type FederationRequestType,
  type HostHello,
  type LinkRequest,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  plainFrameSchema,
  visitorHelloSchema,
} from './protocol';
import { deriveLinkKeys, type EphemeralKey, generateEphemeral, handshakeTranscript, SealedChannel } from './seal';

const log = logger.child({ component: 'federation-host' });

/** Links from one address that have not finished the handshake. */
export const MAX_PENDING_PER_IP = 10;
/** Handshakes one address may start per minute. */
export const MAX_HANDSHAKES_PER_IP_PER_MINUTE = 30;
/** Time a peer has to finish the handshake. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Largest clock difference a visitor's `hello` may carry. */
export const MAX_CLOCK_SKEW_MS = 60_000;
/** Lifetime of a recorded handshake nonce. */
const NONCE_TTL_SECONDS = 120;

const hostNonceKey = (nonce: string) => `federation:nonce:host:${nonce}`;
const visitorNonceKey = (instanceId: string, nonce: string) => `federation:nonce:visitor:${instanceId}:${nonce}`;

// ── Request handlers ─────────────────────────────────────────────

export interface HostRequestContext {
  /** The visitor install's verified instance id. */
  instanceId: string;
  link: PeerLink;
  /** The visitor handle the frame names (`as`), unverified until a handler resolves it. */
  as?: string;
  /** The visitor-side client connection the frame names (`conn`). */
  conn?: string;
}

export type HostHandler = (body: unknown, ctx: HostRequestContext) => Promise<unknown>;

const handlers = new Map<string, HostHandler>();

/**
 * Answer requests of `type` on every inbound link. One handler per type: a
 * second registration is a wiring bug and throws.
 */
export function registerHostHandler(type: FederationRequestType, fn: HostHandler): void {
  if (handlers.has(type)) throw new Error(`A federation host handler for ${type} is already registered`);
  handlers.set(type, fn);
}

registerHostHandler('ping', async () => ({}));

async function dispatchHostRequest(request: LinkRequest, link: PeerLink): Promise<unknown> {
  const handler = handlers.get(request.type);
  if (!handler) throw new LinkRequestError('unsupported', `unsupported request type ${request.type}`);
  return handler(request.body, { instanceId: link.peerInstanceId, link, as: request.as, conn: request.conn });
}

// ── Link and socket bookkeeping ──────────────────────────────────

/** The sealed link of each visitor install (one per instance pair, F-D7). */
const inbound = new Map<string, PeerLink>();
/** Every socket on the endpoint, handshaken or not, so a mode change reaches all of them. */
const live = new Set<HostConn>();
const pendingByIp = new Map<string, number>();
const handshakesByIp = new Map<string, number[]>();

/** The `ws` object `serve.ts` hands a route: the raw socket rides along. */
interface EndpointSocket {
  data: { request: Request } & Record<string, unknown>;
  remoteAddress: string | undefined;
  raw: LinkSocket;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
}

interface HostConn {
  ws: EndpointSocket;
  ip: string;
  stage: 'starting' | 'hello' | 'verifying' | 'open' | 'closed';
  pendingCounted: boolean;
  timer: NodeJS.Timeout | null;
  identity: InstanceIdentity | null;
  nonceA: string;
  eph: EphemeralKey | null;
  link: PeerLink | null;
}

/** The open link from visitor install `instanceId`, if any. */
export function inboundLink(instanceId: string): PeerLink | undefined {
  return inbound.get(instanceId);
}

/** Close every socket on the endpoint, handshaken or not. */
export function closeInboundLinks(code: number, reason: string): void {
  for (const conn of [...live]) closeConn(conn, code, reason);
}

function releasePending(conn: HostConn): void {
  if (!conn.pendingCounted) return;
  conn.pendingCounted = false;
  const n = (pendingByIp.get(conn.ip) ?? 1) - 1;
  if (n <= 0) pendingByIp.delete(conn.ip);
  else pendingByIp.set(conn.ip, n);
}

function settle(conn: HostConn): void {
  if (conn.timer) clearTimeout(conn.timer);
  conn.timer = null;
  releasePending(conn);
}

function closeConn(conn: HostConn, code: number, reason: string): void {
  if (conn.stage === 'closed') return;
  const wasOpen = conn.stage === 'open';
  conn.stage = 'closed';
  settle(conn);
  live.delete(conn);
  if (wasOpen && conn.link) {
    conn.link.close(code, reason);
    return;
  }
  log.info({ ip: conn.ip, code, reason }, 'Federation handshake refused');
  conn.ws.close(code, reason.slice(0, 120));
}

/** Whether `ip` may start another handshake now; records it when so. */
function admitHandshake(ip: string, now: number): 'ok' | 'pending' | 'rate' {
  if ((pendingByIp.get(ip) ?? 0) >= MAX_PENDING_PER_IP) return 'pending';
  const recent = (handshakesByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= MAX_HANDSHAKES_PER_IP_PER_MINUTE) {
    handshakesByIp.set(ip, recent);
    return 'rate';
  }
  recent.push(now);
  handshakesByIp.set(ip, recent);
  return 'ok';
}

/**
 * Plain `ws://` only from inside `federation.lanCidrs`; otherwise the socket
 * must come from a trusted proxy that says it terminated TLS.
 */
function transportAllowed(ws: EndpointSocket, ip: string): boolean {
  const lan = parseAddressList(getConfig().federation.lanCidrs, 'federation.lanCidrs');
  if (addressInList(lan, ip)) return true;
  if (!ws.remoteAddress || !isTrustedProxy(ws.remoteAddress)) return false;
  const proto = ws.data.request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  return proto === 'https' || proto === 'wss';
}

let followingMode = false;

export interface FederationEndpointDeps {
  /** The install identity; defaults to the vault one. */
  identity?: () => Promise<InstanceIdentity>;
}

/**
 * Register `/federation` on the server when this install hosts. Returns
 * whether it was registered.
 */
export function setupFederationWebSocket(app: Elysia, deps: FederationEndpointDeps = {}): boolean {
  const cfg = getConfig();
  if (!federationHosts(cfg.federation.mode)) return false;
  const identity = deps.identity ?? getInstanceIdentity;

  if (!cfg.oauth.publicUrl) {
    log.error('federation.mode hosts but no PUBLIC_URL is set: invite links will carry no federation part');
  }
  if (!followingMode) {
    followingMode = true;
    onFederationModeChanged((next) => {
      if (!federationHosts(next)) closeInboundLinks(CLOSE.forbidden, 'federation off');
    });
  }
  // Read the identity now so a vault failure is in the startup log, not
  // discovered by the first peer.
  identity().then(
    (id) => log.info({ instanceId: id.instanceId }, 'Federation host endpoint ready'),
    (err: unknown) => log.error({ err }, 'Federation host endpoint has no identity: every handshake will be refused'),
  );

  const maxFrameBytes = cfg.gateway.maxFrameBytes;

  app.ws('/federation', {
    maxPayload: sealedWireLimit(maxFrameBytes),

    async open(ws: EndpointSocket) {
      const ip = clientIp(ws.data.request, ws.remoteAddress);
      const conn: HostConn = { ws, ip, stage: 'starting', pendingCounted: false, timer: null, identity: null, nonceA: '', eph: null, link: null };
      ws.data.federation = conn;
      live.add(conn);

      if (!federationHosts()) {
        closeConn(conn, CLOSE.forbidden, 'federation off');
        return;
      }
      if (!transportAllowed(ws, ip)) {
        closeConn(conn, CLOSE.forbidden, 'wss required outside federation.lanCidrs');
        return;
      }
      const admitted = admitHandshake(ip, Date.now());
      if (admitted !== 'ok') {
        closeConn(conn, CLOSE.limit, admitted === 'pending' ? 'too many pending handshakes' : 'handshake rate exceeded');
        return;
      }
      pendingByIp.set(ip, (pendingByIp.get(ip) ?? 0) + 1);
      conn.pendingCounted = true;
      conn.timer = setTimeout(() => closeConn(conn, CLOSE.auth, 'handshake timeout'), HANDSHAKE_TIMEOUT_MS);
      conn.timer.unref();

      let own: InstanceIdentity;
      try {
        own = await identity();
      } catch (err) {
        log.error({ err }, 'Federation handshake refused: this install has no identity');
        closeConn(conn, CLOSE.forbidden, 'federation unavailable');
        return;
      }
      if (conn.stage !== 'starting') return;
      const nonceA = randomBytes(NONCE_BYTES).toString('base64');
      if (!(await getStorageProvider().setRawIfAbsent(hostNonceKey(nonceA), '1', NONCE_TTL_SECONDS))) {
        throw new Error('A fresh federation handshake nonce was already recorded');
      }
      if (conn.stage !== 'starting') return;
      conn.identity = own;
      conn.nonceA = nonceA;
      conn.eph = generateEphemeral();
      const hello: HostHello = {
        protocol: PROTOCOL_VERSION,
        instanceId: own.instanceId,
        publicKey: own.publicKeySpkiB64,
        nonce: nonceA,
        ts: Date.now(),
        eph: conn.eph.publicRawB64,
        appVersion: getAppVersion().slice(0, 64),
      };
      conn.stage = 'hello';
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', body: hello }));
    },

    async message(ws: EndpointSocket, message: unknown) {
      const conn = ws.data.federation as HostConn | undefined;
      if (!conn || conn.stage === 'closed') return;
      const raw = typeof message === 'string' ? message : Buffer.from(message as Uint8Array).toString('utf8');
      if (conn.stage === 'open') {
        conn.link?.receive(raw);
        return;
      }
      if (conn.stage !== 'hello') {
        closeConn(conn, CLOSE.auth, 'unexpected frame during the handshake');
        return;
      }
      conn.stage = 'verifying';
      const refusal = await acceptVisitor(conn, raw, maxFrameBytes);
      if (refusal) closeConn(conn, refusal.code, refusal.reason);
    },

    close(ws: EndpointSocket, code?: number, reason?: string) {
      const conn = ws.data.federation as HostConn | undefined;
      if (!conn) return;
      const wasOpen = conn.stage === 'open';
      conn.stage = 'closed';
      settle(conn);
      live.delete(conn);
      if (wasOpen) conn.link?.handleSocketClose(code ?? 1006, reason ?? '');
    },
  });
  log.info('Federation endpoint registered at /federation');
  return true;
}

/** Check the visitor's `hello` and seal the link; a refusal says how to close. */
async function acceptVisitor(conn: HostConn, raw: string, maxFrameBytes: number): Promise<{ code: number; reason: string } | null> {
  const own = conn.identity;
  const eph = conn.eph;
  if (!own || !eph) return { code: CLOSE.auth, reason: 'handshake not started' };

  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return { code: CLOSE.auth, reason: 'malformed hello' };
  }
  const head = frame as { v?: unknown; body?: { protocol?: unknown } } | null;
  if (head?.v !== PROTOCOL_VERSION || head.body?.protocol !== PROTOCOL_VERSION) {
    return { code: CLOSE.protocol, reason: `protocol mismatch: this install speaks ${PROTOCOL_VERSION}` };
  }
  const plain = plainFrameSchema.safeParse(frame);
  const parsed = plain.success && plain.data.type === 'hello' ? visitorHelloSchema.safeParse(plain.data.body) : null;
  if (!parsed?.success) return { code: CLOSE.auth, reason: 'malformed hello' };
  const hello = parsed.data;

  if (instanceIdOf(hello.publicKey) !== hello.instanceId) return { code: CLOSE.auth, reason: 'instance id does not match its key' };
  if (hello.instanceId === own.instanceId) return { code: CLOSE.auth, reason: 'an install does not link to itself' };
  if (Math.abs(Date.now() - hello.ts) > MAX_CLOCK_SKEW_MS) return { code: CLOSE.auth, reason: 'stale timestamp' };

  const fields = {
    nonceA: conn.nonceA, nonceB: hello.nonce, hostId: own.instanceId, visitorId: hello.instanceId,
    hostEph: eph.publicRawB64, visitorEph: hello.eph, ts: hello.ts,
  };
  let signed: boolean;
  try {
    signed = verifyEd25519(hello.publicKey, handshakeTranscript('visitor', fields), Buffer.from(hello.sig, 'base64'));
  } catch {
    signed = false;
  }
  if (!signed) return { code: CLOSE.auth, reason: 'bad signature' };

  const storage = getStorageProvider();
  if ((await storage.takeRaw(hostNonceKey(conn.nonceA))) === null) {
    return { code: CLOSE.auth, reason: 'host nonce already used or expired' };
  }
  if (!(await storage.setRawIfAbsent(visitorNonceKey(hello.instanceId, hello.nonce), '1', NONCE_TTL_SECONDS))) {
    return { code: CLOSE.auth, reason: 'nonce replayed' };
  }

  const [row] = await getDb()
    .select({ status: federationInstances.status })
    .from(federationInstances)
    .where(eq(federationInstances.instanceId, hello.instanceId))
    .limit(1);
  if (row?.status === 'blocked') return { code: CLOSE.forbidden, reason: 'instance blocked' };
  if (!federationHosts()) return { code: CLOSE.forbidden, reason: 'federation off' };
  if (conn.stage !== 'verifying') return null; // closed meanwhile (timeout, mode change)

  let channel: SealedChannel;
  try {
    channel = new SealedChannel(deriveLinkKeys(eph.privateKey, hello.eph, conn.nonceA, hello.nonce), 'host');
  } catch (err) {
    return { code: CLOSE.auth, reason: (err as Error).message };
  }
  const sig = own.sign(handshakeTranscript('host', fields));
  conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'welcome', body: { sig: sig.toString('base64') } }));

  const link = new PeerLink({
    socket: conn.ws.raw,
    channel,
    role: 'host',
    peerInstanceId: hello.instanceId,
    maxFrameBytes,
    heartbeatSeconds: getConfig().federation.heartbeatSeconds,
    onRequest: dispatchHostRequest,
    onClose: (code, reason, closed) => {
      if (inbound.get(closed.peerInstanceId) === closed) inbound.delete(closed.peerInstanceId);
      if (conn.stage !== 'closed') {
        conn.stage = 'closed';
        live.delete(conn);
      }
      log.info({ instanceId: closed.peerInstanceId, code, reason }, 'Federation inbound link closed');
    },
  });
  conn.link = link;
  conn.stage = 'open';
  settle(conn);
  const previous = inbound.get(hello.instanceId);
  inbound.set(hello.instanceId, link);
  previous?.close(CLOSE.normal, 'replaced by a newer link');
  log.info({ instanceId: hello.instanceId, ip: conn.ip, appVersion: hello.appVersion }, 'Federation inbound link open');
  return null;
}

/** Drop all endpoint state (tests). */
export function _resetFederationHostForTests(): void {
  closeInboundLinks(CLOSE.normal, 'reset');
  inbound.clear();
  pendingByIp.clear();
  handshakesByIp.clear();
}
