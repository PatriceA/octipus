/**
 * The guarded outbound dialer (docs/plans/federation-spec.md §5.1, FI6).
 *
 * B always dials A. Every dial, the first and every reconnect:
 *
 *  - resolves the host once and checks each address: public, or inside
 *    `federation.lanCidrs`. Loopback, link-local, private and metadata
 *    addresses are refused unless that list names them (the reuse of
 *    `utils/sanitize.ts`'s ranges is deliberate: one definition of
 *    "private");
 *  - requires `wss:`, unless the address it connects to is in `lanCidrs`;
 *  - connects to the checked address only — the socket's `lookup` is pinned
 *    to it, as `fetchPinned` does, so a second resolution cannot rebind it —
 *    while TLS still verifies the hostname;
 *  - follows no redirect: a 3xx to the upgrade is a failed dial.
 *
 * `dialPeer` then runs the visitor half of the handshake (§5.3) against the
 * pinned host fingerprint and hands back a sealed `PeerLink`.
 */
import { randomBytes } from 'node:crypto';
import dns from 'node:dns';
import WebSocket from 'ws';
import { getConfig } from '@/config';
import { addressInList, parseAddressList } from '@/security/client-ip';
import { getAppVersion } from '@/utils/version';
import { isIpLiteral, isPrivateIP, looksLikeNonStandardIpLiteral, pinnedLookup } from '@/utils/sanitize';
import { type InstanceIdentity, instanceIdOf, verifyEd25519 } from './identity';
import { PeerLink, type PeerLinkOptions, sealedWireLimit } from './link';
import {
  CLOSE,
  closeReason,
  type HostHello,
  hostHelloSchema,
  MAX_HANDSHAKE_FRAME_BYTES,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  plainFrameSchema,
  type VisitorHello,
  welcomeSchema,
} from './protocol';
import { deriveLinkKeys, generateEphemeral, type HandshakeFields, handshakeTranscript, SealedChannel } from './seal';

/** How long the whole handshake may take, connect included. */
export const DIAL_HANDSHAKE_TIMEOUT_MS = 10_000;

export type DialErrorCode =
  | 'bad_url'
  | 'address_refused'
  | 'tls_required'
  | 'unresolvable'
  | 'connect_failed'
  | 'handshake_failed';

export class DialError extends Error {
  constructor(readonly code: DialErrorCode, message: string, readonly closeCode?: number) {
    super(message);
    this.name = 'DialError';
  }
}

export type Resolver = (hostname: string) => Promise<string[]>;

/** Every address the system resolver gives, both families (honours /etc/hosts). */
const systemResolver: Resolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface VetOptions {
  /** Defaults to `federation.lanCidrs`. */
  lanCidrs?: readonly string[];
  /** Defaults to the system resolver. */
  resolve?: Resolver;
}

/**
 * Check a peer URL and pick the one address the socket will connect to.
 * Throws `DialError` for anything the dialer refuses.
 */
export async function vetDialTarget(rawUrl: string, opts: VetOptions = {}): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DialError('bad_url', `Not a URL: ${rawUrl}`);
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new DialError('bad_url', `A peer link is ws:// or wss://, not ${url.protocol}`);
  }
  if (url.username || url.password) throw new DialError('bad_url', 'A peer URL carries no credentials');

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (looksLikeNonStandardIpLiteral(hostname)) {
    throw new DialError('address_refused', `Ambiguous IP literal not allowed: ${hostname}`);
  }
  let addresses: string[];
  if (isIpLiteral(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (opts.resolve ?? systemResolver)(hostname);
    } catch (err) {
      throw new DialError('unresolvable', `Could not resolve ${hostname}: ${(err as Error).message}`);
    }
    if (addresses.length === 0) throw new DialError('unresolvable', `Could not resolve ${hostname}`);
  }

  const lan = parseAddressList(opts.lanCidrs ?? getConfig().federation.lanCidrs, 'federation.lanCidrs');
  for (const address of addresses) {
    if (isPrivateIP(address) && !addressInList(lan, address)) {
      throw new DialError('address_refused', `${hostname} resolves to ${address}, a private or reserved address outside federation.lanCidrs`);
    }
  }
  const address = addresses[0];
  if (url.protocol === 'ws:' && !addressInList(lan, address)) {
    throw new DialError('tls_required', `Plain ws:// is allowed only inside federation.lanCidrs; use wss:// for ${hostname}`);
  }
  return { url, address };
}

export interface GuardedSocket {
  socket: WebSocket;
  /**
   * Hand the frames over: those that arrived with the upgrade response (the
   * host speaks first, often in the same packet as the 101) are replayed into
   * `onMessage`, and every later one goes there directly.
   */
  attach(onMessage: (raw: string) => void): void;
}

const frameText = (data: WebSocket.RawData, isBinary: boolean): string =>
  isBinary ? Buffer.from(data as Buffer).toString('utf8') : data.toString();

/**
 * Open a socket to a vetted target, pinned to its address, following no
 * redirect. Resolves once the upgrade succeeded.
 */
export async function openGuardedSocket(
  rawUrl: string,
  opts: VetOptions & { maxPayload: number; timeoutMs?: number },
): Promise<GuardedSocket> {
  const { url, address } = await vetDialTarget(rawUrl, opts);
  const socket = new WebSocket(url.href, {
    lookup: pinnedLookup(address),
    followRedirects: false,
    maxPayload: opts.maxPayload,
    perMessageDeflate: false,
    handshakeTimeout: opts.timeoutMs ?? DIAL_HANDSHAKE_TIMEOUT_MS,
  });
  const early: string[] = [];
  const buffer = (data: WebSocket.RawData, isBinary: boolean) => { early.push(frameText(data, isBinary)); };
  socket.on('message', buffer);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    // A 3xx (or any non-101) answer surfaces here as "Unexpected server response".
    socket.once('error', (err) => reject(new DialError('connect_failed', `Could not open ${url.origin}: ${err.message}`)));
  });
  return {
    socket,
    attach(onMessage) {
      socket.off('message', buffer);
      socket.on('message', (data, isBinary) => onMessage(frameText(data, isBinary)));
      for (const raw of early.splice(0)) onMessage(raw);
    },
  };
}

export interface DialPeerOptions extends VetOptions {
  identity: InstanceIdentity;
  /** Defaults to `gateway.maxFrameBytes`. */
  maxFrameBytes?: number;
  /** Defaults to `federation.heartbeatSeconds`. */
  heartbeatSeconds?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  onRequest: PeerLinkOptions['onRequest'];
  onEvent?: PeerLinkOptions['onEvent'];
  onClose?: PeerLinkOptions['onClose'];
}

/**
 * Dial the host at `url`, whose instance id must be `expectedInstanceId`
 * (the fingerprint from the invite), and complete the handshake. Rejects
 * with `DialError`; `closeCode` carries the host's refusal (4401, 4403,
 * 4409, 4429) when it closed the socket.
 */
export async function dialPeer(url: string, expectedInstanceId: string, opts: DialPeerOptions): Promise<PeerLink> {
  const cfg = getConfig();
  const maxFrameBytes = opts.maxFrameBytes ?? cfg.gateway.maxFrameBytes;
  const timeoutMs = opts.timeoutMs ?? DIAL_HANDSHAKE_TIMEOUT_MS;
  const guarded = await openGuardedSocket(url, { ...opts, maxPayload: sealedWireLimit(maxFrameBytes), timeoutMs });
  const socket = guarded.socket;
  const identity = opts.identity;

  return new Promise<PeerLink>((resolve, reject) => {
    let stage: 'hello' | 'welcome' | 'open' | 'failed' = 'hello';
    let hostHello: HostHello | null = null;
    let fields: HandshakeFields | null = null;
    let eph: ReturnType<typeof generateEphemeral> | null = null;
    let link: PeerLink | null = null;

    const fail = (closeCode: number, reason: string): void => {
      if (stage === 'failed' || stage === 'open') return;
      stage = 'failed';
      clearTimeout(timer);
      try {
        socket.close(closeCode, closeReason(reason));
      } finally {
        // Settle whatever the close does: the caller is never left waiting.
        reject(new DialError('handshake_failed', `Handshake with ${url} failed: ${reason}`, closeCode));
      }
    };
    const timer = setTimeout(() => fail(CLOSE.auth, 'handshake timeout'), timeoutMs);

    const onMessage = (raw: string): void => {
      if (stage === 'open') {
        link?.receive(raw);
        return;
      }
      if (stage === 'failed') return;
      if (Buffer.byteLength(raw, 'utf8') > MAX_HANDSHAKE_FRAME_BYTES) {
        fail(CLOSE.auth, 'handshake frame too large');
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        fail(CLOSE.auth, 'malformed handshake frame');
        return;
      }
      const version = (frame as { v?: unknown; body?: { protocol?: unknown } } | null);
      if (version?.v !== PROTOCOL_VERSION || (stage === 'hello' && version.body?.protocol !== PROTOCOL_VERSION)) {
        fail(CLOSE.protocol, `protocol mismatch: this install speaks ${PROTOCOL_VERSION}`);
        return;
      }
      const plain = plainFrameSchema.safeParse(frame);
      if (!plain.success) {
        fail(CLOSE.auth, 'malformed handshake frame');
        return;
      }

      if (stage === 'hello') {
        const hello = plain.data.type === 'hello' ? hostHelloSchema.safeParse(plain.data.body) : null;
        if (!hello?.success) {
          fail(CLOSE.auth, 'expected the host hello');
          return;
        }
        if (hello.data.instanceId !== expectedInstanceId || instanceIdOf(hello.data.publicKey) !== expectedInstanceId) {
          fail(CLOSE.auth, 'host fingerprint does not match the pinned instance');
          return;
        }
        hostHello = hello.data;
        eph = generateEphemeral();
        const nonceB = randomBytes(NONCE_BYTES).toString('base64');
        const ts = Date.now();
        const appVersion = getAppVersion().slice(0, 64);
        fields = {
          protocol: PROTOCOL_VERSION, nonceA: hostHello.nonce, nonceB, hostId: hostHello.instanceId, visitorId: identity.instanceId,
          hostEph: hostHello.eph, visitorEph: eph.publicRawB64, ts, hostAppVersion: hostHello.appVersion, visitorAppVersion: appVersion,
        };
        const sig = identity.sign(handshakeTranscript('visitor', fields));
        const sent: VisitorHello = {
          protocol: PROTOCOL_VERSION,
          instanceId: identity.instanceId,
          publicKey: identity.publicKeySpkiB64,
          nonce: nonceB,
          ts,
          eph: eph.publicRawB64,
          appVersion,
          sig: sig.toString('base64'),
        };
        stage = 'welcome';
        socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'hello', body: sent }));
        return;
      }

      // stage === 'welcome'
      const welcome = plain.data.type === 'welcome' ? welcomeSchema.safeParse(plain.data.body) : null;
      if (!welcome?.success || !hostHello || !fields || !eph) {
        fail(CLOSE.auth, 'expected the host welcome');
        return;
      }
      const expected = handshakeTranscript('host', fields);
      if (!verifyEd25519(hostHello.publicKey, expected, Buffer.from(welcome.data.sig, 'base64'))) {
        fail(CLOSE.auth, 'host signature does not verify');
        return;
      }
      let channel: SealedChannel;
      try {
        channel = new SealedChannel(deriveLinkKeys(eph.privateKey, hostHello.eph, fields), 'visitor');
      } catch (err) {
        fail(CLOSE.auth, (err as Error).message);
        return;
      }
      stage = 'open';
      clearTimeout(timer);
      link = new PeerLink({
        socket,
        channel,
        role: 'visitor',
        peerInstanceId: hostHello.instanceId,
        // The pinned host's key (its id was checked against it above): the
        // visitor records it with the spaces it joins there.
        peerPublicKey: hostHello.publicKey,
        maxFrameBytes,
        heartbeatSeconds: opts.heartbeatSeconds ?? cfg.federation.heartbeatSeconds,
        requestTimeoutMs: opts.requestTimeoutMs,
        onRequest: opts.onRequest,
        onEvent: opts.onEvent,
        onClose: opts.onClose,
      });
      resolve(link);
    };

    socket.on('close', (code, reason) => {
      if (stage === 'open') {
        link?.handleSocketClose(code, reason.toString('utf8'));
        return;
      }
      if (stage === 'failed') return;
      stage = 'failed';
      clearTimeout(timer);
      reject(new DialError('handshake_failed', `Host closed the handshake: ${code} ${reason.toString('utf8')}`, code));
    });
    socket.on('error', (err) => {
      if (stage === 'open') return; // 'close' follows and closes the link
      fail(CLOSE.auth, `socket error: ${err.message}`);
    });
    guarded.attach(onMessage);
  });
}

