/**
 * The seams between the coworking phases (final security review):
 *
 *   1. a deactivated (or remote) account passes no space door, and its
 *      queued and background space work stops at deactivation;
 *   2. an inactive sponsor is no sponsor: sponsored turns, probes and the
 *      listen gate stop, with an audit row;
 *   3. trajectories of space turns carry their workspace: never in a
 *      personal list, never distilled into a personal skill, purged with
 *      the space;
 *   4. global search never returns another user's personal model rows;
 *   5. a room post that asks the agent needs the `api:chat` token scope;
 *   6. the admin answer routes refuse space and room requests, whatever
 *      the admin's own membership.
 *
 * Backed by ephemeral PGlite, driven through the real `createServer()`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const owner = randomUUID();
const member = randomUUID();
const other = randomUUID();
const admin = randomUUID();
const stranger = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};

// biome-ignore lint/suspicious/noExplicitAny: raw rows
type Row = any;
async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows;
}

async function call(bearer: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Row }> {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  let parsed: Row = text;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-cross-phase-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { getConfig } = await import('@/config');
  getConfig().workspace.rootPath = mkdtempSync(join(tmpdir(), 'octipus-cross-phase-ws-'));
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: owner, username: `owner-${rand(3)}` },
    { id: member, username: `member-${rand(3)}` },
    { id: other, username: `other-${rand(3)}` },
    { id: admin, username: `admin-${rand(3)}`, isAdmin: true },
    { id: stranger, username: `stranger-${rand(3)}` },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', owner], ['member', member], ['other', other], ['admin', admin], ['stranger', stranger]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { createServer } = await import('@/api/server');
  app = createServer();
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function setActive(userId: string, active: boolean) {
  const { setUserActive } = await import('@/security/user-lifecycle');
  const outcome = await setUserActive(userId, active, admin, 'admin');
  expect(outcome).toMatchObject({ status: 'changed', failedSteps: [] });
  if (!active) return;
  // The deactivation revoked the account's sessions: sign in again.
  const { getSessionManager } = await import('@/security/auth/session');
  const name = Object.entries({ owner, member, other, admin, stranger }).find(([, id]) => id === userId)?.[0] as string;
  tokens[name] = (await getSessionManager().create(userId)).token;
}

/** A space of `owner` with `member` and `other` as editors. */
async function space(): Promise<string> {
  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  return spaceWith(owner, [[member, 'editor'], [other, 'editor']]);
}

// ── 1. Deactivated and remote accounts ─────────────────────────────

describe('a deactivated account passes no space door', () => {
  test('membership, room access and the agent scope refuse it; an owner still manages its row', async () => {
    const id = await space();
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 'r', visibility: 'space' });
    const { getMembership } = await import('./service');
    const { roomAccess } = await import('@/core/rooms/access');
    const { resolveAgentScope } = await import('@/core/agent/context');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const session = await sessionRepository.findById(room.id);
    expect(await roomAccess(member, room.id)).not.toBeNull();

    await setActive(member, false);
    try {
      expect(await getMembership(member, id)).toBeNull();
      expect(await roomAccess(member, room.id)).toBeNull();
      await expect(resolveAgentScope({ session, userId: member, trigger: 'room' })).rejects.toMatchObject({ code: 'not_found' });
      // The row is still there, and an owner can still change or remove it.
      expect(await getMembership(member, id, undefined, { anyAccount: true })).toMatchObject({ role: 'editor' });
      const { setRole } = await import('./service');
      await setRole({ userId: owner }, id, member, { role: 'commenter' });
      expect((await q('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [id, member]))[0].role).toBe('commenter');
    } finally {
      await setActive(member, true);
    }
    expect(await getMembership(member, id)).toMatchObject({ role: 'commenter' });
  });

  test('a remote account does not pass either (its membership comes with the S7 transport)', async () => {
    const id = await space();
    const remote = randomUUID();
    await q(
      `INSERT INTO users (id, username, kind, remote_instance_id, remote_user_ref) VALUES ($1, $2, 'remote', 'peer.example', $3)`,
      [remote, `~bob-${rand(3)}@peer.example`, `ref-${rand(3)}`],
    );
    await q(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`, [id, remote]);
    const { getMembership } = await import('./service');
    expect(await getMembership(remote, id)).toBeNull();
  });

  test('deactivation drops queued room turns, cancels queued space jobs and pauses data sources; re-activation resumes them', async () => {
    const id = await space();
    const { createRoom, postRoomMessage } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 'busy', visibility: 'space' });
    const { enqueueRoomTurn, roomQueueSnapshot } = await import('@/core/rooms/queue');
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const published: Row[] = [];
    const spy = vi.spyOn(getGatewayHub(), 'publishToResource').mockImplementation((_resource: string, message: Row) => {
      published.push(message);
      return 0 as never;
    });

    const [artifact] = await q(
      `INSERT INTO artifacts (workspace_id, slug, title, type, created_by_user_id) VALUES ($1, $2, 'A', 'html', $3) RETURNING id`,
      [id, `a-${rand(3)}`, member],
    );
    const [source] = await q(`INSERT INTO artifact_data_sources (artifact_id, name, kind, principal_id) VALUES ($1, 'm', 'http', $2) RETURNING id`, [artifact.id, member]);
    const [job] = await q(`INSERT INTO background_jobs (kind, user_id, title, workspace_id) VALUES ('research', $1, 'job', $2) RETURNING id`, [member, id]);
    const [othersJob] = await q(`INSERT INTO background_jobs (kind, user_id, title, workspace_id) VALUES ('research', $1, 'job', $2) RETURNING id`, [other, id]);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      // `other`'s turn runs; `member`'s request waits behind it.
      const first = await postRoomMessage({ userId: other }, room.id, { content: 'first', addressed: true });
      enqueueRoomTurn(room.id, id, { requesterId: other, requesterName: 'O', messageId: first.message.id, enqueuedAt: new Date() }, () => held);
      await vi.waitFor(() => expect(roomQueueSnapshot(room.id).running?.messageId).toBe(first.message.id));
      const second = await postRoomMessage({ userId: member }, room.id, { content: 'second', addressed: true });
      const ran = vi.fn(async () => undefined);
      enqueueRoomTurn(room.id, id, { requesterId: member, requesterName: 'M', messageId: second.message.id, enqueuedAt: new Date() }, ran);
      expect(roomQueueSnapshot(room.id).queued).toHaveLength(1);

      await setActive(member, false);
      expect(roomQueueSnapshot(room.id).queued).toHaveLength(0);
      const done = published.filter((m) => m.event?.type === 'room.turn' || m.type === 'room.turn')
        .map((m) => m.event?.payload ?? m.payload)
        .find((p: Row) => p?.messageId === second.message.id && p?.state === 'done');
      expect(done).toMatchObject({ outcome: 'dropped' });
      release();
      await vi.waitFor(() => expect(roomQueueSnapshot(room.id).running).toBeNull());
      expect(ran).not.toHaveBeenCalled();

      expect((await q('SELECT status FROM background_jobs WHERE id = $1', [job.id]))[0].status).toBe('cancelled');
      expect((await q('SELECT status FROM background_jobs WHERE id = $1', [othersJob.id]))[0].status).toBe('queued');
      expect((await q('SELECT paused_at FROM artifact_data_sources WHERE id = $1', [source.id]))[0].paused_at).not.toBeNull();
    } finally {
      release();
      spy.mockRestore();
      await setActive(member, true);
    }
    expect((await q('SELECT paused_at FROM artifact_data_sources WHERE id = $1', [source.id]))[0].paused_at).toBeNull();
  });
});

// ── 2. Inactive sponsor ────────────────────────────────────────────

describe('an inactive sponsor is no sponsor', () => {
  test('sponsored turns and the listen gate stop, with an audit row; re-activation restores the sponsor', async () => {
    const id = await space();
    const { setSpaceFunding, spaceFunding } = await import('./funding');
    await setSpaceFunding({ userId: owner }, id, { sponsor: 'me', mode: 'sponsored' });
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 'listen', visibility: 'space' });
    const { setRoomMode, roomListenDeps } = await import('@/core/rooms/listen');
    await setRoomMode({ userId: owner }, id, room.id, { mode: 'listen' });
    const { resolveAgentScope } = await import('@/core/agent/context');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const session = await sessionRepository.findById(room.id);
    expect(await resolveAgentScope({ session, userId: other, trigger: 'room' })).toMatchObject({ funding: 'sponsor', sponsor: { userId: owner } });
    const deps = roomListenDeps();
    const target = (await deps.listGroups()).find((t) => t.id === room.id);
    if (!target) throw new Error('room not listed');
    expect(await deps.isGroupActive(target)).toBe(true);

    const { getAgentManager } = await import('@/core/agent-manager');
    const stop = vi.spyOn(getAgentManager(), 'stopWorkspace');
    await setActive(owner, false);
    try {
      expect(stop).toHaveBeenCalledWith(id, undefined, { funding: 'sponsor' });
      expect((await spaceFunding(id)).sponsorUserId).toBeNull();
      await expect(resolveAgentScope({ session, userId: other, trigger: 'room' })).rejects.toMatchObject({ code: 'funding_off' });
      expect((await deps.listGroups()).map((t) => t.id)).not.toContain(room.id);
      expect(await deps.isGroupActive(target)).toBe(false);
      const audit = await q(`SELECT user_id, details FROM audit_log WHERE workspace_id = $1 AND details->>'reason' = 'sponsor_deactivated'`, [id]);
      expect(audit).toHaveLength(1);
      expect(audit[0].user_id).toBe(admin);
    } finally {
      stop.mockRestore();
      await setActive(owner, true);
    }
    expect((await spaceFunding(id)).sponsorUserId).toBe(owner);
  });
});

// ── 3. Trajectories ────────────────────────────────────────────────

describe('trajectories of space turns', () => {
  async function trajectoryRow(userId: string, rootSessionId: string, workspaceId: string | null): Promise<string> {
    const [row] = await q(
      `INSERT INTO trajectory_runs (user_id, workspace_id, root_session_id, outcome, started_at, ended_at, jsonl_path, jsonl_line)
       VALUES ($1, $2, $3, 'success', now(), now(), '/nowhere.jsonl', 1) RETURNING id`,
      [userId, workspaceId, rootSessionId],
    );
    return row.id;
  }

  test('the recorder stores the space and writes under the space directory, which the purge removes', async () => {
    const id = await space();
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 't', visibility: 'space' });
    const { TrajectoryRecorder } = await import('@/core/trajectories/recorder');
    const recorder = new TrajectoryRecorder({ rootSessionId: room.id, userId: member, userMessage: 'hello', workspaceId: id, spaceId: id });
    await recorder.finalize({ finalResponse: 'hi', outcome: 'success' });
    const [row] = await q('SELECT id, workspace_id, jsonl_path FROM trajectory_runs WHERE root_session_id = $1', [room.id]);
    expect(row.workspace_id).toBe(id);
    const { spaceDirectories } = await import('@/security/workspace-fs');
    expect(row.jsonl_path.startsWith(join(spaceDirectories(id).root, 'trajectories'))).toBe(true);
    expect(existsSync(row.jsonl_path)).toBe(true);

    // Not in the member's personal list.
    const listed = await call(tokens.member, 'GET', '/api/trajectories');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(row.id);

    const { archiveSpace } = await import('./service');
    await archiveSpace({ userId: owner }, id);
    await q(`UPDATE workspaces SET archived_at = now() - interval '30 days' WHERE id = $1`, [id]);
    const { purgeSpace } = await import('./purge');
    await purgeSpace({ userId: owner }, id);
    expect(await q('SELECT 1 FROM trajectory_runs WHERE id = $1', [row.id])).toHaveLength(0);
    expect(existsSync(row.jsonl_path)).toBe(false);
  });

  test("distill_skill reads the caller's own personal runs only: not another user's, not a room's, not in a space", async () => {
    const id = await space();
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 'd', visibility: 'space' });
    // A run recorded before its workspace was stored: only its root session tells.
    const legacy = await trajectoryRow(member, room.id, null);
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const theirs = await trajectoryRow(other, (await seedSession({ userId: other })).id, null);
    const { skillDistillTool } = await import('@/tools/skill-distill');
    // biome-ignore lint/suspicious/noExplicitAny: the private gatherer
    const gather = (ref: string, context: Row) => (skillDistillTool as any).gatherTrajectory(ref, context);
    const personal = { userId: member, workspaceId: null, sessionId: randomUUID(), space: null };

    expect((await gather(theirs, personal)).error).toEqual({ error: `Trajectory run ${theirs} not found` });
    expect((await gather(legacy, personal)).error.error).toMatch(/belongs to a shared space/);
    expect((await gather(legacy, { ...personal, workspaceId: id, space: { workspaceId: id, role: 'editor', scope: null } })).error.error)
      .toMatch(/not available in a shared space/);
  });
});

// ── 4. Search ──────────────────────────────────────────────────────

describe('global search', () => {
  test("returns the caller's own personal models and never another user's", async () => {
    const { createPersonalModel } = await import('@/services/personal-models');
    const slug = `srch${rand(3)}`;
    await createPersonalModel(owner, { slug, provider: 'openai', modelId: 'owner-secret', key: 'sk-owner', topics: ['build'] });
    const mine = await call(tokens.owner, 'GET', `/api/search?q=${slug}`);
    expect(mine.body.results.filter((r: Row) => r.type === 'model').map((r: Row) => r.title)).toEqual([`u/${owner}/${slug}`]);
    const theirs = await call(tokens.stranger, 'GET', '/api/search?q=u/');
    expect(theirs.body.results.filter((r: Row) => r.type === 'model' && String(r.title).startsWith('u/') && !String(r.title).startsWith(`u/${stranger}/`))).toEqual([]);
  });
});

// ── 5. The chat scope of a room post ───────────────────────────────

describe('a room post that asks the agent needs api:chat', () => {
  test('REST: a read-only token posts, but cannot ask; a chat token can', async () => {
    const id = await space();
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 's', visibility: 'space' });
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const readOnly = (await getApiTokenManager().issue(member, { name: `ro-${rand(3)}`, scopes: ['api:read'] })).plaintext;
    const chat = (await getApiTokenManager().issue(member, { name: `chat-${rand(3)}`, scopes: ['api:chat'] })).plaintext;
    const { getAgentService } = await import('@/core/agent');
    const ask = vi.spyOn(getAgentService(), 'handleRoomMessage').mockResolvedValue({ kind: 'queued', position: 1 } as never);
    try {
      const path = `/api/spaces/${id}/rooms/${room.id}/messages`;
      expect((await call(readOnly, 'POST', path, { content: 'hello all' })).status).toBe(201);
      const addressed = await call(readOnly, 'POST', path, { content: 'do it', addressed: true });
      expect(addressed.status).toBe(403);
      expect(addressed.body.error).toMatch(/api:chat/);
      expect((await call(readOnly, 'POST', path, { content: '@octipus do it' })).status).toBe(403);
      expect(ask).not.toHaveBeenCalled();
      const allowed = await call(chat, 'POST', path, { content: 'do it', addressed: true });
      expect(allowed.status).toBe(201);
      expect(ask).toHaveBeenCalledTimes(1);
    } finally {
      ask.mockRestore();
    }
  });

  test('gateway: a scoped connection needs api:chat for frames that drive the agent', async () => {
    const { frameScopeError } = await import('@/core/gateway/message-handler');
    const readOnly = { scopes: ['api:read'] };
    const send = { type: 'chat.send', content: 'hi' } as Row;
    const post = (content: string, addressed?: boolean) => ({ type: 'room.post', roomId: randomUUID(), content, ...(addressed === undefined ? {} : { addressed }) }) as Row;
    expect(frameScopeError(readOnly, send)).toMatch(/api:chat/);
    expect(frameScopeError(readOnly, { type: 'chat.steer', sessionId: randomUUID(), content: 'x' } as Row)).toMatch(/api:chat/);
    expect(frameScopeError(readOnly, { type: 'approval.respond', requestId: 'r', approved: true } as Row)).toMatch(/api:chat/);
    expect(frameScopeError(readOnly, post('ask', true))).toMatch(/api:chat/);
    expect(frameScopeError(readOnly, post('hey @octipus'))).toMatch(/api:chat/);
    expect(frameScopeError(readOnly, post('just chatting'))).toBeNull();
    expect(frameScopeError(readOnly, post('/status', true))).toBeNull();
    expect(frameScopeError(readOnly, { type: 'room.subscribe', roomId: randomUUID() } as Row)).toBeNull();
    // Unscoped (a browser session, an unscoped token) and chat-scoped connections pass.
    expect(frameScopeError({}, send)).toBeNull();
    expect(frameScopeError({ scopes: ['api:chat'] }, post('ask', true))).toBeNull();
    expect(frameScopeError({ scopes: ['api:admin'] }, send)).toBeNull();
  });
});

// ── 6. Admin answers ───────────────────────────────────────────────

describe('the admin answer routes refuse space and room requests', () => {
  test('even for an admin who is a member of the space', async () => {
    const { spaceWith } = await import('@/test-helpers/space-fixtures');
    const id = await spaceWith(owner, [[member, 'editor'], [admin, 'viewer']]);
    const { createRoom } = await import('@/core/rooms/service');
    const room = await createRoom({ userId: owner }, id, { title: 'a', visibility: 'space' });
    const { getPermissionManager } = await import('@/security/permissions');
    const requestId = await getPermissionManager().requestApproval(member, 'agent-m', 'notes', 'read', {}, room.id, 'read_note');

    const list = await call(tokens.admin, 'GET', '/api/admin/permission-requests');
    expect(list.status).toBe(200);
    expect(list.body.requests.map((r: Row) => r.requestId)).not.toContain(requestId);
    const answer = await call(tokens.admin, 'POST', `/api/admin/permission-requests/${requestId}/resolve`, { approved: true, reason: 'unblock' });
    expect(answer.status).toBe(404);
    expect((await q('SELECT status FROM permission_requests WHERE id = $1', [requestId]))[0].status).toBe('pending');

    const { getAgentService } = await import('@/core/agent');
    const service = getAgentService();
    const before = new Set(service.getPendingApprovals(member).map((a) => a.id));
    const pending = service.requestApproval('Read', 'Read my notes into the room?', {
      id: 'agent-m', sessionId: room.id, userId: member, topic: 't', model: 'm', role: 'general',
      status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {},
    } as never);
    pending.catch(() => undefined);
    const approvalId = service.getPendingApprovals(member).find((a) => !before.has(a.id))?.id as string;
    expect(approvalId).toBeTruthy();
    const approvals = await call(tokens.admin, 'GET', '/api/admin/approvals');
    expect(approvals.body.approvals.map((a: Row) => a.requestId)).not.toContain(approvalId);
    expect((await call(tokens.admin, 'POST', `/api/admin/approvals/${approvalId}/resolve`, { approved: true, reason: 'x' })).status).toBe(404);
    expect(service.getPendingApprovals(member).some((a) => a.id === approvalId)).toBe(true);
    await service.expireApprovalsForUser(member, 'done');
  });
});
