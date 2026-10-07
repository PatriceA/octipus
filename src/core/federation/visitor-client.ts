/**
 * The visitor's link pool (docs/plans/federation-spec.md §5.4, §8.2).
 *
 * One link per host install, shared by every user here who joined a space
 * there. A link opens on demand (the first request to that host), through the
 * guarded dialer against the host's pinned instance id. While something keeps
 * a host retained — a local user with one of its spaces open, an agent turn
 * that needs it — a dropped link is redialled with exponential backoff (1 s
 * up to 60 s, with jitter); every redial goes through the dialer's checks
 * again. Turning visiting off closes every outbound link of the pool.
 *
 * Frames name the visitor (`as`, the stored member handle) and the local
 * client connection (`conn`); the slices that build the visitor operations
 * fill them. Host events reach the callbacks subscribed for that host.
 */
import { logger } from '@/utils/logger';
import { type DialPeerOptions, dialPeer } from './dialer';
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
  host: HostAddress;
  link: PeerLink | null;
  connecting: Promise<PeerLink> | null;
  retainers: number;
  attempt: number;
  retry: NodeJS.Timeout | null;
  listeners: Set<HostEventListener>;
}

export interface VisitorLinkPoolOptions {
  /** The install identity; defaults to the vault one. */
  identity?: () => Promise<InstanceIdentity>;
  /** Dialer options other than the identity and callbacks (tests: lanCidrs, resolver, heartbeat). */
  dial?: Omit<Partial<DialPeerOptions>, 'identity' | 'onRequest' | 'onEvent' | 'onClose'>;
  /** Backoff bounds for redials. */
  reconnect?: { baseMs: number; maxMs: number };
  /** Link up/down, per host. */
  onLinkState?: (hostInstanceId: string, state: LinkState) => void;
}

export class VisitorLinkPool {
  private readonly entries = new Map<string, Entry>();
  private readonly opts: VisitorLinkPoolOptions;
  private readonly stopFollowingMode: () => void;

  constructor(opts: VisitorLinkPoolOptions = {}) {
    this.opts = opts;
    this.stopFollowingMode = onFederationModeChanged((next) => {
      if (!federationVisits(next)) this.closeAll(CLOSE.forbidden, 'federation off');
    });
  }

  /** Close every link and stop following mode changes. */
  dispose(): void {
    this.stopFollowingMode();
    this.closeAll(CLOSE.normal, 'shutting down');
  }

  /** Whether the link to `hostInstanceId` is open. */
  state(hostInstanceId: string): LinkState {
    const link = this.entries.get(hostInstanceId)?.link;
    return link && !link.closed ? 'up' : 'down';
  }

  /** The open link to `host`, dialling it when there is none. */
  link(host: HostAddress): Promise<PeerLink> {
    if (!federationVisits()) {
      return Promise.reject(new LinkRequestError('federation_off', 'This install does not visit spaces on other installs (federation.mode)'));
    }
    const entry = this.entry(host);
    if (entry.link && !entry.link.closed) return Promise.resolve(entry.link);
    entry.connecting ??= this.dial(entry).finally(() => { entry.connecting = null; });
    return entry.connecting;
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

  /** Close every link and stop redialling (visiting turned off, shutdown). */
  closeAll(code: number, reason: string): void {
    for (const entry of this.entries.values()) {
      entry.retainers = 0;
      if (entry.retry) clearTimeout(entry.retry);
      entry.retry = null;
      entry.link?.close(code, reason);
    }
  }

  private entry(host: HostAddress): Entry {
    let entry = this.entries.get(host.instanceId);
    if (!entry) {
      entry = { host, link: null, connecting: null, retainers: 0, attempt: 0, retry: null, listeners: new Set() };
      this.entries.set(host.instanceId, entry);
    } else if (host.url) {
      entry.host = host;
    }
    return entry;
  }

  private async dial(entry: Entry): Promise<PeerLink> {
    if (!entry.host.url) throw new LinkRequestError('unknown_host', `No address known for ${entry.host.instanceId}`);
    const identity = await (this.opts.identity ?? getInstanceIdentity)();
    const link = await dialPeer(entry.host.url, entry.host.instanceId, {
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
      onClose: (code, reason, closed) => {
        if (entry.link !== closed) return;
        entry.link = null;
        this.opts.onLinkState?.(entry.host.instanceId, 'down');
        log.info({ host: entry.host.instanceId, code, reason }, 'Federation outbound link down');
        if (entry.retainers > 0 && federationVisits()) this.scheduleRedial(entry, 0);
      },
    });
    entry.link = link;
    entry.attempt = 0;
    this.opts.onLinkState?.(entry.host.instanceId, 'up');
    log.info({ host: entry.host.instanceId }, 'Federation outbound link up');
    return link;
  }

  /** Dial again after the backoff for `attempt` (now, for a retainer's first dial). */
  private scheduleRedial(entry: Entry, attempt: number, now = false): void {
    if (entry.retry || entry.retainers <= 0) return;
    const backoff = this.opts.reconnect ?? { baseMs: RECONNECT_BASE_MS, maxMs: RECONNECT_MAX_MS };
    const delay = now ? 0 : reconnectDelay(attempt, Math.random, backoff.baseMs, backoff.maxMs);
    entry.retry = setTimeout(() => {
      entry.retry = null;
      if (entry.retainers <= 0 || !federationVisits()) return;
      if (entry.link && !entry.link.closed) return;
      this.link(entry.host).catch((err: unknown) => {
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
