/**
 * Virtual gateway connections of members of other installs
 * (docs/plans/federation-spec.md §7.2, F-D7).
 *
 * A gateway connection is single-user and the document hub keys its peers
 * by connection id, so the host keeps one virtual connection per (visitor,
 * client connection on the visitor's install `conn`). Each is registered
 * with the gateway (`ConnectionManager.registerVirtual`) as an ordinary
 * active connection of the visitor's remote row, `clientType: 'peer'`:
 * every server message it gets — room events, document updates, the
 * visitor's own events (a requester error, a mention) — is sealed onto the
 * link as `{ type: 'event', as, conn, body }`.
 *
 * Outbound, only what a local member of the space would see of the space
 * leaves on the link (FI5): the answers and pushes of the allowlisted frames
 * (`PEER_MESSAGE_TYPES`) and room and space events plus the visitor's own
 * mention and requester error (`PEER_EVENT_TYPES`). Everything else the
 * gateway would send a connection of that user — a host turn's
 * `agent.*` / `swarm.*` / `chat.delta` progress with raw tool arguments and
 * observations, permission prompts, session stats — is dropped in the sink.
 *
 * Inbound, a frame of an allowlisted type (`GATEWAY_FRAME_ALLOWLIST`) goes
 * through `ConnectionManager.handleMessage`, so the gateway's zod parsing
 * and per-connection rate buckets apply unchanged, then to the same
 * handlers a local member's frame reaches.
 *
 * Bounds: at most `MAX_VIRTUAL_PER_VISITOR` per visitor per link (apart
 * from `gateway.maxConnectionsPerUser`). A virtual connection is dropped
 * when its link closes, on `conn.close` from the visitor install, when the
 * visitor's last membership here ends, or after `IDLE_MS` without a frame.
 */
import { randomBytes } from 'node:crypto';
import { getGatewayHub } from '@/core/gateway/hub';
import type { GatewayEventType, GatewayMessage } from '@/core/gateway/protocol';
import { logger } from '@/utils/logger';
import { LinkRequestError, type PeerLink } from './link';
import type { RemoteMember } from './remote-members';

const log = logger.child({ component: 'federation-virtual' });

/** Virtual connections one visitor may hold on one link. */
export const MAX_VIRTUAL_PER_VISITOR = 5;
/** A virtual connection without a frame for this long is dropped. */
export const IDLE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;

/** Close code of a dropped virtual connection (as a normal close: the visitor install reopens it when needed). */
const DROPPED = 4000;

/**
 * Server messages (other than `event`) a virtual connection passes to the
 * link: the answers and pushes of the gateway frames a visitor may send
 * (rooms, live notes, the space's file leases), errors and pongs.
 */
export const PEER_MESSAGE_TYPES: ReadonlySet<GatewayMessage['type']> = new Set<GatewayMessage['type']>([
  'error', 'pong', 'subscribed',
  'room.catchup', 'room.posted',
  'doc.sync', 'doc.update', 'doc.awareness', 'doc.saved', 'doc.status', 'doc.closed', 'doc.error', 'doc.proposals',
  'file.leases',
]);

/**
 * Event types (`{ type: 'event' }`) a virtual connection passes to the link:
 * the room and space events every member of a room or space reads, and of
 * the visitor's own events only a mention and a room turn's requester
 * error. Nothing of a host turn's progress (`agent.*`, `swarm.*`,
 * `chat.delta`, `chat.response`, permission prompts).
 */
export const PEER_EVENT_TYPES: ReadonlySet<GatewayEventType> = new Set<GatewayEventType>([
  'room.message', 'room.turn', 'room.presence', 'room.typing', 'room.read', 'room.removed',
  'space.presence', 'task.changed',
  'room.mention', 'chat.error',
]);

/** The visitor's own event types its virtual connections subscribe to (`publishEvent` delivers them by user id). */
const PEER_USER_EVENTS = ['room.mention', 'chat.error'] as const;

/** Whether `message` may leave on the link (FI5). */
export function peerMayReceive(message: GatewayMessage): boolean {
  if (message.type === 'event') return PEER_EVENT_TYPES.has(message.event.type);
  return PEER_MESSAGE_TYPES.has(message.type);
}

/** A per-process id of each link, for the visitor's shared rate buckets. */
const linkIds = new WeakMap<PeerLink, string>();
function linkId(link: PeerLink): string {
  let id = linkIds.get(link);
  if (!id) {
    id = randomBytes(8).toString('hex');
    linkIds.set(link, id);
  }
  return id;
}

/**
 * The key of a visitor's gateway rate buckets on `link`: every virtual
 * connection of theirs on the link draws on the same buckets, and the
 * buckets outlive `conn.close`, so rotating `conn` buys no fresh budget.
 */
export function peerRateKey(link: PeerLink, userId: string): string {
  return `peer:${linkId(link)}:${userId}`;
}

interface VirtualConn {
  connectionId: string;
  link: PeerLink;
  member: RemoteMember;
  conn: string;
}

/** `${userId}\n${conn}` → the virtual connection. */
const byKey = new Map<string, VirtualConn>();
let sweeper: NodeJS.Timeout | null = null;

const keyOf = (userId: string, conn: string) => `${userId}\n${conn}`;

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(sweepIdle, SWEEP_MS);
  sweeper.unref();
}

/** Drop the virtual connections idle for `IDLE_MS` or more. */
export function sweepIdle(now = Date.now()): number {
  const cm = getGatewayHub().connectionManager;
  let dropped = 0;
  for (const v of [...byKey.values()]) {
    const ctx = cm.getConnection(v.connectionId)?.context;
    if (ctx && now - ctx.lastActivityAt < IDLE_MS) continue;
    drop(v, 'idle');
    dropped++;
  }
  return dropped;
}

function drop(v: VirtualConn, reason: string): void {
  if (byKey.get(keyOf(v.member.userId, v.conn)) !== v) return;
  byKey.delete(keyOf(v.member.userId, v.conn));
  // Closes it through the gateway (rooms, documents and presence let go of
  // it there); `onClose` below finds it already gone.
  getGatewayHub().connectionManager.closeConnection(v.connectionId, DROPPED, reason);
  log.debug({ instanceId: v.member.instanceId, userId: v.member.userId, conn: v.conn, reason }, 'Virtual peer connection dropped');
}

/**
 * The virtual connection of `member` for its install's client connection
 * `conn` on `link`, opened on first use. Throws `LinkRequestError('limit')`
 * past `MAX_VIRTUAL_PER_VISITOR` on this link.
 */
export function virtualConnection(link: PeerLink, member: RemoteMember, conn: string): string {
  const existing = byKey.get(keyOf(member.userId, conn));
  if (existing) {
    if (existing.link === link) return existing.connectionId;
    // The member's install reconnected: the old link's connection is stale.
    drop(existing, 'link replaced');
  }
  let mine = 0;
  for (const v of byKey.values()) if (v.member.userId === member.userId && v.link === link) mine++;
  if (mine >= MAX_VIRTUAL_PER_VISITOR) {
    throw new LinkRequestError('limit', `At most ${MAX_VIRTUAL_PER_VISITOR} open connections per member`);
  }
  startSweeper();
  let entry: VirtualConn | null = null;
  const connectionId = getGatewayHub().connectionManager.registerVirtual({
    userId: member.userId,
    instanceId: member.instanceId,
    conn,
    rateKey: peerRateKey(link, member.userId),
    eventPatterns: PEER_USER_EVENTS,
    sink: (message: GatewayMessage) => {
      if (!peerMayReceive(message)) {
        log.debug({ instanceId: member.instanceId, userId: member.userId, type: message.type === 'event' ? message.event.type : message.type }, 'Server message kept from a virtual peer connection');
        return;
      }
      let sent: boolean;
      try {
        sent = link.sendEvent(member.handle, conn, message);
      } catch (err) {
        // Over the frame cap (`too_large`): this one event cannot travel.
        log.warn({ err, instanceId: member.instanceId, userId: member.userId, type: message.type }, 'Event for a virtual peer connection not sent');
        return;
      }
      if (!sent && entry) drop(entry, 'link closed');
    },
    onClose: () => {
      if (entry && byKey.get(keyOf(member.userId, conn)) === entry) byKey.delete(keyOf(member.userId, conn));
    },
  });
  entry = { connectionId, link, member, conn };
  byKey.set(keyOf(member.userId, conn), entry);
  return connectionId;
}

/** Drop the virtual connection of `userId` for `conn` (`conn.close`). Returns whether there was one. */
export function closeVirtualConnection(userId: string, conn: string): boolean {
  const v = byKey.get(keyOf(userId, conn));
  if (!v) return false;
  drop(v, 'closed by the visitor install');
  return true;
}

/** Drop every virtual connection of `userId` (their last membership here ended). */
export function closeVirtualConnectionsOf(userId: string, reason: string): number {
  let n = 0;
  for (const v of [...byKey.values()]) {
    if (v.member.userId !== userId) continue;
    drop(v, reason);
    n++;
  }
  return n;
}

/** Drop every virtual connection carried on `link` (it closed). */
export function closeVirtualConnectionsOfLink(link: PeerLink): number {
  let n = 0;
  for (const v of [...byKey.values()]) {
    if (v.link !== link) continue;
    drop(v, 'link closed');
    n++;
  }
  return n;
}

/** Drop every virtual connection of install `instanceId` (blocked, or hosting off). */
export function closeVirtualConnectionsOfInstance(instanceId: string, reason: string): number {
  let n = 0;
  for (const v of [...byKey.values()]) {
    if (v.member.instanceId !== instanceId) continue;
    drop(v, reason);
    n++;
  }
  return n;
}

/** Drop every virtual connection (hosting turned off). */
export function closeAllVirtualConnections(reason: string): number {
  const all = [...byKey.values()];
  for (const v of all) drop(v, reason);
  return all.length;
}

/** How many virtual connections are open (all, or one install's). */
export function virtualConnectionCount(instanceId?: string): number {
  if (!instanceId) return byKey.size;
  let n = 0;
  for (const v of byKey.values()) if (v.member.instanceId === instanceId) n++;
  return n;
}

/** Drop everything (tests). */
export function _resetVirtualConnectionsForTests(): void {
  for (const v of [...byKey.values()]) drop(v, 'reset');
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}
