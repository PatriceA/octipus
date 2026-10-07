/**
 * The host endpoint `/federation` (docs/plans/federation-spec.md §5.1, §5.3).
 *
 * Registered next to `/gateway` on every install, whatever `federation.mode`
 * says: while this install does not host, every socket is refused right after
 * the upgrade (4403), so turning hosting on applies without a restart, and
 * turning it off closes every inbound link.
 *
 * WebSocket upgrades bypass the HTTP hooks, so the endpoint bounds itself.
 * Addresses are counted per IPv4 address or per IPv6 /64 (one host owns a
 * whole /64, so counting single v6 addresses would bound nothing):
 *
 *  - before the handshake: at most 10 sockets per address and 256 in all, at
 *    most 30 handshakes per address per minute, 5 seconds to finish one, and
 *    no plain frame over 4 KiB (refused before it is parsed);
 *  - sealed links: at most 16 per address and 1024 in all, and at most 64
 *    from instances with no `federation_instances` row — those have joined
 *    nothing here, so they may only ask `space.join` (anything else is
 *    `not_found`, FI1) until a join writes their row;
 *  - the budgets are swept every minute, so addresses that went quiet do not
 *    accumulate.
 *
 * Plain `ws://` is accepted only from a client address inside
 * `federation.lanCidrs`; anything else must arrive through a trusted proxy
 * whose (rightmost) `X-Forwarded-Proto` says it terminated TLS. A trusted
 * proxy that names no client says nothing about where the peer is, so its own
 * address never counts as a LAN client.
 *
 * The handshake (host side):
 *
 *  1. send `hello { protocol, instanceId, publicKey, nonce: nA, ts, eph: xA, appVersion }`;
 *     `nA` lives in this socket's state only: one hello per socket, so it
 *     cannot be used twice;
 *  2. check the visitor's `hello`: protocol (4409), `instanceIdOf(publicKey)`,
 *     ts within ±60 s, its signature over T("visitor", …), then that `nB` was
 *     never seen (recorded in the key-value store only once the signature
 *     verified, so unsigned noise cannot fill it) (4401), and that its
 *     instance is not blocked (4403);
 *  3. answer `welcome { sig: sign(T("host", …)) }` and seal the link.
 *
 * No `federation_instances` row is written here: an instance exists for the
 * host from its first successful `space.join` (§6.2), not from a handshake.
 *
 * Requests on a sealed link go to the handlers registered with
 * `registerHostHandler`; a type with no handler is answered `unsupported`.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { eq } from 'drizzle-orm';
import type { Elysia } from '@/api/http';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { federationInstances } from '@/db/schema/federation';
import { getStorageProvider } from '@/db/storage';
import { addressInList, clientIp, isTrustedProxy, normalizeAddress, parseAddressList } from '@/security/client-ip';
import { logger } from '@/utils/logger';
import { ipv6Groups } from '@/utils/sanitize';
import { getAppVersion } from '@/utils/version';
import { getInstanceIdentity, type InstanceIdentity, instanceIdOf, verifyEd25519 } from './identity';
import { type LinkSocket, LinkRequestError, PeerLink, sealedWireLimit } from './link';
import { federationHosts, onFederationModeChanged } from './mode';
import {
  CLOSE,
  closeReason,
  type FederationRequestType,
  type HostHello,
  type LinkRequest,
  MAX_HANDSHAKE_FRAME_BYTES,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  plainFrameSchema,
  visitorHelloSchema,
} from './protocol';
import { deriveLinkKeys, type EphemeralKey, generateEphemeral, type HandshakeFields, handshakeTranscript, SealedChannel } from './seal';

const log = logger.child({ component: 'federation-host' });

/** Sockets from one address that have not finished the handshake. */
export const MAX_PENDING_PER_IP = 10;
/** Sockets from all addresses that have not finished the handshake. */
export const MAX_PENDING_TOTAL = 256;
/** Handshakes one address may start per minute. */
export const MAX_HANDSHAKES_PER_IP_PER_MINUTE = 30;
/** Sealed links from one address. */
export const MAX_OPEN_LINKS_PER_IP = 16;
/** Sealed links in all. */
export const MAX_OPEN_LINKS = 1024;
/** Sealed links from instances with no `federation_instances` row. */
export const MAX_UNKNOWN_LINKS = 64;
/** Time a peer has to finish the handshake. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** Largest clock difference a visitor's `hello` may carry. */
export const MAX_CLOCK_SKEW_MS = 60_000;
/** Lifetime of a recorded handshake nonce. */
const NONCE_TTL_SECONDS = 120;
/** How often the per-address budgets drop addresses that went quiet. */
const SWEEP_INTERVAL_MS = 60_000;

const visitorNonceKey = (instanceId: string, nonce: string) => `federation:nonce:visitor:${instanceId}:${nonce}`;

const DEFAULT_LIMITS = {
  pendingPerIp: MAX_PENDING_PER_IP,
  pendingTotal: MAX_PENDING_TOTAL,
  handshakesPerIpPerMinute: MAX_HANDSHAKES_PER_IP_PER_MINUTE,
  openLinksPerIp: MAX_OPEN_LINKS_PER_IP,
  openLinks: MAX_OPEN_LINKS,
  unknownLinks: MAX_UNKNOWN_LINKS,
};
export type FederationHostLimits = typeof DEFAULT_LIMITS;
const limits: FederationHostLimits = { ...DEFAULT_LIMITS };

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

/** What a link from an instance with no `federation_instances` row may ask. */
const OPEN_TO_UNKNOWN: ReadonlySet<string> = new Set(['ping', 'space.join']);

async function dispatchHostRequest(request: LinkRequest, link: PeerLink): Promise<unknown> {
  if (unknownLinks.has(link) && !OPEN_TO_UNKNOWN.has(request.type)) {
    // A join since the handshake may have written the row: look again.
    if ((await instanceStatus(link.peerInstanceId)) !== 'active') throw new LinkRequestError('not_found');
    unknownLinks.delete(link);
  }
  const handler = handlers.get(request.type);
  if (!handler) throw new LinkRequestError('unsupported', `unsupported request type ${request.type}`);
  return handler(request.body, { instanceId: link.peerInstanceId, link, as: request.as, conn: request.conn });
}

async function instanceStatus(instanceId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ status: federationInstances.status })
    .from(federationInstances)
    .where(eq(federationInstances.instanceId, instanceId))
    .limit(1);
  return row?.status;
}

// ── Link and socket bookkeeping ──────────────────────────────────

/** The sealed link of each visitor install (one per instance pair, F-D7). */
const inbound = new Map<string, PeerLink>();
/** Sealed links whose instance had no `federation_instances` row (yet). */
const unknownLinks = new Set<PeerLink>();
/** Every socket on the endpoint, handshaken or not, so a mode change reaches all of them. */
const live = new Set<HostConn>();
const pendingByIp = new Map<string, number>();
let pendingTotal = 0;
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
  /** The address bucket the budgets count: the IPv4 address, or the IPv6 /64. */
  bucket: string;
  stage: 'starting' | 'hello' | 'verifying' | 'open' | 'closed';
  pendingCounted: boolean;
  timer: NodeJS.Timeout | null;
  identity: InstanceIdentity | null;
  nonceA: string;
  appVersion: string;
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

/**
 * The budget bucket of a client address: an IPv4 address as is, an IPv6
 * address as its /64 (`2001:db8:1:2::/64`).
 */
export function addressBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

function releasePending(conn: HostConn): void {
  if (!conn.pendingCounted) return;
  conn.pendingCounted = false;
  pendingTotal = Math.max(0, pendingTotal - 1);
  const n = (pendingByIp.get(conn.bucket) ?? 1) - 1;
  if (n <= 0) pendingByIp.delete(conn.bucket);
  else pendingByIp.set(conn.bucket, n);
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
  conn.ws.close(code, closeReason(reason));
}

/** Whether `bucket` may start another handshake now; records it when so. */
function admitHandshake(bucket: string, now: number): 'ok' | 'pending' | 'pending_total' | 'rate' {
  if (pendingTotal >= limits.pendingTotal) return 'pending_total';
  if ((pendingByIp.get(bucket) ?? 0) >= limits.pendingPerIp) return 'pending';
  const recent = (handshakesByIp.get(bucket) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limits.handshakesPerIpPerMinute) {
    handshakesByIp.set(bucket, recent);
    return 'rate';
  }
  recent.push(now);
  handshakesByIp.set(bucket, recent);
  return 'ok';
}

const ADMISSION_REASON = {
  pending: 'too many pending handshakes',
  pending_total: 'too many pending handshakes on this install',
  rate: 'handshake rate exceeded',
} as const;

/**
 * Drop the handshake times older than a minute and the addresses left with
 * none, and recount the pending sockets from the live ones, so the budgets
 * hold only addresses that are active now.
 */
export function sweepFederationHostBudgets(now = Date.now()): void {
  for (const [bucket, times] of handshakesByIp) {
    const recent = times.filter((t) => now - t < 60_000);
    if (recent.length > 0) handshakesByIp.set(bucket, recent);
    else handshakesByIp.delete(bucket);
  }
  pendingByIp.clear();
  pendingTotal = 0;
  for (const conn of live) {
    if (!conn.pendingCounted) continue;
    pendingTotal++;
    pendingByIp.set(conn.bucket, (pendingByIp.get(conn.bucket) ?? 0) + 1);
  }
}

/**
 * Plain `ws://` only from a client inside `federation.lanCidrs`; otherwise
 * the socket must come from a trusted proxy that says, in the value it
 * appended last, that it terminated TLS.
 */
function transportAllowed(ws: EndpointSocket, ip: string): boolean {
  const peer = ws.remoteAddress;
  const viaProxy = !!peer && isTrustedProxy(peer);
  // A trusted proxy that sent no client address leaves `ip` as its own,
  // which says nothing about where the peer is.
  const clientKnown = !viaProxy || ip !== normalizeAddress(peer);
  const lan = parseAddressList(getConfig().federation.lanCidrs, 'federation.lanCidrs');
  if (clientKnown && addressInList(lan, ip)) return true;
  if (!viaProxy) return false;
  // Each proxy appends its own value: the last one is the proxy we trust.
  const proto = ws.data.request.headers.get('x-forwarded-proto')?.split(',').at(-1)?.trim().toLowerCase();
  return proto === 'https' || proto === 'wss';
}

/** How many sealed links are open, in all and from `bucket`, not counting `except`. */
function openLinkCounts(bucket: string, except: PeerLink | undefined): { total: number; fromBucket: number } {
  let total = 0;
  let fromBucket = 0;
  for (const conn of live) {
    if (conn.stage !== 'open' || !conn.link || conn.link === except) continue;
    total++;
    if (conn.bucket === bucket) fromBucket++;
  }
  return { total, fromBucket };
}

let followingMode = false;
let sweepTimer: NodeJS.Timeout | null = null;

export interface FederationEndpointDeps {
  /** The install identity; defaults to the vault one. */
  identity?: () => Promise<InstanceIdentity>;
}

/** Log what a hosting install is missing, and read the identity so a vault failure shows at once. */
function announceHosting(identity: () => Promise<InstanceIdentity>): void {
  if (!getConfig().oauth.publicUrl) {
    log.error('federation.mode hosts but no PUBLIC_URL is set: invite links will carry no federation part');
  }
  identity().then(
    (id) => log.info({ instanceId: id.instanceId }, 'Federation host endpoint ready'),
    (err: unknown) => log.error({ err }, 'Federation host endpoint has no identity: every handshake will be refused'),
  );
}

/**
 * Register `/federation` on the server. Always registered: while this
 * install does not host, every socket is refused with 4403 after the upgrade.
 */
export function setupFederationWebSocket(app: Elysia, deps: FederationEndpointDeps = {}): void {
  const cfg = getConfig();
  const identity = deps.identity ?? getInstanceIdentity;

  if (!followingMode) {
    followingMode = true;
    onFederationModeChanged((next, previous) => {
      if (!federationHosts(next)) closeInboundLinks(CLOSE.forbidden, 'federation off');
      else if (!federationHosts(previous)) announceHosting(identity);
    });
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(() => sweepFederationHostBudgets(), SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }
  if (federationHosts(cfg.federation.mode)) announceHosting(identity);

  const maxFrameBytes = cfg.gateway.maxFrameBytes;

  app.ws('/federation', {
    maxPayload: sealedWireLimit(maxFrameBytes),

    async open(ws: EndpointSocket) {
      const conn: HostConn = {
        ws, ip: 'unknown', bucket: 'unknown', stage: 'starting', pendingCounted: false, timer: null,
        identity: null, nonceA: '', appVersion: '', eph: null, link: null,
      };
      ws.data.federation = conn;
      live.add(conn);
      try {
        await startHandshake(conn, identity);
      } catch (err) {
        log.error({ err, ip: conn.ip }, 'Federation handshake failed to start');
        closeConn(conn, 1011, 'internal error');
      }
    },

    async message(ws: EndpointSocket, message: unknown) {
      const conn = ws.data.federation as HostConn | undefined;
      if (!conn || conn.stage === 'closed') return;
      if (conn.stage === 'open') {
        const raw = typeof message === 'string' ? message : Buffer.from(message as Uint8Array).toString('utf8');
        conn.link?.receive(raw);
        return;
      }
      // Before the link is sealed the peer is nobody: bound what it can make us parse.
      const size = typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : (message as Uint8Array).byteLength;
      if (size > MAX_HANDSHAKE_FRAME_BYTES) {
        closeConn(conn, CLOSE.auth, 'handshake frame too large');
        return;
      }
      if (conn.stage !== 'hello') {
        closeConn(conn, CLOSE.auth, 'unexpected frame during the handshake');
        return;
      }
      const raw = typeof message === 'string' ? message : Buffer.from(message as Uint8Array).toString('utf8');
      conn.stage = 'verifying';
      try {
        const refusal = await acceptVisitor(conn, raw, maxFrameBytes);
        if (refusal) closeConn(conn, refusal.code, refusal.reason);
      } catch (err) {
        log.error({ err, ip: conn.ip }, 'Federation handshake failed');
        closeConn(conn, 1011, 'internal error');
      }
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
}

/** Admit the socket and send the host `hello`; closes the socket itself on a refusal. */
async function startHandshake(conn: HostConn, identity: () => Promise<InstanceIdentity>): Promise<void> {
  const ws = conn.ws;
  conn.ip = clientIp(ws.data.request, ws.remoteAddress);
  conn.bucket = addressBucket(conn.ip);

  if (!federationHosts()) {
    closeConn(conn, CLOSE.forbidden, 'federation off');
    return;
  }
  if (!transportAllowed(ws, conn.ip)) {
    closeConn(conn, CLOSE.forbidden, 'wss required outside federation.lanCidrs');
    return;
  }
  const admitted = admitHandshake(conn.bucket, Date.now());
  if (admitted !== 'ok') {
    closeConn(conn, CLOSE.limit, ADMISSION_REASON[admitted]);
    return;
  }
  pendingByIp.set(conn.bucket, (pendingByIp.get(conn.bucket) ?? 0) + 1);
  pendingTotal++;
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
  conn.identity = own;
  conn.nonceA = randomBytes(NONCE_BYTES).toString('base64');
  conn.appVersion = getAppVersion().slice(0, 64);
  conn.eph = generateEphemeral();
  const hello: HostHello = {
    protocol: PROTOCOL_VERSION,
    instanceId: own.instanceId,
    publicKey: own.publicKeySpkiB64,
    nonce: conn.nonceA,
    ts: Date.now(),
    eph: conn.eph.publicRawB64,
    appVersion: conn.appVersion,
  };
  conn.stage = 'hello';
  ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', body: hello }));
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

  const fields: HandshakeFields = {
    protocol: PROTOCOL_VERSION, nonceA: conn.nonceA, nonceB: hello.nonce, hostId: own.instanceId, visitorId: hello.instanceId,
    hostEph: eph.publicRawB64, visitorEph: hello.eph, ts: hello.ts, hostAppVersion: conn.appVersion, visitorAppVersion: hello.appVersion,
  };
  let signed: boolean;
  try {
    signed = verifyEd25519(hello.publicKey, handshakeTranscript('visitor', fields), Buffer.from(hello.sig, 'base64'));
  } catch {
    signed = false;
  }
  if (!signed) return { code: CLOSE.auth, reason: 'bad signature' };

  if (!(await getStorageProvider().setRawIfAbsent(visitorNonceKey(hello.instanceId, hello.nonce), '1', NONCE_TTL_SECONDS))) {
    return { code: CLOSE.auth, reason: 'nonce replayed' };
  }

  const status = await instanceStatus(hello.instanceId);
  if (status === 'blocked') return { code: CLOSE.forbidden, reason: 'instance blocked' };
  if (!federationHosts()) return { code: CLOSE.forbidden, reason: 'federation off' };
  if (conn.stage !== 'verifying') return null; // closed meanwhile (timeout, mode change)

  // The link this one replaces does not count against the bounds.
  const previous = inbound.get(hello.instanceId);
  const open = openLinkCounts(conn.bucket, previous);
  if (open.total >= limits.openLinks) return { code: CLOSE.limit, reason: 'too many federation links on this install' };
  if (open.fromBucket >= limits.openLinksPerIp) return { code: CLOSE.limit, reason: 'too many federation links from this address' };
  const known = status === 'active';
  if (!known) {
    const others = previous && unknownLinks.has(previous) ? unknownLinks.size - 1 : unknownLinks.size;
    if (others >= limits.unknownLinks) return { code: CLOSE.limit, reason: 'too many links from instances that joined nothing here' };
  }

  let channel: SealedChannel;
  try {
    channel = new SealedChannel(deriveLinkKeys(eph.privateKey, hello.eph, fields), 'host');
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
      unknownLinks.delete(closed);
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
  if (!known) unknownLinks.add(link);
  inbound.set(hello.instanceId, link);
  previous?.close(CLOSE.normal, 'replaced by a newer link');
  log.info({ instanceId: hello.instanceId, ip: conn.ip, appVersion: hello.appVersion, known }, 'Federation inbound link open');
  return null;
}

/** Drop all endpoint state (tests). */
export function _resetFederationHostForTests(): void {
  closeInboundLinks(CLOSE.normal, 'reset');
  inbound.clear();
  unknownLinks.clear();
  pendingByIp.clear();
  pendingTotal = 0;
  handshakesByIp.clear();
  Object.assign(limits, DEFAULT_LIMITS);
}

/** Lower the endpoint's bounds (tests); `_resetFederationHostForTests` restores them. */
export function _setFederationHostLimitsForTests(over: Partial<FederationHostLimits>): void {
  Object.assign(limits, over);
}

/** The budgets' current contents (tests). */
export function _federationHostBudgetsForTests(): { pending: Map<string, number>; pendingTotal: number; handshakes: Map<string, number[]>; unknownLinks: number } {
  return { pending: new Map(pendingByIp), pendingTotal, handshakes: new Map(handshakesByIp), unknownLinks: unknownLinks.size };
}
