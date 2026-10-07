/**
 * The host operations of the peer link (docs/plans/federation-spec.md §6–§7).
 *
 * Every request but `space.join` names its visitor in `as` (the member
 * handle). It is acted on only for a remote row bound to the link's
 * verified instance while that instance is `active` (`resolveVisitor`,
 * FI1); anything else gets a uniform `not_found`.
 *
 * FI2: a visitor has no path a local member of the same role lacks. Gateway
 * frames go through `ConnectionManager.handleMessage` on the visitor's
 * virtual connection (virtual-connection.ts), so the gateway's own parsing,
 * rate buckets and handlers decide. The REST-shaped operations call the
 * same service functions the routes call, with the member's principal
 * (`memberPrincipal`) — and check the role here, because `contentRepos`,
 * `spaceRepos` and `WorkspaceFS` trust their caller:
 *
 *   space.info, space.members (display names only, FI5), space.rooms,
 *   room.page (`roomAccess`, ≤ 200), note.list / note.read, note.propose
 *   (`run_agent_write`, keyed `remote:<row id>`), task.list / read / create
 *   / checkout / release / comment (the tasks routes' repository calls),
 *   file.list / file.read (read-only, guest folders, ≤ 1 MiB), memory.list
 *   (not a guest).
 *
 * Joining (§6.2) redeems an invite in one transaction: the invite is
 * previewed, the instance's live memberships are counted against
 * `federation.maxVisitorsPerInstance`, its `federation_instances` row is
 * written (a blocked one refuses), the remote row is upserted and the invite
 * accepted for it, and `space_joined_remote` is audited. Joins are budgeted
 * per link (5 a minute) and per source address (20 an hour).
 *
 * Revocation (§7.6): `onRemoteMembershipChanged` (a step of
 * `onMembershipChanged`) tells the visitor install `space.revoked` when the
 * membership is gone and closes the visitor's virtual connections once no
 * membership is left; `blockInstance` closes the install's link (4403) and
 * removes every membership of its rows through the normal path.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { contentRepos } from '@/db/repositories/content';
import { memberPrincipal } from '@/db/repositories/space';
import { auditLog } from '@/db/schema/audit';
import { federationInstances } from '@/db/schema/federation';
import { requireCan, SpaceError } from '@/security/space-access';
import { WorkspaceFS, WorkspaceFsError } from '@/security/workspace-fs';
import { logger } from '@/utils/logger';
import { registerHostHandler, type HostRequestContext, inboundLink, onInboundLinkClosed } from './host-server';
import { LinkRequestError, type PeerLink } from './link';
import { federationHosts, onFederationModeChanged } from './mode';
import { CLOSE, type FederationRequestBody, type FederationRequestType, requestBodySchemas } from './protocol';
import {
  liveMembershipsOf,
  type RemoteMember,
  remoteMemberById,
  remoteMembersOf,
  resolveVisitor,
  spacesOfRemote,
  upsertRemoteMember,
} from './remote-members';
import {
  closeAllVirtualConnections,
  closeVirtualConnection,
  closeVirtualConnectionsOf,
  closeVirtualConnectionsOfInstance,
  closeVirtualConnectionsOfLink,
  virtualConnection,
  virtualConnectionCount,
} from './virtual-connection';

const log = logger.child({ component: 'federation-host-ops' });

/** `space.join` requests one link may make per minute. */
export const JOINS_PER_LINK_PER_MINUTE = 5;
/** `space.join` requests one source address may make per hour. */
export const JOINS_PER_IP_PER_HOUR = 20;
/** Largest file `file.read` returns. */
export const FILE_READ_MAX_BYTES = 1024 * 1024;

const joinsByLink = new WeakMap<PeerLink, number[]>();
const joinsByIp = new Map<string, number[]>();

/** Record a join attempt within `windowMs`; false when `max` were already made. */
function takeBudget(times: number[], now: number, windowMs: number, max: number): number[] | null {
  const recent = times.filter((t) => now - t < windowMs);
  if (recent.length >= max) return null;
  recent.push(now);
  return recent;
}

function admitJoin(link: PeerLink, ip: string): void {
  const now = Date.now();
  const perLink = takeBudget(joinsByLink.get(link) ?? [], now, 60_000, JOINS_PER_LINK_PER_MINUTE);
  if (!perLink) throw new LinkRequestError('rate_limited', `At most ${JOINS_PER_LINK_PER_MINUTE} joins a minute on one link`);
  const perIp = takeBudget(joinsByIp.get(ip) ?? [], now, 3_600_000, JOINS_PER_IP_PER_HOUR);
  if (!perIp) throw new LinkRequestError('rate_limited', `At most ${JOINS_PER_IP_PER_HOUR} joins an hour from one address`);
  joinsByLink.set(link, perLink);
  joinsByIp.set(ip, perIp);
}

/** A failed operation as the visitor reads it: `not_found` is uniform (I3, FI1); other refusals keep their code. */
function linkError(err: unknown): unknown {
  if (err instanceof LinkRequestError) return err;
  if (err instanceof SpaceError) {
    return err.code === 'not_found' ? new LinkRequestError('not_found', 'Not found') : new LinkRequestError(err.code, err.message);
  }
  if (err instanceof WorkspaceFsError) {
    return err.code === 'OUTSIDE_SCOPE' || err.code === 'OUTSIDE_ROOT' || err.code === 'TRAVERSAL'
      ? new LinkRequestError('not_found', 'Not found')
      : new LinkRequestError('invalid_input', err.message);
  }
  return err;
}

/** The visitor `as` names, bound to this link's instance (FI1), or `not_found`. */
async function requireVisitor(ctx: HostRequestContext): Promise<RemoteMember> {
  const member = await resolveVisitor(ctx.instanceId, ctx.as);
  if (!member) throw new LinkRequestError('not_found', 'Not found');
  return member;
}

type Op<T extends FederationRequestType> = (body: FederationRequestBody<T>, member: RemoteMember, ctx: HostRequestContext) => Promise<unknown>;

/** Register a visitor operation: body parsed, visitor resolved, errors mapped. */
function op<T extends FederationRequestType>(type: T, run: Op<T>): void {
  registerHostHandler(type, async (raw, ctx) => {
    const body = requestBodySchemas[type].parse(raw) as FederationRequestBody<T>;
    try {
      return await run(body, await requireVisitor(ctx), ctx);
    } catch (err) {
      throw linkError(err);
    }
  });
}

// ── Joining and leaving (§6.2, §6.3) ─────────────────────────────

async function joinSpace(body: FederationRequestBody<'space.join'>, ctx: HostRequestContext): Promise<unknown> {
  if (!federationHosts()) throw new LinkRequestError('federation_off', 'This install does not host spaces for other installs');
  admitJoin(ctx.link, ctx.ip);
  const publicKey = ctx.link.peerPublicKey;
  if (!publicKey) throw new Error('An inbound link carries its peer\'s verified public key');
  const [{ acceptInviteInTx, afterInviteAccepted, previewInvite }, { getMembership, writeSpaceAudit }] = await Promise.all([
    import('@/core/spaces/invites'), import('@/core/spaces/service'),
  ]);
  let outcome: { member: RemoteMember; accepted: Awaited<ReturnType<typeof acceptInviteInTx>>; spaceName: string };
  try {
    outcome = await getDb().transaction(async (tx) => {
      const preview = await previewInvite(body.token, tx);
      if (!preview) throw new SpaceError('not_found', 'Invite not found or expired');
      // Invites never grant ownership; a remote row is at most an editor.
      if ((preview.role as string) === 'owner') throw new LinkRequestError('forbidden_role', 'An invite never makes an owner');
      // The instance row first — the upsert locks it until commit — so two
      // joins of one install count its memberships one after the other.
      const [instance] = await tx
        .insert(federationInstances)
        .values({ instanceId: ctx.instanceId, publicKey, status: 'active' })
        .onConflictDoUpdate({ target: federationInstances.instanceId, set: { lastSeen: sql`now()` } })
        .returning({ status: federationInstances.status, publicKey: federationInstances.publicKey });
      if (instance.status === 'blocked') throw new LinkRequestError('forbidden', 'This install is blocked here');
      if (instance.publicKey !== publicKey) throw new Error(`federation_instances holds another key for ${ctx.instanceId}`);
      const max = getConfig().federation.maxVisitorsPerInstance;
      if ((await liveMembershipsOf(ctx.instanceId, tx)) >= max) {
        throw new LinkRequestError('limit', `Members of your install already hold ${max} memberships here`);
      }
      const member = await upsertRemoteMember(tx, ctx.instanceId, body.user.ref, body.user.name);
      const accepted = await acceptInviteInTx(tx, { userId: member.userId }, body.token);
      if (!accepted.alreadyMember) {
        await writeSpaceAudit(tx, {
          actorId: member.userId,
          action: 'space_joined_remote',
          workspaceId: accepted.workspaceId,
          resourceType: 'space_member',
          resourceId: member.userId,
          details: { instanceId: ctx.instanceId, memberHandle: member.handle, role: accepted.role },
        });
      }
      return { member, accepted, spaceName: preview.spaceName };
    });
  } catch (err) {
    // A dead invite (unknown, revoked, expired, used up, archived space) reads as one answer.
    if (err instanceof SpaceError && err.code === 'not_found') throw new LinkRequestError('invite_invalid', 'Invite not found or expired');
    throw linkError(err);
  }
  await afterInviteAccepted({ userId: outcome.member.userId }, outcome.accepted);
  const membership = await getMembership(outcome.member.userId, outcome.accepted.workspaceId);
  if (!membership) throw new LinkRequestError('not_found', 'Not found');
  log.info({ instanceId: ctx.instanceId, workspaceId: membership.workspaceId, member: outcome.member.handle, role: membership.role }, 'Member of another install joined a space');
  return {
    space: { id: membership.workspaceId, name: outcome.spaceName, role: membership.role, scope: membership.scope },
    member: { handle: outcome.member.handle },
  };
}

// ── Space, rooms, notes, tasks, files, memory (§7.3) ─────────────

/** The member's principal in the space (`memberPrincipal`, read now): `not_found` for a non-member. */
async function principalIn(member: RemoteMember, spaceId: string) {
  return memberPrincipal(member.userId, spaceId);
}

async function membershipIn(member: RemoteMember, spaceId: string) {
  const { getMembership } = await import('@/core/spaces/service');
  const membership = await getMembership(member.userId, spaceId);
  if (!membership) throw new SpaceError('not_found', 'Space not found');
  return membership;
}

/** The text a proposal names as its base: the note's current text, or a base the document hub handed out. */
async function proposalBase(noteId: string, current: { body: string; bodySha256: string }, sha: string): Promise<string> {
  if (current.bodySha256 === sha) return current.body;
  const { getDocHub } = await import('@/core/docs');
  const pinned = getDocHub().baseText(noteId, sha);
  if (pinned === null) throw new LinkRequestError('stale', 'The note changed since it was read: read it again');
  return pinned;
}

interface FileEntry { name: string; type: 'file' | 'dir'; size: number }

async function listDir(absolute: string): Promise<FileEntry[]> {
  const entries = await readdir(absolute, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const size = entry.isFile() ? (await stat(join(absolute, entry.name))).size : 0;
    out.push({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', size });
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

function registerOps(): void {
  registerHostHandler('space.join', async (raw, ctx) => joinSpace(requestBodySchemas['space.join'].parse(raw), ctx));

  op('space.leave', async ({ spaceId }, member) => {
    const { leaveSpace } = await import('@/core/spaces/service');
    const result = await leaveSpace({ userId: member.userId }, spaceId, { instanceId: member.instanceId, memberHandle: member.handle }, 'space_left_remote');
    return result.warning ? { warning: result.warning } : {};
  });

  op('space.info', async ({ spaceId }, member) => {
    const { getSpace } = await import('@/core/spaces/service');
    const membership = await membershipIn(member, spaceId);
    const space = await getSpace({ userId: member.userId }, spaceId);
    return {
      id: space.id, name: space.name, role: space.role, scope: membership.scope, memberCount: space.memberCount,
      archived: space.archivedAt !== null, funding: space.funding, agentEditMode: space.agentEditMode,
    };
  });

  // FI5: display names and roles — never usernames or e-mail addresses.
  op('space.members', async ({ spaceId }, member) => {
    const { listMembers } = await import('@/core/spaces/service');
    const members = await listMembers({ userId: member.userId }, spaceId);
    return { members: members.map((m) => ({ userId: m.userId, displayName: m.displayName ?? '', role: m.role, remote: m.remote === true })) };
  });

  op('space.rooms', async ({ spaceId }, member) => {
    const { listRooms } = await import('@/core/rooms/service');
    return { rooms: await listRooms({ userId: member.userId }, spaceId) };
  });

  op('room.page', async ({ spaceId, roomId, before, after, limit }, member) => {
    const { listRoomMessages } = await import('@/core/rooms/service');
    return listRoomMessages({ userId: member.userId }, spaceId, roomId, { before, after, limit: Math.min(limit ?? 50, 200) });
  });

  op('note.list', async ({ spaceId }, member) => {
    requireCan(await membershipIn(member, spaceId), 'read');
    const notes = await contentRepos(await principalIn(member, spaceId)).notes.list({ limit: 500 });
    return { notes: notes.map((n) => ({ id: n.id, title: n.title, slug: n.slug, updatedAt: n.updatedAt.toISOString() })) };
  });

  op('note.read', async ({ spaceId, noteId }, member) => {
    requireCan(await membershipIn(member, spaceId), 'read');
    const note = await contentRepos(await principalIn(member, spaceId)).notes.getById(noteId);
    if (!note) throw new SpaceError('not_found', 'Note not found');
    return { id: note.id, title: note.title, slug: note.slug, body: note.body, bodySha256: note.bodySha256, updatedAt: note.updatedAt.toISOString() };
  });

  op('note.propose', async ({ spaceId, noteId, baseSha256, body, title }, member) => {
    requireCan(await membershipIn(member, spaceId), 'run_agent_write');
    const repos = contentRepos(await principalIn(member, spaceId));
    repos.assertOpen();
    const note = await repos.notes.getById(noteId);
    if (!note) throw new SpaceError('not_found', 'Note not found');
    const { proposeNoteEdit } = await import('@/core/docs/edit-proposals');
    const { assertSpaceNoteSize } = await import('@/core/knowledge/notes');
    assertSpaceNoteSize(body);
    const proposal = await proposeNoteEdit(repos.noteScope, {
      noteId, sessionId: null, proposerKey: `remote:${member.userId}`, agentId: null, action: 'edit',
      title: title ?? null, baseBody: await proposalBase(noteId, note, baseSha256), baseSha256, body,
    });
    return { proposal: { id: proposal.id, noteId: proposal.noteId, status: proposal.status, updatedAt: proposal.updatedAt.toISOString() } };
  });

  op('task.list', async ({ spaceId, status }, member) => {
    requireCan(await membershipIn(member, spaceId), 'read');
    return { tasks: await contentRepos(await principalIn(member, spaceId)).tasks.listOwn({ status }) };
  });

  op('task.read', async ({ spaceId, taskId }, member) => {
    requireCan(await membershipIn(member, spaceId), 'read');
    const repo = contentRepos(await principalIn(member, spaceId)).tasks;
    const task = await repo.findById(taskId);
    if (!task) throw new SpaceError('not_found', 'Task not found');
    const thread = await repo.listComments(taskId);
    return { task, comments: thread?.comments ?? [], truncated: thread?.truncated ?? false };
  });

  // The task create path of `POST /tasks`, status `open`: a role that writes (editor).
  op('task.create', async ({ spaceId, title, notes, priority }, member) => {
    requireCan(await membershipIn(member, spaceId), 'write');
    const principal = await principalIn(member, spaceId);
    const values = { title, notes: notes ?? null, priority: priority ?? 0, status: 'open' as const, source: 'user' as const };
    const task = await contentRepos(principal).tasks.create(values);
    const { auditTaskMutation, changedTaskFields } = await import('@/core/tasks/audit');
    await auditTaskMutation({
      userId: task.userId, taskId: task.id, op: 'create', change: changedTaskFields(values),
      actor: { kind: 'user', id: member.userId }, runId: null,
    });
    return { task };
  });

  // As `POST /tasks/:id/checkout` and `/release`, the actor being the member.
  op('task.checkout', async ({ spaceId, taskId }, member) => {
    requireCan(await membershipIn(member, spaceId), 'write');
    const result = await contentRepos(await principalIn(member, spaceId)).tasks.checkout(taskId, `user:${member.userId}`, null);
    if (result.ok) return { task: result.task };
    if (result.reason === 'not_found') throw new SpaceError('not_found', 'Task not found');
    throw new LinkRequestError('conflict', result.reason === 'blocked' ? 'Task is blocked' : `Task is ${result.holder ? `checked out by ${result.holder}` : result.status}`);
  });

  op('task.release', async ({ spaceId, taskId }, member) => {
    requireCan(await membershipIn(member, spaceId), 'write');
    const result = await contentRepos(await principalIn(member, spaceId)).tasks.release(taskId, `user:${member.userId}`);
    if (result.ok) return { task: result.task };
    if (result.reason === 'not_found') throw new SpaceError('not_found', 'Task not found');
    throw new LinkRequestError('conflict', `Task is checked out by ${result.holder}`);
  });

  op('task.comment', async ({ spaceId, taskId, body }, member) => {
    requireCan(await membershipIn(member, spaceId), 'comment');
    const comment = await contentRepos(await principalIn(member, spaceId)).tasks.addComment(taskId, { authorKind: 'user', authorRef: member.userId, body });
    if (!comment) throw new SpaceError('not_found', 'Task not found');
    return { comment };
  });

  // Read-only (F-D8): the space's files, a guest's folders only.
  op('file.list', async ({ spaceId, path }, member) => {
    const membership = requireCan(await membershipIn(member, spaceId), 'read');
    const fs = WorkspaceFS.forSpace(spaceId, { guestFolders: membership.scope?.folders });
    const relative = (path ?? '').replace(/^\/+|\/+$/g, '');
    if (!relative && fs.guestFolders) {
      // A guest's root is the folders of their scope that exist.
      const entries: FileEntry[] = [];
      for (const folder of fs.guestFolders) {
        const absolute = fs.resolveOptional(folder);
        if (absolute && (await stat(absolute).catch(() => null))?.isDirectory()) entries.push({ name: folder, type: 'dir', size: 0 });
      }
      return { path: '', entries };
    }
    await fs.ensureRoot();
    const absolute = fs.resolve(relative || '.');
    const info = await stat(absolute).catch(() => null);
    if (!info?.isDirectory()) throw new SpaceError('not_found', 'Folder not found');
    return { path: relative, entries: await listDir(absolute) };
  });

  op('file.read', async ({ spaceId, path }, member) => {
    const membership = requireCan(await membershipIn(member, spaceId), 'read');
    const fs = WorkspaceFS.forSpace(spaceId, { guestFolders: membership.scope?.folders });
    const absolute = fs.resolve(path.replace(/^\/+/, ''));
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new SpaceError('not_found', 'File not found');
    if (info.size > FILE_READ_MAX_BYTES) throw new LinkRequestError('too_large', `Files over ${FILE_READ_MAX_BYTES} bytes are not read over the link`);
    const bytes = await readFile(absolute);
    const text = bytes.toString('utf8');
    const isText = Buffer.from(text, 'utf8').equals(bytes);
    return { path, size: info.size, encoding: isText ? 'utf8' : 'base64', content: isText ? text : bytes.toString('base64') };
  });

  op('memory.list', async ({ spaceId }, member) => {
    const { listSpaceMemory } = await import('@/core/spaces/memory');
    const entries = await listSpaceMemory({ userId: member.userId }, spaceId);
    return { entries: entries.map((e) => ({ id: e.id, body: e.body, authorKind: e.authorKind, createdAt: e.createdAt.toISOString() })) };
  });

  // ── Gateway frames of virtual connections (§7.2) ────────────────

  op('gateway.frame', async ({ frame }, member, ctx) => {
    if (!ctx.conn) throw new LinkRequestError('bad_request', 'gateway.frame names its client connection (conn)');
    // Moderation commands are for members of this install.
    if (frame.type === 'room.post' && typeof frame.content === 'string' && frame.content.trim().startsWith('/')) {
      throw new LinkRequestError('forbidden', 'Room commands are for members of this install');
    }
    // A member with no membership left here has nothing to open a connection for.
    if ((await spacesOfRemote(member.userId)).length === 0) throw new LinkRequestError('not_found', 'Not found');
    const connectionId = virtualConnection(ctx.link, member, ctx.conn);
    const { getGatewayHub } = await import('@/core/gateway/hub');
    await getGatewayHub().connectionManager.handleMessage(connectionId, JSON.stringify(frame));
    return {};
  });

  op('conn.close', async (_body, member, ctx) => {
    if (!ctx.conn) throw new LinkRequestError('bad_request', 'conn.close names its client connection (conn)');
    return { closed: closeVirtualConnection(member.userId, ctx.conn) };
  });
}

let registered = false;

/** Register the host operations and their lifecycle hooks (once). */
export function registerHostOps(): void {
  if (registered) return;
  registered = true;
  registerOps();
  onInboundLinkClosed((link) => { closeVirtualConnectionsOfLink(link); });
  onFederationModeChanged((next) => {
    // The data door refuses remote rows at once, and the endpoint closes
    // every inbound link; their virtual connections go too.
    if (!federationHosts(next)) closeAllVirtualConnections('federation off');
  });
}

// ── Revocation and blocking (§7.6) ───────────────────────────────

/**
 * A step of `onMembershipChanged` for a member of another install: when
 * their membership of `workspaceId` is gone, tell their install
 * (`space.revoked`); when no membership is left here, close their virtual
 * connections. The existing steps prune their room and space
 * subscriptions, document peers and leases of that space, which are
 * ordinary connections. Nothing for a local member.
 */
export async function onRemoteMembershipChanged(workspaceId: string, userId: string): Promise<void> {
  const member = await remoteMemberById(userId);
  if (!member) return;
  const { getMembership } = await import('@/core/spaces/service');
  if (!(await getMembership(userId, workspaceId, getDb(), { anyAccount: true }))) {
    // `conn: '*'`: a notice for every client connection of the member.
    inboundLink(member.instanceId)?.sendEvent(member.handle, '*', { type: 'space.revoked', spaceId: workspaceId });
  }
  if ((await spacesOfRemote(userId)).length === 0) closeVirtualConnectionsOf(userId, 'no membership left');
}

export class FederationAdminError extends Error {
  constructor(readonly code: 'not_found', message: string) {
    super(message);
    this.name = 'FederationAdminError';
  }
}

async function auditInstance(adminId: string, action: 'federation_instance_blocked' | 'federation_instance_unblocked', instanceId: string, details: Record<string, unknown>): Promise<void> {
  await getDb().insert(auditLog).values({ userId: adminId, action, resourceType: 'federation_instance', resourceId: instanceId, details: { instanceId, ...details } });
}

/**
 * Block install `instanceId` (an admin): its rows stop passing the data
 * door at once, its link closes (4403), and every membership its members
 * hold here is removed through the normal path (one audit row each, and
 * `onMembershipChanged`). Returns how many memberships went, and the
 * follow-ups that failed.
 */
export async function blockInstance(adminId: string, instanceId: string): Promise<{ removed: number; warnings: string[] }> {
  const [row] = await getDb()
    .update(federationInstances)
    .set({ status: 'blocked', blockedBy: adminId, blockedAt: new Date() })
    .where(eq(federationInstances.instanceId, instanceId))
    .returning({ id: federationInstances.instanceId });
  if (!row) throw new FederationAdminError('not_found', 'Unknown instance');
  inboundLink(instanceId)?.close(CLOSE.forbidden, 'instance blocked');
  closeVirtualConnectionsOfInstance(instanceId, 'instance blocked');
  const { leaveSpace } = await import('@/core/spaces/service');
  let removed = 0;
  const warnings: string[] = [];
  for (const member of await remoteMembersOf(instanceId)) {
    for (const workspaceId of await spacesOfRemote(member.userId)) {
      const result = await leaveSpace({ userId: member.userId }, workspaceId, {
        instanceBlocked: true, blockedBy: adminId, instanceId, memberHandle: member.handle,
      });
      removed++;
      if (result.warning) warnings.push(result.warning);
    }
  }
  await auditInstance(adminId, 'federation_instance_blocked', instanceId, { membershipsRemoved: removed });
  log.warn({ instanceId, by: adminId, removed }, 'Federation instance blocked');
  return { removed, warnings };
}

/** Unblock install `instanceId`: the status only — removed memberships stay removed. */
export async function unblockInstance(adminId: string, instanceId: string): Promise<void> {
  const [row] = await getDb()
    .update(federationInstances)
    .set({ status: 'active', blockedBy: null, blockedAt: null })
    .where(eq(federationInstances.instanceId, instanceId))
    .returning({ id: federationInstances.instanceId });
  if (!row) throw new FederationAdminError('not_found', 'Unknown instance');
  await auditInstance(adminId, 'federation_instance_unblocked', instanceId, {});
  log.info({ instanceId, by: adminId }, 'Federation instance unblocked');
}

export interface FederationInstanceView {
  instanceId: string;
  badge: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  blockedAt: string | null;
  linkUp: boolean;
  liveMemberships: number;
  turnsInFlight: number;
  virtualConnections: number;
}

/** Every install whose members joined here, with its state (Admin → Federation). */
export async function listInstances(): Promise<FederationInstanceView[]> {
  const rows = await getDb().select().from(federationInstances).orderBy(sql`${federationInstances.lastSeen} DESC`);
  const [{ instanceBadge }, { remoteTurnsOf }] = await Promise.all([import('@/security/user-kinds'), import('@/core/rooms/queue')]);
  const views: FederationInstanceView[] = [];
  for (const row of rows) {
    views.push({
      instanceId: row.instanceId,
      badge: instanceBadge(row.instanceId),
      status: row.status,
      firstSeen: row.firstSeen.toISOString(),
      lastSeen: row.lastSeen.toISOString(),
      blockedAt: row.blockedAt?.toISOString() ?? null,
      linkUp: !!inboundLink(row.instanceId),
      liveMemberships: await liveMembershipsOf(row.instanceId),
      turnsInFlight: remoteTurnsOf(row.instanceId),
      virtualConnections: virtualConnectionCount(row.instanceId),
    });
  }
  return views;
}

/** Forget the join budgets (tests). */
export function _resetHostOpsForTests(): void {
  joinsByIp.clear();
}
