/**
 * The visitor's link pool (docs/plans/federation-spec.md §5.4, §8.2).
 *
 * One link per host install, shared by every user here who joined a space
 * there. A link opens on demand (the first request to that host), through the
 * guarded dialer against the host's pinned instance id. While something keeps
 * a host retained — a local user with one of its spaces open, an agent turn
 * that needs it — a dropped link is redialled with exponential backoff (1 s
 * up to 60 s, with jitter); every redial goes through the dialer's checks
 * again. The backoff starts over only once a link stayed up 30 s, so a host
 * that accepts and drops at once is not redialled in a tight loop.
 *
 * A host that refuses us outright — blocked or federation off there (4403),
 * another protocol version (4409) — is not redialled: retrying cannot help.
 * The next explicit `retain` or request to it tries again.
 *
 * Turning visiting off closes every outbound link of the pool and stops the
 * redials; the retainers stay counted, so turning it back on redials every
 * host still retained. A dial that completes after visiting went off (or
 * after `closeAll`) is closed instead of handed out.
 *
 * A host's address is learned from requests, but only an address a
 * handshake completed on is kept (`goodUrl`): once one is known, a request
 * naming another address (a forged invite naming the host's fingerprint,
 * say) may try it while the link is down, and it replaces the known one only
 * if the pinned host answers there. Redials always use the last good one.
 *
 * Frames name the visitor (`as`, the stored member handle) and the local
 * client connection (`conn`); visitor-ops.ts fills them. Host events reach
 * the callbacks subscribed for that host, link up/down the `onLinkState`
 * listeners.
 */
import { logger } from '@/utils/logger';
import { DialError, type DialPeerOptions, dialPeer } from './dialer';
import { getInstanceIdentity, type InstanceIdentity } from './identity';
import { LinkRequestError, type PeerLink } from './link';
import { federationVisits, onFederationModeChanged } from './mode';
import { CLOSE, type FederationRequestType, type LinkEvent, type LinkRequest } from './protocol';

const log = logger.child({ component: 'federation-visitor' });

/** Where a host install is reached, and who it must prove to be. */
export interface HostAddress {
  /** The pinned instance id (from the invite's fingerprint). */
  instanceId: string;
  /** Its peer endpoint, `wss://<host>/federation`. */
  url: string;
}

export type LinkState = 'up' | 'down';
export type HostEventListener = (event: LinkEvent) => void;

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** A link up this long counts as stable: the backoff starts over after it drops. */
export const STABLE_LINK_MS = 30_000;

/** Close codes after which redialling cannot help: blocked or federation off (4403), another protocol (4409). */
const FINAL_CLOSE_CODES: ReadonlySet<number> = new Set([CLOSE.forbidden, CLOSE.protocol]);

/**
 * Delay before redial number `attempt` (0-based): exponential from `baseMs`,
 * capped at `maxMs`, with the upper half jittered so a host that restarts is
 * not redialled by every visitor in the same instant.
 */
export function reconnectDelay(attempt: number, rand: () => number = Math.random, baseMs = RECONNECT_BASE_MS, maxMs = RECONNECT_MAX_MS): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + rand() * (ceiling / 2));
}

interface Entry {
  /** The pinned id, and the address redials use: the last good one once known. */
  host: HostAddress;
  /** The last address a handshake completed on, if any. */
  goodUrl: string | null;
  link: PeerLink | null;
  connecting: Promise<PeerLink> | null;
  retainers: number;
  attempt: number;
  retry: NodeJS.Timeout | null;
  listeners: Set<HostEventListener>;
  /** When the current link came up. */
  upSince: number;
  /** The host refused us for good (4403, 4409): no redial until an explicit retain or request. */
  refused: boolean;
  /** `closeAll` stopped the redials: none until visiting comes back on or an explicit retain or request. */
  halted: boolean;
}

export interface VisitorLinkPoolOptions {
  /** The install identity; defaults to the vault one. */
  identity?: () => Promise<InstanceIdentity>;
  /** Dialer options other than the identity and callbacks (tests: lanCidrs, resolver, heartbeat). */
  dial?: Omit<Partial<DialPeerOptions>, 'identity' | 'onRequest' | 'onEvent' | 'onClose'>;
  /** Backoff bounds for redials, and how long a link must stay up to reset them. */
  reconnect?: { baseMs: number; maxMs: number; stableMs?: number };
  /** Link up/down, per host. */
  onLinkState?: (hostInstanceId: string, state: LinkState) => void;
}

export class VisitorLinkPool {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: VisitorLinkPoolOptions;
  private readonly stateListeners = new Set<(hostInstanceId: string, state: LinkState) => void>();
  private readonly stopFollowingMode: () => void;
  /** Bumped by `closeAll`: a dial started before it is closed when it completes. */
  private generation = 0;
  private disposed = false;

  constructor(opts: VisitorLinkPoolOptions = {}) {
    this.opts = opts;
    this.stopFollowingMode = onFederationModeChanged((next, previous) => {
      if (!federationVisits(next)) this.closeAll(CLOSE.forbidden, 'federation off');
      else if (!federationVisits(previous)) this.resume();
    });
  }

  /** Close every link and stop following mode changes. */
  dispose(): void {
    this.disposed = true;
    this.stopFollowingMode();
    this.closeAll(CLOSE.normal, 'shutting down');
  }

  /**
   * Follow link up/down for every host (the visitor operations: tombstones,
   * `remote.link`, resubscription). Returns the unsubscribe.
   */
  onLinkState(listener: (hostInstanceId: string, state: LinkState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  private announce(hostInstanceId: string, state: LinkState): void {
    this.opts.onLinkState?.(hostInstanceId, state);
    for (const listener of this.stateListeners) {
      try {
        listener(hostInstanceId, state);
      } catch (err) {
        log.error({ err, host: hostInstanceId, state }, 'Federation link-state listener failed');
      }
    }
  }

  /** Whether the link to `hostInstanceId` is open. */
  state(hostInstanceId: string): LinkState {
    const link = this.entries.get(hostInstanceId)?.link;
    return link && !link.closed ? 'up' : 'down';
  }

  /**
   * The open link to `host`, dialling it when there is none. An address
   * other than the last good one is tried for this call only: it becomes the
   * host's address once the pinned host completed a handshake there.
   */
  link(host: HostAddress): Promise<PeerLink> {
    const entry = this.entry(host);
    // An explicit request tries again even after a refusal or `closeAll`.
    entry.refused = false;
    entry.halted = false;
    return this.connect(entry, host.url || undefined);
  }

  /** Send a request to `host` and wait for its result. Rejects with `LinkRequestError` or a dial error. */
  async request(
    host: HostAddress,
    type: FederationRequestType,
    body: unknown,
    opts: { as?: string; conn?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const link = await this.link(host);
    return link.request(type, body, opts);
  }

  /** Receive the events `hostInstanceId` sends. Returns the unsubscribe. */
  subscribe(hostInstanceId: string, listener: HostEventListener): () => void {
    const entry = this.entries.get(hostInstanceId) ?? this.entry({ instanceId: hostInstanceId, url: '' });
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }

  /**
   * Keep the link to `host` up: dial now, and redial with backoff whenever
   * it drops, until every retainer has released it.
   */
  retain(host: HostAddress): () => void {
    const entry = this.entry(host);
    entry.retainers++;
    entry.refused = false;
    entry.halted = false;
    if (!entry.link || entry.link.closed) this.scheduleRedial(entry, 0, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.retainers--;
      if (entry.retainers <= 0 && entry.retry) {
        clearTimeout(entry.retry);
        entry.retry = null;
      }
    };
  }

  /** The address redials of `hostInstanceId` use (tests, diagnostics). */
  hostUrl(hostInstanceId: string): string | null {
    return this.entries.get(hostInstanceId)?.host.url || null;
  }

  /** How many retainers hold `hostInstanceId` (tests, diagnostics). */
  retainerCount(hostInstanceId: string): number {
    return this.entries.get(hostInstanceId)?.retainers ?? 0;
  }

  /**
   * Close every link and stop redialling (visiting turned off, shutdown).
   * Retainers stay counted: their holders have not released them, and
   * `resume` redials what they hold.
   */
  closeAll(code: number, reason: string): void {
    this.generation++;
    for (const entry of this.entries.values()) {
      entry.halted = true;
      if (entry.retry) clearTimeout(entry.retry);
      entry.retry = null;
      entry.link?.close(code, reason);
    }
  }

  /** Visiting came back on: redial every host still retained. */
  private resume(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      entry.halted = false;
      if (entry.retainers > 0 && (!entry.link || entry.link.closed)) this.scheduleRedial(entry, 0, true);
    }
  }

  private async connect(entry: Entry, candidate?: string): Promise<PeerLink> {
    if (!federationVisits() || this.disposed) {
      throw new LinkRequestError('federation_off', 'This install does not visit spaces on other installs (federation.mode)');
    }
    if (entry.link && !entry.link.closed) return entry.link;
    // Another address than the known good one: tried on its own, once the
    // dial to the good one (if any is under way) has settled.
    if (candidate && entry.goodUrl && candidate !== entry.goodUrl) {
      const running = entry.connecting;
      if (running) {
        const link = await running.catch(() => null);
        if (link && !link.closed) return link;
      }
      return this.dial(entry, candidate);
    }
    entry.connecting ??= this.dial(entry, entry.host.url).finally(() => { entry.connecting = null; });
    return entry.connecting;
  }

  private entry(host: HostAddress): Entry {
    let entry = this.entries.get(host.instanceId);
    if (!entry) {
      entry = {
        host, goodUrl: null, link: null, connecting: null, retainers: 0, attempt: 0, retry: null, listeners: new Set(),
        upSince: 0, refused: false, halted: false,
      };
      this.entries.set(host.instanceId, entry);
    } else if (host.url && !entry.goodUrl) {
      // No handshake completed yet: the newest address is as good as any.
      entry.host = host;
    }
    return entry;
  }

  private async dial(entry: Entry, url: string): Promise<PeerLink> {
    if (!url) throw new LinkRequestError('unknown_host', `No address known for ${entry.host.instanceId}`);
    const generation = this.generation;
    const identity = await (this.opts.identity ?? getInstanceIdentity)();
    let link: PeerLink;
    try {
      link = await dialPeer(url, entry.host.instanceId, {
        ...this.opts.dial,
        identity,
        onRequest: answerHost,
        onEvent: (event) => {
          for (const listener of entry.listeners) {
            try {
              listener(event);
            } catch (err) {
              log.error({ err, host: entry.host.instanceId }, 'Federation event listener failed');
            }
          }
        },
        onClose: (code, reason, closed) => this.linkClosed(entry, closed, code, reason),
      });
    } catch (err) {
      // Only the host's known address can refuse for it: whatever answers at
      // an untried one proved nothing.
      if (err instanceof DialError && err.closeCode !== undefined && FINAL_CLOSE_CODES.has(err.closeCode) && (!entry.goodUrl || url === entry.goodUrl)) {
        entry.refused = true;
        log.warn({ host: entry.host.instanceId, code: err.closeCode }, 'Federation host refused the link: not redialling until asked again');
      }
      throw err;
    }
    // Visiting went off, or `closeAll` ran, while this dial was in flight:
    // the link is not wanted any more.
    if (generation !== this.generation || !federationVisits() || this.disposed) {
      link.close(CLOSE.normal, 'no longer wanted');
      throw new LinkRequestError('federation_off', 'Visiting was turned off while the link was opening');
    }
    // Another dial (at the other address) won meanwhile: keep that link.
    if (entry.link && !entry.link.closed) {
      link.close(CLOSE.normal, 'a link is already open');
      return entry.link;
    }
    // The pinned host answered here: this is its address now.
    if (url !== entry.goodUrl) log.info({ host: entry.host.instanceId }, 'Federation host address confirmed by a handshake');
    entry.goodUrl = url;
    entry.host = { instanceId: entry.host.instanceId, url };
    entry.link = link;
    entry.upSince = Date.now();
    this.announce(entry.host.instanceId, 'up');
    log.info({ host: entry.host.instanceId }, 'Federation outbound link up');
    return link;
  }

  private linkClosed(entry: Entry, closed: PeerLink, code: number, reason: string): void {
    if (entry.link !== closed) return;
    entry.link = null;
    this.announce(entry.host.instanceId, 'down');
    log.info({ host: entry.host.instanceId, code, reason }, 'Federation outbound link down');
    // Closed by `closeAll` (whose own code may be 4403): no refusal by the host.
    if (entry.halted) return;
    if (FINAL_CLOSE_CODES.has(code)) {
      entry.refused = true;
      return;
    }
    const stableMs = this.opts.reconnect?.stableMs ?? STABLE_LINK_MS;
    entry.attempt = Date.now() - entry.upSince >= stableMs ? 0 : entry.attempt + 1;
    if (entry.retainers > 0 && federationVisits()) this.scheduleRedial(entry, entry.attempt);
  }

  /** Dial again after the backoff for `attempt` (now, for a retainer's first dial). */
  private scheduleRedial(entry: Entry, attempt: number, now = false): void {
    if (entry.retry || entry.retainers <= 0 || entry.refused || entry.halted || this.disposed) return;
    const backoff = this.opts.reconnect ?? { baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS };
    const delay = now ? 0 : reconnectDelay(attempt, Math.random, backoff.baseMs, backoff.maxMs);
    entry.retry = setTimeout(() => {
      entry.retry = null;
      if (entry.retainers <= 0 || entry.refused || entry.halted || !federationVisits()) return;
      if (entry.link && !entry.link.closed) return;
      this.connect(entry).catch((err: unknown) => {
        if (entry.refused || entry.halted) return;
        entry.attempt = attempt + 1;
        log.warn({ err, host: entry.host.instanceId, attempt: entry.attempt }, 'Federation redial failed');
        this.scheduleRedial(entry, entry.attempt);
      });
    }, delay);
    entry.retry.unref();
  }
}

/** Requests a host may send a visitor: the heartbeat only. */
async function answerHost(request: LinkRequest): Promise<unknown> {
  if (request.type === 'ping') return {};
  throw new LinkRequestError('unsupported', `unsupported request type ${request.type}`);
}

let pool: VisitorLinkPool | null = null;

/** The process's link pool. */
export function getVisitorLinkPool(): VisitorLinkPool {
  pool ??= new VisitorLinkPool();
  return pool;
}
