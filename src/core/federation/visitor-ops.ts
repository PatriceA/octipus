/**
 * The visitor side of spaces across installs (docs/plans/federation-spec.md
 * §6.2, §6.3, §8.1–§8.2).
 *
 * A user here joins a space on another install with the invite link its
 * owner sent (`<publicUrl>/join/<token>#octipus=<host instance id>`): the
 * link is parsed and its host fingerprint shown before anything is dialled;
 * once confirmed, `space.join` goes over the link pinned to that
 * fingerprint and the answer is kept as a pointer row (`remote_spaces`):
 * the host, the space's id and name, the member's role and handle there.
 * Nothing of the space's content is stored here (F-D11): every read is
 * forwarded live and answered from the host.
 *
 * Who does what:
 *
 *  - **REST** (`/api/remote-spaces/...`, routes/remote-spaces.ts): every
 *    call reads the caller's own live pointer row (`ownRemoteSpace`) — a
 *    row of another user, or a left one, is `not_found` — and forwards the
 *    matching request as that row's handle (`as`). A room post goes as a
 *    gateway frame on the connection `rest:<user id>` and waits for the
 *    host's `room.posted` (or its error) on it.
 *  - **Gateway.** The browser sends `remote.frame { remoteSpaceId, frame }`
 *    (`handleRemoteFrame`): the row must be the connection user's, the frame
 *    of an allowlisted type; it travels as `gateway.frame` with this
 *    connection's id as `conn`. Host events for that `conn` come back as
 *    `remote.event { remoteSpaceId, event }` to that connection only, and
 *    only when the event's `as` is the handle that connection used there.
 *    Link changes go out as `remote.link { remoteSpaceId, state }`. When the
 *    browser connection closes, `conn.close` is sent for it.
 *  - **Reconnect.** A browser connection that sent frames to a host retains
 *    the link to it, so a dropped link is redialled with backoff
 *    (visitor-client.ts). On `down` the connection is told; on `up` this
 *    install re-issues the connection's `space.subscribe`s, then announces
 *    `up`. The room subscriptions (with `afterMessageId`, paging while
 *    `hasMore`) and `doc.join`s (with the client's epoch and state vector)
 *    are re-issued by the client, which holds that state — the same thing
 *    it does after its own gateway reconnects.
 *  - **Leaving** (§6.3) sets `left_at`, a tombstone: `space.leave` is sent
 *    at once and again every time the link to that host opens (and at
 *    startup), until the host acknowledges it; then the row is deleted. A
 *    rejoin of the same space drops a pending tombstone first.
 *
 * Logs name frame types, sizes and ids, never bodies.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ConnectionContext } from '@/core/gateway/protocol';
import { getDb } from '@/db/postgres';
import { auditLog } from '@/db/schema/audit';
import { type RemoteSpace, type RemoteSpaceRole, remoteSpaces } from '@/db/schema/federation';
import { instanceBadge } from '@/security/user-kinds';
import { logger } from '@/utils/logger';
import { DialError } from './dialer';
import { displayInstanceId, instanceIdOf, isInstanceId } from './identity';
import { LinkRequestError } from './link';
import { federationVisits } from './mode';
import { type FederationRequestType, GATEWAY_FRAME_ALLOWLIST, type LinkEvent } from './protocol';
import { getVisitorLinkPool, type HostAddress, type LinkState, type VisitorLinkPool } from './visitor-client';

const log = logger.child({ component: 'federation-visitor-ops' });

/** How long a forwarded post waits for the host's `room.posted`. */
const POST_ANSWER_MS = 20_000;

/** A refused visitor operation, with the HTTP status the routes answer. */
export class RemoteSpaceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'RemoteSpaceError';
  }
}

/** HTTP status of a host's refusal code. */
const STATUS_OF: Record<string, number> = {
  not_found: 404, invite_invalid: 404, forbidden: 403, forbidden_role: 403, federation_off: 403,
  bad_request: 400, invalid_input: 400, unsupported: 400, conflict: 409, stale: 409, archived: 409,
  rate_limited: 429, limit: 429, busy: 429, too_large: 413, timeout: 504, link_closed: 502, unknown_host: 502,
};

/** `err` as a `RemoteSpaceError`: a host refusal keeps its code, an unreachable host is 502. Anything else is rethrown. */
export function remoteError(err: unknown): RemoteSpaceError {
  if (err instanceof RemoteSpaceError) return err;
  if (err instanceof LinkRequestError) return new RemoteSpaceError(err.code, err.message, STATUS_OF[err.code] ?? 502);
  if (err instanceof DialError) return new RemoteSpaceError('host_unreachable', `The host could not be reached: ${err.message}`, 502);
  throw err;
}

// ── Invite links (§6.1) ──────────────────────────────────────────────

export interface FederatedLink {
  /** The host's web origin, as the link names it. */
  origin: string;
  /** Its peer endpoint: `wss://<host>[/<base>]/federation` (`ws://` for an `http://` link, LAN only — the dialer decides). */
  hostUrl: string;
  token: string;
  /** The host's full instance id, from `#octipus=`. */
  instanceId: string;
}

/**
 * Parse an invite link with its host fingerprint. A link without one is
 * refused: this install never dials a host it cannot pin (F-D4).
 */
export function parseFederatedLink(link: string): FederatedLink {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new RemoteSpaceError('invalid_link', 'That is not a link', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RemoteSpaceError('invalid_link', 'An invite link starts with https://', 400);
  const path = /^(.*)\/join\/([0-9a-f]{64})\/?$/.exec(url.pathname);
  if (!path) throw new RemoteSpaceError('invalid_link', 'That is not an invite link (…/join/<token>)', 400);
  const fingerprint = /(?:^#|&)octipus=([a-z2-7]+)(?:&|$)/.exec(url.hash)?.[1];
  if (!fingerprint || !isInstanceId(fingerprint)) {
    throw new RemoteSpaceError('no_fingerprint', 'This link carries no host fingerprint (#octipus=…): ask for the link to join from your own Octipus', 400);
  }
  const base = path[1].replace(/\/+$/, '');
  return {
    origin: url.origin,
    hostUrl: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}${base}/federation`,
    token: path[2],
    instanceId: fingerprint,
  };
}

/** What the user confirms before anything is dialled. */
export interface JoinPreview {
  origin: string;
  hostUrl: string;
  hostInstanceId: string;
  /** The fingerprint in four groups, to compare with what the host shows. */
  fingerprint: string;
  badge: string;
}

export function joinPreview(link: string): JoinPreview {
  const parsed = parseFederatedLink(link);
  return {
    origin: parsed.origin, hostUrl: parsed.hostUrl, hostInstanceId: parsed.instanceId,
    fingerprint: displayInstanceId(parsed.instanceId), badge: instanceBadge(parsed.instanceId),
  };
}

// ── Pointer rows ─────────────────────────────────────────────────────

export interface RemoteSpaceView {
  id: string;
  hostInstanceId: string;
  hostBadge: string;
  hostFingerprint: string;
  hostUrl: string;
  spaceId: string;
  spaceName: string;
  role: RemoteSpaceRole;
  memberHandle: string;
  agentAnswersWhenAddressed: boolean;
  joinedAt: string;
  leftAt: string | null;
  /** The link to the host, now. */
  link: LinkState;
}

export function remoteSpaceView(row: RemoteSpace, pool: VisitorLinkPool = visitorPool()): RemoteSpaceView {
  return {
    id: row.id,
    hostInstanceId: row.hostInstanceId,
    hostBadge: instanceBadge(row.hostInstanceId),
    hostFingerprint: displayInstanceId(row.hostInstanceId),
    hostUrl: row.hostUrl,
    spaceId: row.spaceId,
    spaceName: row.spaceName,
    role: row.role,
    memberHandle: row.memberHandle,
    agentAnswersWhenAddressed: row.agentAnswersWhenAddressed,
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
    link: pool.state(row.hostInstanceId),
  };
}

/** The caller's own live pointer row `id`, or `not_found` (another user's, a left one, an unknown id). */
export async function ownRemoteSpace(userId: string, id: string): Promise<RemoteSpace> {
  if (!z.string().uuid().safeParse(id).success) throw new RemoteSpaceError('not_found', 'Space not found', 404);
  const [row] = await getDb()
    .select()
    .from(remoteSpaces)
    .where(and(eq(remoteSpaces.id, id), eq(remoteSpaces.userId, userId), isNull(remoteSpaces.leftAt)));
  if (!row) throw new RemoteSpaceError('not_found', 'Space not found', 404);
  return row;
}

/** The caller's spaces on other installs, and their leaves still waiting for the host. */
export async function listRemoteSpaces(userId: string): Promise<{ remoteSpaces: RemoteSpaceView[]; pendingLeaves: RemoteSpaceView[] }> {
  const rows = await getDb().select().from(remoteSpaces).where(eq(remoteSpaces.userId, userId)).orderBy(remoteSpaces.joinedAt);
  const pool = visitorPool();
  return {
    remoteSpaces: rows.filter((r) => !r.leftAt).map((r) => remoteSpaceView(r, pool)),
    pendingLeaves: rows.filter((r) => r.leftAt).map((r) => remoteSpaceView(r, pool)),
  };
}

function hostOf(row: Pick<RemoteSpace, 'hostInstanceId' | 'hostUrl'>): HostAddress {
  return { instanceId: row.hostInstanceId, url: row.hostUrl };
}

function requireVisiting(): void {
  if (!federationVisits()) {
    throw new RemoteSpaceError('federation_off', 'This install does not join spaces on other installs (federation.mode)', 403);
  }
}

/**
 * Forward request `type` for the pointer row `row` (its handle as `as`).
 * Refusals become `RemoteSpaceError`s. Logs the type and ids only.
 */
export async function forward(row: RemoteSpace, type: FederationRequestType, body: Record<string, unknown>, conn?: string): Promise<unknown> {
  requireVisiting();
  log.debug({ type, remoteSpaceId: row.id, host: row.hostInstanceId }, 'Forwarding a request to the host');
  try {
    return await visitorPool().request(hostOf(row), type, { spaceId: row.spaceId, ...body }, { as: row.memberHandle, ...(conn ? { conn } : {}) });
  } catch (err) {
    throw remoteError(err);
  }
}

async function auditVisitor(userId: string, action: 'remote_space_joined' | 'remote_space_left', row: RemoteSpace, extra: Record<string, unknown> = {}): Promise<void> {
  await getDb().insert(auditLog).values({
    userId, action, resourceType: 'remote_space', resourceId: row.id,
    details: { instanceId: row.hostInstanceId, memberHandle: row.memberHandle, spaceId: row.spaceId, role: row.role, ...extra },
  });
}

// ── Joining (§6.2) ───────────────────────────────────────────────────

const joinAnswerSchema = z.object({
  space: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(500),
    role: z.enum(['editor', 'commenter', 'viewer', 'guest']),
    scope: z.unknown(),
  }).passthrough(),
  member: z.object({ handle: z.string().min(1).max(200) }).passthrough(),
}).passthrough();

/**
 * Join the space the invite `link` names, as `user` (§6.2). The user saw
 * and confirmed the host fingerprint (`joinPreview`); the link is pinned to
 * it. Writes or refreshes the pointer row and audits `remote_space_joined`.
 */
export async function joinRemoteSpace(user: { id: string; username: string }, link: string): Promise<RemoteSpaceView> {
  requireVisiting();
  const parsed = parseFederatedLink(link);
  const host: HostAddress = { instanceId: parsed.instanceId, url: parsed.hostUrl };
  const pool = visitorPool();
  let answer: z.infer<typeof joinAnswerSchema>;
  let hostPublicKey: string;
  try {
    const raw = await pool.request(host, 'space.join', { token: parsed.token, user: { ref: user.id, name: user.username.slice(0, 40) } });
    answer = joinAnswerSchema.parse(raw);
    const link = await pool.link(host);
    if (!link.peerPublicKey || instanceIdOf(link.peerPublicKey) !== parsed.instanceId) {
      throw new Error('The link to the host carries no verified key for its pinned id');
    }
    hostPublicKey = link.peerPublicKey;
  } catch (err) {
    if (err instanceof z.ZodError) throw new RemoteSpaceError('bad_answer', 'The host answered the join with something this install does not read', 502);
    throw remoteError(err);
  }
  ensureHostWired(parsed.instanceId);
  const row = await getDb().transaction(async (tx) => {
    // A rejoin supersedes a leave still waiting for the host: its `space.leave`
    // must not remove the membership just made.
    await tx.delete(remoteSpaces).where(and(
      eq(remoteSpaces.userId, user.id), eq(remoteSpaces.hostInstanceId, parsed.instanceId),
      eq(remoteSpaces.spaceId, answer.space.id), isNotNull(remoteSpaces.leftAt),
    ));
    const values = {
      hostPublicKey, hostUrl: parsed.hostUrl, spaceName: answer.space.name, role: answer.space.role, memberHandle: answer.member.handle,
    };
    const [existing] = await tx.select().from(remoteSpaces).where(and(
      eq(remoteSpaces.userId, user.id), eq(remoteSpaces.hostInstanceId, parsed.instanceId),
      eq(remoteSpaces.spaceId, answer.space.id), isNull(remoteSpaces.leftAt),
    ));
    if (existing) {
      const [updated] = await tx.update(remoteSpaces).set(values).where(eq(remoteSpaces.id, existing.id)).returning();
      return updated;
    }
    const [inserted] = await tx.insert(remoteSpaces).values({
      userId: user.id, hostInstanceId: parsed.instanceId, spaceId: answer.space.id, ...values,
    }).returning();
    return inserted;
  });
  await auditVisitor(user.id, 'remote_space_joined', row);
  log.info({ remoteSpaceId: row.id, host: row.hostInstanceId, spaceId: row.spaceId, role: row.role }, 'Joined a space on another install');
  return remoteSpaceView(row, pool);
}

/** Refresh the pointer row from the host (`space.info`): the space's name and the member's role. */
export async function refreshRemoteSpace(userId: string, id: string): Promise<{ remoteSpace: RemoteSpaceView; info: Record<string, unknown> }> {
  const row = await ownRemoteSpace(userId, id);
  const info = z.object({
    name: z.string().min(1).max(500),
    role: z.enum(['editor', 'commenter', 'viewer', 'guest']),
  }).passthrough().parse(await forward(row, 'space.info', {}));
  let current = row;
  if (info.name !== row.spaceName || info.role !== row.role) {
    [current] = await getDb().update(remoteSpaces).set({ spaceName: info.name, role: info.role }).where(eq(remoteSpaces.id, row.id)).returning();
  }
  return { remoteSpace: remoteSpaceView(current), info };
}

/** Turn "let my agent answer when addressed" (§9) on or off for one space. */
export async function setAgentAnswersWhenAddressed(userId: string, id: string, on: boolean): Promise<RemoteSpaceView> {
  const row = await ownRemoteSpace(userId, id);
  const [updated] = await getDb().update(remoteSpaces).set({ agentAnswersWhenAddressed: on }).where(eq(remoteSpaces.id, row.id)).returning();
  const { syncAgentListeners } = await import('./visitor-agent');
  await syncAgentListeners(updated);
  return remoteSpaceView(updated);
}

// ── Leaving (§6.3) ───────────────────────────────────────────────────

/**
 * Leave space `id`: the row becomes a tombstone (`left_at`), audited, and
 * `space.leave` is tried at once. Returns whether the host acknowledged it
 * already; otherwise it is retried every time the link to that host opens.
 */
export async function leaveRemoteSpace(userId: string, id: string): Promise<{ left: true; pending: boolean }> {
  const row = await ownRemoteSpace(userId, id);
  const [tomb] = await getDb().update(remoteSpaces).set({ leftAt: new Date() })
    .where(and(eq(remoteSpaces.id, row.id), isNull(remoteSpaces.leftAt))).returning();
  if (!tomb) throw new RemoteSpaceError('not_found', 'Space not found', 404);
  await auditVisitor(userId, 'remote_space_left', tomb);
  const { stopAgentListener } = await import('./visitor-agent');
  stopAgentListener(tomb.id);
  closeTrackedSpace(tomb.id);
  await deliverTombstones(tomb.hostInstanceId);
  const [still] = await getDb().select({ id: remoteSpaces.id }).from(remoteSpaces).where(eq(remoteSpaces.id, tomb.id));
  return { left: true, pending: !!still };
}

/** Tombstones being delivered, per host: one pass at a time. */
const delivering = new Map<string, Promise<number>>();

/**
 * Send `space.leave` for every tombstone of host `hostInstanceId`; delete
 * each one the host acknowledged (an answer `not_found` is one too: the
 * membership is gone already). Returns how many were delivered. A host
 * that cannot be reached keeps them for the next time its link opens.
 */
export function deliverTombstones(hostInstanceId: string): Promise<number> {
  const running = delivering.get(hostInstanceId);
  if (running) return running;
  const pass = deliverPass(hostInstanceId).finally(() => { delivering.delete(hostInstanceId); });
  delivering.set(hostInstanceId, pass);
  return pass;
}

async function deliverPass(hostInstanceId: string): Promise<number> {
  if (!federationVisits()) return 0;
  const tombs = await getDb().select().from(remoteSpaces)
    .where(and(eq(remoteSpaces.hostInstanceId, hostInstanceId), isNotNull(remoteSpaces.leftAt)));
  let delivered = 0;
  for (const tomb of tombs) {
    try {
      await visitorPool().request(hostOf(tomb), 'space.leave', { spaceId: tomb.spaceId }, { as: tomb.memberHandle });
    } catch (err) {
      if (!(err instanceof LinkRequestError && err.code === 'not_found')) {
        log.warn({ err: err instanceof Error ? err.message : String(err), remoteSpaceId: tomb.id, host: hostInstanceId }, 'Leave not delivered yet: retried when the link next opens');
        if (err instanceof DialError || (err instanceof LinkRequestError && (err.code === 'link_closed' || err.code === 'timeout'))) break;
        continue;
      }
    }
    await getDb().delete(remoteSpaces).where(and(eq(remoteSpaces.id, tomb.id), isNotNull(remoteSpaces.leftAt)));
    delivered++;
    log.info({ remoteSpaceId: tomb.id, host: hostInstanceId }, 'Leave delivered to the host');
  }
  return delivered;
}

// ── Forwarded posts (REST, the visitor's agent) ──────────────────────

interface PostWaiter {
  resolve: (posted: PostedAnswer) => void;
  reject: (err: RemoteSpaceError) => void;
}

export interface PostedAnswer {
  messageId: string;
  clientId?: string;
  queuedPosition?: number;
  notQueued?: string;
}

/** `${host}\n${conn}` → the post waiting for its answer on that connection. */
const postWaiters = new Map<string, PostWaiter>();
/** `${host}\n${conn}` → the previous post on it: one at a time per connection, so an answer is never mistaken for another's. */
const postChains = new Map<string, Promise<unknown>>();

/**
 * Post `content` in room `roomId` of `row`'s space as a gateway frame on
 * connection `conn` (`rest:<user>` for REST, `agent:<session>` for the
 * member's agent — the host labels that one the agent's), and wait for the
 * host's `room.posted` or error on that connection.
 */
export function postThroughConn(
  row: RemoteSpace, conn: string, roomId: string, input: { content: string; addressed?: boolean; clientId?: string },
): Promise<PostedAnswer> {
  const key = `${row.hostInstanceId}\n${conn}`;
  const previous = postChains.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => postOnce(row, conn, key, roomId, input));
  postChains.set(key, run);
  void run.finally(() => { if (postChains.get(key) === run) postChains.delete(key); }).catch(() => undefined);
  return run;
}

async function postOnce(
  row: RemoteSpace, conn: string, key: string, roomId: string, input: { content: string; addressed?: boolean; clientId?: string },
): Promise<PostedAnswer> {
  requireVisiting();
  ensureHostWired(row.hostInstanceId);
  const answer = new Promise<PostedAnswer>((resolve, reject) => { postWaiters.set(key, { resolve, reject }); });
  const timer = setTimeout(() => {
    postWaiters.get(key)?.reject(new RemoteSpaceError('timeout', 'The host did not answer the post', 504));
  }, POST_ANSWER_MS);
  timer.unref();
  try {
    const frame = { type: 'room.post', roomId, content: input.content, ...(input.addressed !== undefined ? { addressed: input.addressed } : {}), ...(input.clientId ? { clientId: input.clientId } : {}) };
    log.debug({ type: 'room.post', size: input.content.length, remoteSpaceId: row.id, roomId, conn }, 'Forwarding a post to the host');
    await visitorPool().request(hostOf(row), 'gateway.frame', { frame }, { as: row.memberHandle, conn });
    return await answer;
  } catch (err) {
    throw remoteError(err);
  } finally {
    clearTimeout(timer);
    postWaiters.delete(key);
  }
}

/** An event on a `rest:`/`agent:` connection: the answer to the post waiting there, if any. */
function answerPost(hostInstanceId: string, conn: string, body: Record<string, unknown>): boolean {
  const waiter = postWaiters.get(`${hostInstanceId}\n${conn}`);
  if (!waiter) return false;
  if (body.type === 'room.posted') {
    waiter.resolve({
      messageId: String(body.messageId),
      ...(typeof body.clientId === 'string' ? { clientId: body.clientId } : {}),
      ...(typeof body.queuedPosition === 'number' ? { queuedPosition: body.queuedPosition } : {}),
      ...(typeof body.notQueued === 'string' ? { notQueued: body.notQueued } : {}),
    });
    return true;
  }
  if (body.type === 'error') {
    const code = String(body.code ?? 'refused');
    waiter.reject(new RemoteSpaceError(code === 'RATE_LIMITED' ? 'rate_limited' : code.toLowerCase(), String(body.message ?? 'The host refused the post'),
      code === 'RATE_LIMITED' ? 429 : code === 'FORBIDDEN' || code === 'POST_REFUSED' ? 403 : 400));
    return true;
  }
  return false;
}

/** Close a host-side connection we opened for one job (`rest:<user>` after a post). Best effort while the link is up. */
export function closeHostConn(row: RemoteSpace, conn: string): void {
  if (visitorPool().state(row.hostInstanceId) !== 'up') return;
  visitorPool().request(hostOf(row), 'conn.close', {}, { as: row.memberHandle, conn })
    .catch((err: unknown) => log.debug({ err: err instanceof Error ? err.message : String(err), conn }, 'conn.close not delivered'));
}

// ── Browser connections (§8.2) ───────────────────────────────────────

/** What one browser connection opened on one host. */
interface HostUse {
  handle: string;
  release: () => void;
  /** Pointer rows this connection used on the host. */
  spaces: Set<string>;
  /** The last pointer row it used: events naming nothing else go to it. */
  last: string;
  /** Host ids → pointer row: rooms, notes and spaces the frames named. */
  rooms: Map<string, string>;
  notes: Map<string, string>;
  spaceSubs: Map<string, string>;
}

interface TrackedConn {
  userId: string;
  hosts: Map<string, HostUse>;
}

/** Browser connection id → what it opened on other installs. */
const tracked = new Map<string, TrackedConn>();

type Hub = import('@/core/gateway/hub').GatewayHub;
let hubRef: Hub | null = null;

function send(connectionId: string, message: import('@/core/gateway/protocol').GatewayMessage): void {
  hubRef?.connectionManager.sendToConnection(connectionId, message);
}

/**
 * `remote.frame` from a browser connection: the pointer row must be the
 * connection user's own; the frame (already of an allowlisted type, the
 * gateway's schema) travels as `gateway.frame` with this connection's id as
 * `conn`. A refusal comes back as a `remote.event` carrying an `error`.
 */
export async function handleRemoteFrame(
  hub: Hub, connectionId: string, context: ConnectionContext,
  message: { remoteSpaceId: string; frame: { type: string } & Record<string, unknown> },
): Promise<void> {
  hubRef = hub;
  const frame = { ...message.frame };
  const refuse = (code: string, text: string) => send(connectionId, {
    type: 'remote.event', remoteSpaceId: message.remoteSpaceId, event: { type: 'error', code, message: text },
  });
  if (!(GATEWAY_FRAME_ALLOWLIST as readonly string[]).includes(frame.type)) {
    refuse('FORBIDDEN', `${frame.type} cannot be sent to another install`);
    return;
  }
  let row: RemoteSpace;
  try {
    requireVisiting();
    row = await ownRemoteSpace(context.userId, message.remoteSpaceId);
  } catch (err) {
    const e = remoteError(err);
    refuse(e.code === 'not_found' ? 'NOT_FOUND' : 'FORBIDDEN', e.message);
    return;
  }
  // The pointer row names the space: a subscription is always to it.
  if (frame.type === 'space.subscribe') frame.spaceId = row.spaceId;
  const use = track(connectionId, context.userId, row);
  if (typeof frame.roomId === 'string') use.rooms.set(frame.roomId, row.id);
  if (typeof frame.noteId === 'string') use.notes.set(frame.noteId, row.id);
  if (frame.type === 'space.subscribe') use.spaceSubs.set(row.spaceId, row.id);
  log.debug({ type: frame.type, size: JSON.stringify(frame).length, remoteSpaceId: row.id, connectionId }, 'Forwarding a frame to the host');
  try {
    await visitorPool().request(hostOf(row), 'gateway.frame', { frame }, { as: row.memberHandle, conn: connectionId });
  } catch (err) {
    const e = remoteError(err);
    refuse(e.code === 'host_unreachable' ? 'UNAVAILABLE' : e.code.toUpperCase(), e.message);
  }
}

function track(connectionId: string, userId: string, row: RemoteSpace): HostUse {
  let conn = tracked.get(connectionId);
  if (!conn) {
    conn = { userId, hosts: new Map() };
    tracked.set(connectionId, conn);
  }
  let use = conn.hosts.get(row.hostInstanceId);
  if (!use) {
    ensureHostWired(row.hostInstanceId);
    // While this connection uses the host, a dropped link is redialled.
    const release = visitorPool().retain(hostOf(row));
    use = { handle: row.memberHandle, release, spaces: new Set(), last: row.id, rooms: new Map(), notes: new Map(), spaceSubs: new Map() };
    conn.hosts.set(row.hostInstanceId, use);
  }
  use.spaces.add(row.id);
  use.last = row.id;
  return use;
}

/** A browser connection closed: its host-side connections go too (`conn.close`), and its retains. */
export function remoteConnectionClosed(context: Pick<ConnectionContext, 'connectionId'>): void {
  const conn = tracked.get(context.connectionId);
  if (!conn) return;
  tracked.delete(context.connectionId);
  for (const [hostInstanceId, use] of conn.hosts) {
    use.release();
    if (visitorPool().state(hostInstanceId) !== 'up') continue;
    visitorPool().request({ instanceId: hostInstanceId, url: '' }, 'conn.close', {}, { as: use.handle, conn: context.connectionId })
      .catch((err: unknown) => log.debug({ err: err instanceof Error ? err.message : String(err), host: hostInstanceId }, 'conn.close not delivered'));
  }
}

/** A left pointer row: no connection keeps using it. */
function closeTrackedSpace(remoteSpaceId: string): void {
  for (const conn of tracked.values()) {
    for (const use of conn.hosts.values()) use.spaces.delete(remoteSpaceId);
  }
}

/** The pointer row an event of `use` belongs to: by the room, note or space it names, else the last one used. */
function rowForEvent(use: HostUse, body: Record<string, unknown>): string {
  const inner = body.type === 'event' && body.event && typeof body.event === 'object'
    ? ((body.event as { payload?: unknown }).payload as Record<string, unknown> | undefined) ?? {}
    : body;
  const pick = (map: Map<string, string>, id: unknown) => (typeof id === 'string' ? map.get(id) : undefined);
  return pick(use.rooms, inner.roomId) ?? pick(use.notes, inner.noteId) ?? pick(use.spaceSubs, inner.spaceId) ?? use.last;
}

// ── Host events and link state ───────────────────────────────────────

const wiredHosts = new Set<string>();

/** Receive the events of host `hostInstanceId` (once). */
export function ensureHostWired(hostInstanceId: string): void {
  if (wiredHosts.has(hostInstanceId)) return;
  wiredHosts.add(hostInstanceId);
  visitorPool().subscribe(hostInstanceId, (event) => onHostEvent(hostInstanceId, event));
}

function onHostEvent(hostInstanceId: string, event: LinkEvent): void {
  const body = (event.body && typeof event.body === 'object' ? event.body : {}) as Record<string, unknown>;
  const type = typeof body.type === 'string' ? body.type : 'unknown';
  log.debug({ host: hostInstanceId, conn: event.conn, type }, 'Host event');
  if (event.conn === '*') {
    void noticeForMember(hostInstanceId, event.as, body).catch((err: unknown) => log.error({ err, host: hostInstanceId, type }, 'Host notice not handled'));
    return;
  }
  if (event.conn.startsWith('rest:')) {
    answerPost(hostInstanceId, event.conn, body);
    return;
  }
  if (event.conn.startsWith('agent:')) {
    if (answerPost(hostInstanceId, event.conn, body)) return;
    import('./visitor-agent')
      .then(({ agentConnEvent }) => agentConnEvent(hostInstanceId, event.conn, event.as, body))
      .catch((err: unknown) => log.error({ err, host: hostInstanceId, type }, 'Agent connection event not handled'));
    return;
  }
  const conn = tracked.get(event.conn);
  const use = conn?.hosts.get(hostInstanceId);
  // Only to the connection named, and only when it used that handle there.
  if (!use || use.handle !== event.as) {
    log.debug({ host: hostInstanceId, conn: event.conn, type }, 'Host event for no open connection: dropped');
    return;
  }
  send(event.conn, { type: 'remote.event', remoteSpaceId: rowForEvent(use, body), event: body });
}

/** A notice for every connection of a member (`conn: '*'`): `space.revoked`. */
async function noticeForMember(hostInstanceId: string, handle: string, body: Record<string, unknown>): Promise<void> {
  if (body.type !== 'space.revoked' || typeof body.spaceId !== 'string') return;
  const rows = await getDb().select().from(remoteSpaces).where(and(
    eq(remoteSpaces.hostInstanceId, hostInstanceId), eq(remoteSpaces.memberHandle, handle), eq(remoteSpaces.spaceId, body.spaceId),
  ));
  for (const row of rows) {
    log.info({ remoteSpaceId: row.id, host: hostInstanceId }, 'The host revoked a membership');
    for (const [connectionId, conn] of tracked) {
      if (conn.userId !== row.userId || !conn.hosts.get(hostInstanceId)?.spaces.has(row.id)) continue;
      send(connectionId, { type: 'remote.event', remoteSpaceId: row.id, event: body });
    }
  }
}

/**
 * The link to a host went down or came up. Down: every connection using it
 * is told. Up: their `space.subscribe`s are re-issued, then they are told
 * (they re-issue their rooms and documents); the host's tombstones are
 * delivered, and the agents listening there re-open.
 */
function onLinkState(hostInstanceId: string, state: LinkState): void {
  if (state === 'up') {
    void reopen(hostInstanceId).catch((err: unknown) => log.error({ err, host: hostInstanceId }, 'Re-opening after a reconnect failed'));
    void deliverTombstones(hostInstanceId).catch((err: unknown) => log.error({ err, host: hostInstanceId }, 'Delivering leaves failed'));
    import('./visitor-agent')
      .then(({ reopenAgentListeners }) => reopenAgentListeners(hostInstanceId))
      .catch((err: unknown) => log.error({ err, host: hostInstanceId }, 'Re-opening agent listeners failed'));
    return;
  }
  announce(hostInstanceId, 'down');
}

async function reopen(hostInstanceId: string): Promise<void> {
  for (const [connectionId, conn] of tracked) {
    const use = conn.hosts.get(hostInstanceId);
    if (!use) continue;
    for (const [spaceId, remoteSpaceId] of use.spaceSubs) {
      if (!use.spaces.has(remoteSpaceId)) continue;
      await visitorPool().request({ instanceId: hostInstanceId, url: '' }, 'gateway.frame', { frame: { type: 'space.subscribe', spaceId } }, { as: use.handle, conn: connectionId })
        .catch((err: unknown) => log.warn({ err: err instanceof Error ? err.message : String(err), remoteSpaceId }, 'space.subscribe not re-issued'));
    }
  }
  announce(hostInstanceId, 'up');
}

function announce(hostInstanceId: string, state: LinkState): void {
  for (const [connectionId, conn] of tracked) {
    const use = conn.hosts.get(hostInstanceId);
    if (!use) continue;
    for (const remoteSpaceId of use.spaces) send(connectionId, { type: 'remote.link', remoteSpaceId, state });
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────

let pool: VisitorLinkPool | null = null;
let stopFollowing: (() => void) | null = null;

/** The link pool the visitor operations use. */
export function visitorPool(): VisitorLinkPool {
  if (!pool) startVisitorOps();
  return pool as VisitorLinkPool;
}

/**
 * Wire the visitor side to `withPool` (the process's link pool by
 * default): link state, host events of every host a pointer row names, and
 * one delivery pass for the leaves still pending since the last start.
 */
export function startVisitorOps(withPool: VisitorLinkPool = getVisitorLinkPool(), hub?: Hub): void {
  if (hub) hubRef = hub;
  if (pool === withPool) return;
  stopFollowing?.();
  pool = withPool;
  wiredHosts.clear();
  stopFollowing = withPool.onLinkState(onLinkState);
  if (!federationVisits()) return;
  void (async () => {
    const hosts = await getDb().selectDistinct({ host: remoteSpaces.hostInstanceId, url: remoteSpaces.hostUrl }).from(remoteSpaces);
    for (const { host } of hosts) ensureHostWired(host);
    const pending = await getDb().selectDistinct({ host: remoteSpaces.hostInstanceId }).from(remoteSpaces).where(isNotNull(remoteSpaces.leftAt));
    for (const { host } of pending) {
      const [{ url }] = await getDb().select({ url: remoteSpaces.hostUrl }).from(remoteSpaces).where(eq(remoteSpaces.hostInstanceId, host)).limit(1);
      // The pool learns the host's address from a request; a delivery pass makes one.
      visitorPool().link({ instanceId: host, url }).then(
        () => deliverTombstones(host),
        (err: unknown) => log.warn({ err: err instanceof Error ? err.message : String(err), host }, 'Host unreachable at start: its leaves wait for the next link'),
      ).catch((err: unknown) => log.error({ err, host }, 'Delivering leaves at start failed'));
    }
    const { reopenAllAgentListeners } = await import('./visitor-agent');
    await reopenAllAgentListeners();
  })().catch((err: unknown) => log.error({ err }, 'Visitor start-up pass failed'));
}

/** Forget every connection and the pool (tests: a restart of this install). */
export function _resetVisitorOpsForTests(): void {
  for (const conn of tracked.values()) for (const use of conn.hosts.values()) use.release();
  tracked.clear();
  postWaiters.clear();
  postChains.clear();
  delivering.clear();
  wiredHosts.clear();
  stopFollowing?.();
  stopFollowing = null;
  pool = null;
}

