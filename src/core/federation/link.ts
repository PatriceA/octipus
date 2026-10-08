/**
 * One sealed peer link, either end (docs/plans/federation-spec.md §5.2, §5.4).
 *
 * Built after the handshake (host-server.ts, dialer.ts) over a socket and a
 * `SealedChannel`, it owns:
 *
 *  - the codec: plaintext `{ id, type, as?, conn?, body }` sealed into
 *    `{ v, s, n, c }`, each plaintext at most `gateway.maxFrameBytes`;
 *  - request/response correlation: every request gets one `result` with
 *    `re` = its id, or times out;
 *  - the heartbeat: a `ping` request every `federation.heartbeatSeconds`,
 *    three missed and the link closes;
 *  - the inbound frame rate (60 per second, on the host: what a visitor asks
 *    of it — a visitor does not count the host's events, which a busy room
 *    produces faster than that and it subscribed to) and the send queue:
 *    queued bytes (`ws.bufferedAmount` plus the link's own queue) above
 *    max(4 MiB, 2 × the largest sealed frame) close the link with 4429, so a
 *    peer that stops reading cannot grow our memory, while one frame at the
 *    configured cap always fits;
 *  - the peer's requests in flight: at most 32 answered at once, any more
 *    are answered `busy` without running, so a peer cannot pile up handlers.
 *
 * A frame that fails to open, or is not the next sequence number, closes the
 * link with 4401 (FI7). Nothing here knows what a request means: the side
 * that built the link answers them (`onRequest`).
 */
import { logger } from '@/utils/logger';
import {
  CLOSE,
  closeReason,
  type LinkError,
  type LinkEvent,
  type LinkMessage,
  type LinkRequest,
  type LinkResult,
  linkEventSchema,
  linkRequestSchema,
  linkResultSchema,
  requestBodySchemas,
  sealedFrameSchema,
} from './protocol';
import { type LinkRole, SealError, type SealedChannel } from './seal';

const log = logger.child({ component: 'federation-link' });

/** The floor of the send-queue cap: queued outbound bytes above which the link is closed (4429). */
export const SEND_QUEUE_CAP_BYTES = 4 * 1024 * 1024;
/** Requests from the peer being answered at once; one more is answered `busy`. */
export const MAX_IN_FLIGHT_REQUESTS = 32;
/** Frames written straight to the socket while its own buffer is below this; above it they wait in the link's queue. */
const SOCKET_HIGH_WATER_BYTES = 1024 * 1024;
/** Inbound frames per second one link may send. */
export const MAX_FRAMES_PER_SECOND = 60;
/** Heartbeats missed in a row before the link is closed. */
export const MAX_MISSED_PINGS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Largest sealed wire frame for a plaintext cap: base64 of plaintext + tag,
 * plus the envelope. The socket's `maxPayload` on both ends.
 */
export function sealedWireLimit(maxFrameBytes: number): number {
  return Math.ceil((maxFrameBytes + 16) / 3) * 4 + 256;
}

/**
 * The send-queue cap for a plaintext cap: 4 MiB, or room for two of the
 * largest sealed frames when `gateway.maxFrameBytes` is set high enough that
 * one frame alone would pass 4 MiB.
 */
export function sendQueueCap(maxFrameBytes: number): number {
  return Math.max(SEND_QUEUE_CAP_BYTES, 2 * sealedWireLimit(maxFrameBytes));
}

/** The subset of a `ws` WebSocket the link writes to. */
export interface LinkSocket {
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

/** A request answered with an error result, or one that never got its answer. */
export class LinkRequestError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'LinkRequestError';
  }

  toWire(): LinkError {
    return this.message && this.message !== this.code ? { code: this.code, message: this.message.slice(0, 1000) } : { code: this.code };
  }
}

export interface PeerLinkOptions {
  socket: LinkSocket;
  channel: SealedChannel;
  role: LinkRole;
  /** The peer's verified instance id. */
  peerInstanceId: string;
  /** The peer's Ed25519 public key (SPKI DER base64) the handshake verified; the host records it on a join. */
  peerPublicKey?: string;
  /** Largest plaintext either way (`gateway.maxFrameBytes`). */
  maxFrameBytes: number;
  heartbeatSeconds: number;
  requestTimeoutMs?: number;
  /** Answer a request from the peer; throw `LinkRequestError` for an error result. */
  onRequest: (request: LinkRequest, link: PeerLink) => Promise<unknown>;
  /** A host event (visitor side only). */
  onEvent?: (event: LinkEvent, link: PeerLink) => void;
  onClose?: (code: number, reason: string, link: PeerLink) => void;
}

interface Pending {
  resolve: (body: unknown) => void;
  reject: (err: LinkRequestError) => void;
  timer: NodeJS.Timeout;
}

export class PeerLink {
  readonly role: LinkRole;
  readonly peerInstanceId: string;
  readonly peerPublicKey: string | null;
  private readonly socket: LinkSocket;
  private readonly channel: SealedChannel;
  private readonly opts: PeerLinkOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly queue: string[] = [];
  private queueBytes = 0;
  private nextId = 0;
  private closedWith: { code: number; reason: string } | null = null;
  private rateWindowStart = 0;
  private rateCount = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private awaitingPong = false;
  private missedPings = 0;
  private inFlight = 0;
  private readonly queueCap: number;

  constructor(opts: PeerLinkOptions) {
    this.opts = opts;
    this.role = opts.role;
    this.peerInstanceId = opts.peerInstanceId;
    this.peerPublicKey = opts.peerPublicKey ?? null;
    this.socket = opts.socket;
    this.channel = opts.channel;
    this.queueCap = sendQueueCap(opts.maxFrameBytes);
    this.heartbeat = setInterval(() => this.beat(), opts.heartbeatSeconds * 1000);
    this.heartbeat.unref();
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  /** How the link closed, once it has. */
  get closeInfo(): { code: number; reason: string } | null {
    return this.closedWith;
  }

  /** Outbound bytes not yet handed to the kernel: the socket's buffer plus the link's queue. */
  queuedBytes(): number {
    return this.socket.bufferedAmount + this.queueBytes;
  }

  /** Send a request and wait for its result body. Rejects with `LinkRequestError`. */
  request(type: string, body: unknown, opts: { as?: string; conn?: string; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closedWith) return Promise.reject(new LinkRequestError('link_closed', `link closed (${this.closedWith.code})`));
    const id = this.newId();
    const message: LinkRequest = { id, type, body, ...(opts.as !== undefined ? { as: opts.as } : {}), ...(opts.conn !== undefined ? { conn: opts.conn } : {}) };
    return new Promise((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkRequestError('timeout', `${type} got no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(message);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof LinkRequestError ? err : new LinkRequestError('send_failed', (err as Error).message));
      }
    });
  }

  /** Send a host event to the visitor's connection `conn`. False when the link is closed. */
  sendEvent(as: string, conn: string, body: unknown): boolean {
    if (this.closedWith) return false;
    return this.write({ id: this.newId(), type: 'event', as, conn, body });
  }

  /** Feed one wire frame received on the socket. */
  receive(raw: string): void {
    if (this.closedWith) return;
    const now = Date.now();
    if (now - this.rateWindowStart >= 1000) {
      this.rateWindowStart = now;
      this.rateCount = 0;
    }
    if (this.role === 'host' && ++this.rateCount > MAX_FRAMES_PER_SECOND) {
      this.close(CLOSE.limit, 'frame rate exceeded');
      return;
    }

    let plaintext: Buffer;
    try {
      const frame = sealedFrameSchema.safeParse(JSON.parse(raw));
      if (!frame.success) {
        this.close(CLOSE.auth, 'malformed sealed frame');
        return;
      }
      plaintext = this.channel.open(frame.data);
    } catch (err) {
      this.close(CLOSE.auth, err instanceof SealError ? err.message : 'malformed sealed frame');
      return;
    }
    if (plaintext.length > this.opts.maxFrameBytes) {
      this.close(CLOSE.limit, 'frame too large');
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString('utf8'));
    } catch {
      this.close(CLOSE.auth, 'malformed message');
      return;
    }
    const result = linkResultSchema.safeParse(json);
    if (result.success) {
      this.settle(result.data);
      return;
    }
    const event = linkEventSchema.safeParse(json);
    if (event.success) {
      if (this.role !== 'visitor' || !this.opts.onEvent) {
        this.close(CLOSE.auth, 'unexpected event');
        return;
      }
      try {
        this.opts.onEvent(event.data, this);
      } catch (err) {
        log.error({ err, peer: this.peerInstanceId }, 'Federation event handler failed');
      }
      return;
    }
    const request = linkRequestSchema.safeParse(json);
    if (request.success) {
      void this.answer(request.data);
      return;
    }
    this.close(CLOSE.auth, 'malformed message');
  }

  /** Close the link and the socket. Idempotent. */
  close(code: number, reason: string): void {
    if (this.closedWith) return;
    this.finish(code, reason);
    try {
      this.socket.close(code, closeReason(reason));
    } catch (err) {
      log.warn({ err, peer: this.peerInstanceId }, 'Federation socket close failed');
    }
  }

  /** The socket closed under us (the peer, or the network). */
  handleSocketClose(code: number, reason: string): void {
    if (this.closedWith) return;
    this.finish(code, reason);
  }

  private finish(code: number, reason: string): void {
    this.closedWith = { code, reason };
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.queue.length = 0;
    this.queueBytes = 0;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new LinkRequestError('link_closed', `link closed (${code} ${reason})`));
      this.pending.delete(id);
    }
    log.info({ peer: this.peerInstanceId, role: this.role, code, reason }, 'Federation link closed');
    this.opts.onClose?.(code, reason, this);
  }

  private newId(): string {
    return `${this.role === 'host' ? 'h' : 'v'}${(this.nextId++).toString(36)}`;
  }

  private settle(result: LinkResult): void {
    const p = this.pending.get(result.re);
    // A late answer to a request that already timed out: nothing waits for it.
    if (!p) return;
    this.pending.delete(result.re);
    clearTimeout(p.timer);
    if (result.ok) p.resolve(result.body);
    else p.reject(new LinkRequestError(result.error.code, result.error.message));
  }

  private async answer(request: LinkRequest): Promise<void> {
    if (this.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      this.write({ id: this.newId(), type: 'result', re: request.id, ok: false, error: { code: 'busy', message: `more than ${MAX_IN_FLIGHT_REQUESTS} requests in flight` } });
      return;
    }
    this.inFlight++;
    let reply: LinkMessage;
    try {
      const known = requestBodySchemas[request.type as keyof typeof requestBodySchemas];
      if (known && !known.safeParse(request.body).success) {
        throw new LinkRequestError('bad_request', `malformed ${request.type} body`);
      }
      const body = await this.opts.onRequest(request, this);
      reply = { id: this.newId(), type: 'result', re: request.id, ok: true, body: body ?? null };
    } catch (err) {
      if (!(err instanceof LinkRequestError)) {
        log.error({ err, peer: this.peerInstanceId, type: request.type }, 'Federation request handler failed');
      }
      const error = err instanceof LinkRequestError ? err.toWire() : { code: 'internal' };
      reply = { id: this.newId(), type: 'result', re: request.id, ok: false, error };
    } finally {
      this.inFlight--;
    }
    if (this.closedWith) return;
    try {
      this.write(reply);
    } catch (err) {
      if (!(err instanceof LinkRequestError)) throw err;
      // The answer itself is over the frame cap: say so instead.
      this.write({ id: this.newId(), type: 'result', re: request.id, ok: false, error: err.toWire() });
    }
  }

  /**
   * Seal and send one message. Throws `LinkRequestError('too_large')` for a
   * plaintext over the cap; returns false when the link is (or just got)
   * closed, which a full send queue does.
   */
  private write(message: LinkMessage): boolean {
    if (this.closedWith) return false;
    const plaintext = Buffer.from(JSON.stringify(message), 'utf8');
    if (plaintext.length > this.opts.maxFrameBytes) {
      throw new LinkRequestError('too_large', `frame of ${plaintext.length} bytes is over the ${this.opts.maxFrameBytes}-byte cap`);
    }
    // Sealed now, in send order: the sequence number is the queue position.
    const wire = JSON.stringify(this.channel.seal(plaintext));
    if (this.queuedBytes() + wire.length > this.queueCap) {
      this.close(CLOSE.limit, 'send queue full');
      return false;
    }
    if (this.queue.length === 0 && this.socket.bufferedAmount < SOCKET_HIGH_WATER_BYTES) {
      this.socket.send(wire, (err) => this.written(err));
    } else {
      this.queue.push(wire);
      this.queueBytes += wire.length;
    }
    return true;
  }

  /** A write reached the kernel (or failed): move queued frames into the socket while it has room. */
  private written(err?: Error): void {
    if (err) {
      if (!this.closedWith) log.warn({ err, peer: this.peerInstanceId }, 'Federation socket write failed');
      return;
    }
    while (!this.closedWith && this.queue.length > 0 && this.socket.bufferedAmount < SOCKET_HIGH_WATER_BYTES) {
      const wire = this.queue.shift() as string;
      this.queueBytes -= wire.length;
      this.socket.send(wire, (e) => this.written(e));
    }
  }

  private beat(): void {
    if (this.closedWith) return;
    if (this.awaitingPong && ++this.missedPings >= MAX_MISSED_PINGS) {
      this.close(CLOSE.normal, 'heartbeat timeout');
      return;
    }
    this.awaitingPong = true;
    this.request('ping', {}, { timeoutMs: this.opts.heartbeatSeconds * 1000 * MAX_MISSED_PINGS }).then(
      () => {
        this.awaitingPong = false;
        this.missedPings = 0;
      },
      (err: LinkRequestError) => {
        if (err.code !== 'link_closed' && err.code !== 'timeout') {
          log.warn({ err, peer: this.peerInstanceId }, 'Federation heartbeat refused');
        }
      },
    );
  }
}
