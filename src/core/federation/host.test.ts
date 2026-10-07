/**
 * The host side of spaces across installs (docs/plans/federation-spec.md
 * §6–§7; tests of §11 items 4–10, 12 and 13, host parts).
 *
 * Two installs in one process. The host: a real database (PGlite), the real
 * spaces, rooms, docs, tasks and approval code, the real REST routes
 * (`createServer()`), the real gateway hub with its message handler and the
 * real `/federation` endpoint on 127.0.0.1. The visitor: a minimal one, the
 * guarded dialer and a `PeerLink` (slice 2) with its own identity, sending
 * the frames a visitor install sends. The model is the only stand-in:
 * `runRootAgent` records each turn's scope and asks the real
 * `routeApprovalFor` what a few calls would get.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { globSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

interface RecordedTurn {
  sessionId: string;
  userId: string;
  scope: { trigger: string; funding: string; audienceFederated?: boolean };
  decisions: { ask: string; personal: string; personalReason?: string };
}

const fx = vi.hoisted(() => ({ turns: [] as RecordedTurn[], hold: null as Promise<void> | null }));

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getDefaultModel: async () => ({ modelId: 'test-model', name: 'test-model' }),
    getAllModels: async () => [{ modelId: 'test-model' }],
    getModelForTopic: async () => null,
    getModelByModelId: async () => null,
    getModel: async () => null,
  }),
}));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({
  retrieveForContext: async () => [],
  renderMemoriesBlock: () => '',
  updateMemoriesAfterTurn: async () => [],
}));
vi.mock('@/core/learning/queue', () => ({ enqueueTurnLearning: async () => {} }));
vi.mock('@/core/agent/root-runner', () => ({
  runRootAgent: async (...args: unknown[]) => {
    const [, , sessionId, userId, , , , , , scope, , extras] = args as [
      unknown, unknown, string, string, string, unknown, unknown, unknown, string, RecordedTurn['scope'], unknown, { signal?: AbortSignal },
    ];
    extras?.signal?.throwIfAborted();
    const [{ buildAgentContext }, { routeApprovalFor }] = await Promise.all([import('@/core/agent/context'), import('@/security/approval-route')]);
    const ctx = buildAgentContext({ sessionId, userId, scope: scope as never, topic: 'general', model: 'test-model', role: 'general', root: true, attended: true });
    // What two calls would get in this turn: one the policy asks a human for,
    // and a read of the requester's private mail.
    const ask = await routeApprovalFor(ctx, { toolId: 'tasks', action: 'write', toolName: 'create_task' }, { level: 'ASK' });
    const personal = await routeApprovalFor(ctx, { toolId: 'google-workspace', action: 'email_read' }, { level: 'ALLOW' });
    fx.turns.push({ sessionId, userId, scope, decisions: { ask: ask.route, personal: personal.route, personalReason: personal.reason } });
    const { recordProviderUsage } = await import('@/models/providers/instrumented');
    await recordProviderUsage({ model: 'test-model', messages: [], sessionId }, 'test', { model: 'test-model', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    if (fx.hold) await fx.hold;
    return { response: `Answer for ${userId}`, agentId: randomUUID(), sources: [], outcome: 'success' };
  },
}));

type Identity = import('./identity').InstanceIdentity;
type LinkEvent = import('./protocol').LinkEvent;
type PeerLink = import('./link').PeerLink;
type Frame = Record<string, any>;

const LAN = ['127.0.0.1/32'];
const ownerId = randomUUID();
const adminId = randomUUID();
const annaLocalId = randomUUID();
/** Local members of each role, for the parity table. */
const local: Record<string, string> = { editor: randomUUID(), commenter: randomUUID(), viewer: randomUUID(), guest: randomUUID() };
const tokens: Record<string, string> = {};

let hostId: Identity;
let visitorB: Identity;
let visitorC: Identity;
let url = '';
let app: { handle(request: Request): Promise<Response> };
let stopServer: () => void;

async function q<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows as T[];
}

async function waitFor<T>(read: () => T | Promise<T>, what: string, ms = 8_000): Promise<NonNullable<T>> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const pause = (ms = 120) => new Promise((r) => setTimeout(r, ms));

async function call(userId: string, method: string, path: string, body?: unknown, space?: string): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[userId]}` };
  if (space) headers['x-octipus-workspace'] = space;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

// ── The visitor install ───────────────────────────────────────────────

interface Visitor {
  link: PeerLink;
  events: LinkEvent[];
  req(type: string, body: unknown, as?: string, conn?: string): Promise<any>;
  /** The error code of a refused request (null when it succeeded). */
  refusal(type: string, body: unknown, as?: string, conn?: string): Promise<string | null>;
  frame(as: string, conn: string, frame: Frame): Promise<any>;
  /** Gateway messages the host sent to (`as`, `conn`). */
  messages(as: string, conn: string): Frame[];
}

async function dialVisitor(identity: Identity): Promise<Visitor> {
  const { dialPeer } = await import('./dialer');
  const events: LinkEvent[] = [];
  const link = await dialPeer(url, hostId.instanceId, {
    identity, lanCidrs: LAN, onRequest: async () => ({}), onEvent: (e) => { events.push(e); },
  });
  // Paced under the host's 60 frames a second, as a visitor install's pool is.
  let last = 0;
  const req = async (type: string, body: unknown, as?: string, conn?: string) => {
    const wait = last + 20 - Date.now();
    if (wait > 0) await pause(wait);
    last = Date.now();
    return link.request(type, body, { as, conn });
  };
  return {
    link,
    events,
    req,
    refusal: async (type, body, as, conn) => req(type, body, as, conn).then(() => null, (e: { code?: string }) => e.code ?? String(e)),
    frame: (as, conn, frame) => req('gateway.frame', { frame }, as, conn),
    messages: (as, conn) => events.filter((e) => e.as === as && e.conn === conn).map((e) => e.body as Frame),
  };
}

async function inviteToken(spaceId: string, role: 'editor' | 'commenter' | 'viewer' | 'guest', scope?: unknown): Promise<string> {
  const { createInvite } = await import('@/core/spaces/invites');
  return (await createInvite({ userId: ownerId }, spaceId, { role, scope })).token;
}

async function joinAs(v: Visitor, ref: string, name: string, spaceId: string, role: 'editor' | 'commenter' | 'viewer' | 'guest', scope?: unknown) {
  return v.req('space.join', { token: await inviteToken(spaceId, role, scope), user: { ref, name } }) as Promise<{
    space: { id: string; name: string; role: string; scope: unknown }; member: { handle: string };
  }>;
}

async function rowOf(handle: string): Promise<{ id: string; remote_instance_id: string; kind: string }> {
  const [row] = await q<{ id: string; remote_instance_id: string; kind: string }>('SELECT id, remote_instance_id, kind FROM users WHERE username = $1', [handle]);
  return row;
}

// ── Local gateway tabs ────────────────────────────────────────────────

interface Tab { id: string; userId: string; frames: Frame[]; send(msg: Frame): Promise<void> }

async function tab(userId: string): Promise<Tab> {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const hub = getGatewayHub();
  const frames: Frame[] = [];
  const ws = { data: {}, readyState: 1, send: (f: string) => frames.push(JSON.parse(f)), close: () => {} };
  const id = hub.connectionManager.handleOpen(ws, '127.0.0.1') as string;
  const send = async (msg: Frame) => { await hub.connectionManager.handleMessage(id, JSON.stringify(msg)); };
  await send({ type: 'auth', method: 'session_token', credentials: { token: userId }, clientType: 'webchat' });
  expect(frames.at(-1)).toMatchObject({ type: 'auth_ok', userId });
  return { id, userId, frames, send };
}

async function closeTab(t: Tab): Promise<void> {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  getGatewayHub().connectionManager.handleClose(t.id, 1000, 'test');
}

async function settleRoom(roomId: string): Promise<void> {
  const [{ roomQueueSnapshot }, { roomDeliveries }] = await Promise.all([import('@/core/rooms/queue'), import('@/core/rooms/fanout')]);
  await waitFor(() => { const s = roomQueueSnapshot(roomId); return !s.running && s.queued.length === 0; }, 'room queue to drain');
  await roomDeliveries(roomId);
  await pause(40);
  await roomDeliveries(roomId);
}

async function createNote(spaceId: string, slug: string, title: string, body: string): Promise<string> {
  const res = await call(ownerId, 'POST', '/api/notes', { slug, title, body }, spaceId);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()).note.id;
}

async function generalOf(spaceId: string): Promise<string> {
  const [row] = await q<{ id: string }>(`SELECT id FROM sessions WHERE workspace_id = $1 AND kind = 'room' AND title = 'General'`, [spaceId]);
  return row.id;
}

async function newSpace(name: string): Promise<{ id: string; general: string }> {
  const { createSpace } = await import('@/core/spaces/service');
  const space = await createSpace({ userId: ownerId }, { name });
  return { id: space.id, general: await generalOf(space.id) };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-fed-host-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octipus-fed-host-files-')));
  const cfg = getConfig();
  cfg.federation.mode = 'both';
  cfg.federation.lanCidrs = LAN;
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  // The invite route reads the install identity (a vault system secret).
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'fh-owner' },
    { id: adminId, username: 'fh-admin', isAdmin: true },
    { id: annaLocalId, username: 'anna' },
    ...Object.entries(local).map(([role, id]) => ({ id, username: `fh-${role}` })),
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const id of [ownerId, adminId, annaLocalId, ...Object.values(local)]) tokens[id] = (await getSessionManager().create(id)).token;

  const { createServer } = await import('@/api/server');
  app = createServer();
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const hub = getGatewayHub();
  hub.setSessionValidator(async (token) => ({ userId: token, username: token, isAdmin: false }));
  hub.setWorkspaceResolver(async () => 'ws');
  const { wireMessageHandler } = await import('@/core/gateway/message-handler');
  wireMessageHandler(hub);
  const { startRoomFanout } = await import('@/core/rooms/fanout');
  await startRoomFanout();

  const identity = await import('./identity');
  hostId = identity.identityFromPrivateKeyPem(identity.generateIdentityPem());
  visitorB = identity.identityFromPrivateKeyPem(identity.generateIdentityPem());
  visitorC = identity.identityFromPrivateKeyPem(identity.generateIdentityPem());
  const { App, listen } = await import('@/api/http');
  const { setupFederationWebSocket } = await import('./host-server');
  const endpoint = new App();
  // biome-ignore lint/suspicious/noExplicitAny: the route builder type the server passes
  setupFederationWebSocket(endpoint as any, { identity: async () => hostId });
  const server = listen(endpoint, { hostname: '127.0.0.1', port: 0 });
  await waitFor(() => server.port !== 0, 'the endpoint to listen');
  url = `ws://127.0.0.1:${server.port}/federation`;
  stopServer = () => server.stop();
}, 120_000);

afterAll(async () => {
  const { _resetFederationHostForTests } = await import('./host-server');
  _resetFederationHostForTests();
  stopServer?.();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  fx.turns.length = 0;
  fx.hold = null;
  const { getConfig } = await import('@/config');
  const cfg = getConfig();
  cfg.federation.mode = 'both';
  cfg.federation.lanCidrs = LAN;
  cfg.federation.maxVisitorsPerInstance = 50;
  cfg.federation.maxRemoteTurnsPerInstance = 5;
  cfg.federation.agentPostsPerHour = 20;
  const { _resetHostOpsForTests } = await import('./host-ops');
  _resetHostOpsForTests();
});

// ── §6: joining and leaving ───────────────────────────────────────────

describe('joining (§6.2)', () => {
  test('a join creates one remote row bound to the visitor install; a second space reuses it', async () => {
    const v = await dialVisitor(visitorB);
    const x = await newSpace('Join X');
    const y = await newSpace('Join Y');
    const first = await joinAs(v, 'b-user-1', 'Anna Schmidt', x.id, 'editor');
    expect(first.space).toMatchObject({ id: x.id, name: 'Join X', role: 'editor', scope: null });
    expect(first.member.handle).toBe(`~anna-schmidt@${visitorB.instanceId.slice(0, 8)}`);
    const second = await joinAs(v, 'b-user-1', 'Anna S.', y.id, 'viewer');
    expect(second.member.handle).toBe(first.member.handle);
    const rows = await q('SELECT id, kind, remote_instance_id, remote_user_ref, email, password_hash, install_models FROM users WHERE remote_user_ref = $1', ['b-user-1']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'remote', remote_instance_id: visitorB.instanceId, email: null, password_hash: null, install_models: false });
    const [instance] = await q('SELECT status, public_key FROM federation_instances WHERE instance_id = $1', [visitorB.instanceId]);
    expect(instance).toEqual({ status: 'active', public_key: visitorB.publicKeySpkiB64 });
    const audit = await q(`SELECT details FROM audit_log WHERE action = 'space_joined_remote' AND workspace_id = $1`, [x.id]);
    expect(audit[0].details).toMatchObject({ instanceId: visitorB.instanceId, memberHandle: first.member.handle, role: 'editor' });
    // Another user of the same name on B gets a suffix; the same ref on C is another row.
    const other = await joinAs(v, 'b-user-2', 'Anna Schmidt', x.id, 'viewer');
    expect(other.member.handle).toBe(`~anna-schmidt-2@${visitorB.instanceId.slice(0, 8)}`);
    const c = await dialVisitor(visitorC);
    const onC = await joinAs(c, 'b-user-1', 'Anna Schmidt', x.id, 'viewer');
    expect(onC.member.handle).toBe(`~anna-schmidt@${visitorC.instanceId.slice(0, 8)}`);
    c.link.close(4000, 'done');
  });

  test('a dead token is invite_invalid; owner is never granted', async () => {
    const v = await dialVisitor(visitorB);
    const x = await newSpace('Dead token');
    expect(await v.refusal('space.join', { token: 'a'.repeat(64), user: { ref: 'b-dead', name: 'Dee' } })).toBe('invite_invalid');
    const token = await inviteToken(x.id, 'viewer');
    const { revokeInvite } = await import('@/core/spaces/invites');
    const [{ id }] = await q<{ id: string }>('SELECT id FROM workspace_invites WHERE workspace_id = $1', [x.id]);
    await revokeInvite({ userId: ownerId }, x.id, id);
    expect(await v.refusal('space.join', { token, user: { ref: 'b-dead', name: 'Dee' } })).toBe('invite_invalid');
    expect(await q('SELECT 1 FROM users WHERE remote_user_ref = $1', ['b-dead'])).toHaveLength(0);

    // An owner invite does not exist; promoting a remote member to owner (an
    // ownership hand-over) is refused, by the service and by the database.
    const { createInvite } = await import('@/core/spaces/invites');
    await expect(createInvite({ userId: ownerId }, x.id, { role: 'owner' })).rejects.toMatchObject({ code: 'invalid_role' });
    const { member } = await joinAs(v, 'b-promote', 'Pro', x.id, 'editor');
    const row = await rowOf(member.handle);
    const { setRole } = await import('@/core/spaces/service');
    await expect(setRole({ userId: ownerId }, x.id, row.id, { role: 'owner' })).rejects.toMatchObject({ code: 'forbidden_role' });
    expect((await call(ownerId, 'PATCH', `/api/spaces/${x.id}/members/${row.id}`, { role: 'owner' })).status).toBe(403);
    await expect(q(`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`, [x.id, row.id])).rejects.toThrow(/workspace_members_remote_owner_chk/);
  });

  test('the live-membership cap of an install holds', async () => {
    const { getConfig } = await import('@/config');
    const c = await dialVisitor(visitorC);
    const x = await newSpace('Cap');
    const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.remote_instance_id = $1`, [visitorC.instanceId]);
    getConfig().federation.maxVisitorsPerInstance = n + 1;
    await joinAs(c, 'c-cap-1', 'One', x.id, 'viewer');
    expect(await c.refusal('space.join', { token: await inviteToken(x.id, 'viewer'), user: { ref: 'c-cap-2', name: 'Two' } })).toBe('limit');
    c.link.close(4000, 'done');
  });

  test('joins are budgeted per link and per source address', async () => {
    const body = () => ({ token: rand(32), user: { ref: 'b-budget', name: 'Budget' } });
    const first = await dialVisitor(visitorB);
    for (let i = 0; i < 5; i++) expect(await first.refusal('space.join', body())).toBe('invite_invalid');
    expect(await first.refusal('space.join', body())).toBe('rate_limited');
    // Fresh links from the same address: 20 an hour in all.
    let made = 5;
    while (made < 20) {
      const v = await dialVisitor(visitorB);
      for (let i = 0; i < 5 && made < 20; i++, made++) expect(await v.refusal('space.join', body())).toBe('invite_invalid');
    }
    const last = await dialVisitor(visitorB);
    expect(await last.refusal('space.join', body())).toBe('rate_limited');
  });

  test('a source test finds no other writer of kind remote', () => {
    const files = (globSyncTs('src')).filter((f) => !/\.(test|spec)\.ts$/.test(f));
    const writers = files.filter((f) => /kind:\s*['"]remote['"]/.test(readFileSync(f, 'utf8')));
    expect(writers).toEqual(['src/core/federation/remote-members.ts']);
    const sqlWriters = files.filter((f) => /INSERT INTO users[^;]*'remote'|SET\s+kind\s*=\s*'remote'/i.test(readFileSync(f, 'utf8')));
    expect(sqlWriters).toEqual([]);
  });

  test('space.leave removes the membership through the normal path', async () => {
    const v = await dialVisitor(visitorB);
    const x = await newSpace('Leave');
    const { member } = await joinAs(v, 'b-leaver', 'Leaver', x.id, 'commenter');
    const row = await rowOf(member.handle);
    expect(await v.req('space.leave', { spaceId: x.id }, member.handle)).toEqual({});
    expect(await q('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [x.id, row.id])).toHaveLength(0);
    const [audit] = await q(`SELECT details FROM audit_log WHERE action = 'space_left_remote' AND workspace_id = $1`, [x.id]);
    expect(audit.details).toMatchObject({ left: true, instanceId: visitorB.instanceId, memberHandle: member.handle });
    expect(await v.refusal('space.info', { spaceId: x.id }, member.handle)).toBe('not_found');
  });

  test('invites carry the host fingerprint when this install hosts', async () => {
    const x = await newSpace('Federated invite');
    const previous = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = 'https://host.example';
    try {
      const res = await call(ownerId, 'POST', `/api/spaces/${x.id}/invites`, { role: 'viewer' });
      expect(res.status).toBe(201);
      const body = await res.json();
      const { getInstanceIdentity } = await import('./identity');
      expect(body.url).toBe(`https://host.example/join/${body.token}`);
      expect(body.federatedUrl).toBe(`https://host.example/join/${body.token}#octipus=${(await getInstanceIdentity()).instanceId}`);
      const { getConfig } = await import('@/config');
      getConfig().federation.mode = 'visit';
      const plain = await (await call(ownerId, 'POST', `/api/spaces/${x.id}/invites`, { role: 'viewer' })).json();
      expect(plain.federatedUrl).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = previous;
    }
  });
});

/** Every .ts file under `dir`, relative to the repo root. */
function globSyncTs(dir: string): string[] {
  return globSync(`${dir}/**/*.ts`);
}

// ── FI1 and the data door (§7.1) ──────────────────────────────────────

describe('FI1: a frame acts only for a member of the link\'s own install', () => {
  test('another install\'s member, an unknown handle, a revoked member and a blocked install get not_found', async () => {
    const b = await dialVisitor(visitorB);
    const c = await dialVisitor(visitorC);
    const x = await newSpace('FI1');
    const onB = await joinAs(b, 'b-fi1', 'Fia', x.id, 'editor');
    const onC = await joinAs(c, 'c-fi1', 'Cia', x.id, 'editor');
    expect(await b.req('space.info', { spaceId: x.id }, onB.member.handle)).toMatchObject({ id: x.id, role: 'editor' });
    // B naming C's member, an unknown handle, no handle at all.
    expect(await b.refusal('space.info', { spaceId: x.id }, onC.member.handle)).toBe('not_found');
    expect(await b.refusal('space.info', { spaceId: x.id }, `~nobody@${visitorB.instanceId.slice(0, 8)}`)).toBe('not_found');
    expect(await b.refusal('space.info', { spaceId: x.id })).toBe('not_found');
    expect(await b.refusal('gateway.frame', { frame: { type: 'ping' } }, onC.member.handle, 'tab-1')).toBe('not_found');
    // A local username is no handle.
    expect(await b.refusal('space.info', { spaceId: x.id }, 'fh-owner')).toBe('not_found');
    // Revoked: removed from the space.
    const { removeMember } = await import('@/core/spaces/service');
    await removeMember({ userId: ownerId }, x.id, (await rowOf(onB.member.handle)).id);
    expect(await b.refusal('space.info', { spaceId: x.id }, onB.member.handle)).toBe('not_found');
    // A blocked install: refused by the door before anything else.
    await q(`UPDATE federation_instances SET status = 'blocked' WHERE instance_id = $1`, [visitorC.instanceId]);
    try {
      expect(await c.refusal('space.info', { spaceId: x.id }, onC.member.handle)).toBe('not_found');
    } finally {
      await q(`UPDATE federation_instances SET status = 'active' WHERE instance_id = $1`, [visitorC.instanceId]);
    }
    expect(await c.req('space.info', { spaceId: x.id }, onC.member.handle)).toMatchObject({ id: x.id });
    c.link.close(4000, 'done');
  });
});

describe('the data door (§7.1)', () => {
  test('a remote row passes getMembership only while its install is active and this install hosts', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Door');
    const { member } = await joinAs(b, 'b-door', 'Door', x.id, 'editor');
    const row = await rowOf(member.handle);
    const { getMembership } = await import('@/core/spaces/service');
    const { getConfig } = await import('@/config');
    expect(await getMembership(row.id, x.id)).toMatchObject({ role: 'editor', remote: { instanceId: visitorB.instanceId } });
    expect((await getMembership(ownerId, x.id))?.remote).toBeNull();
    for (const mode of ['host', 'both'] as const) {
      getConfig().federation.mode = mode;
      expect(await getMembership(row.id, x.id)).not.toBeNull();
    }
    for (const mode of ['visit', 'off'] as const) {
      getConfig().federation.mode = mode;
      expect(await getMembership(row.id, x.id)).toBeNull();
      // Locals are unaffected.
      expect(await getMembership(ownerId, x.id)).not.toBeNull();
    }
    getConfig().federation.mode = 'both';
    await q(`UPDATE federation_instances SET status = 'blocked' WHERE instance_id = $1`, [visitorB.instanceId]);
    expect(await getMembership(row.id, x.id)).toBeNull();
    // Managing the row still reads it (an owner removes a blocked install's member).
    expect(await getMembership(row.id, x.id, undefined, { anyAccount: true })).toMatchObject({ role: 'editor' });
    await q(`UPDATE federation_instances SET status = 'active' WHERE instance_id = $1`, [visitorB.instanceId]);
    expect(await getMembership(row.id, x.id)).not.toBeNull();
  });

  test('listen, funding, install access, channel bindings and API tokens still refuse a remote row', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Local only');
    const { member } = await joinAs(b, 'b-local-only', 'Lo', x.id, 'editor');
    const row = await rowOf(member.handle);
    // Listen: a remote member's question never starts a listen turn.
    const { messageRepository } = await import('@/db/repositories/message-repository');
    const posted = await messageRepository.create({ sessionId: x.general, role: 'user', content: 'how do I deploy?', authorUserId: row.id, metadata: {} });
    const { getAgentService } = await import('@/core/agent');
    expect(await getAgentService().handleRoomListen(x.general, row.id, posted.id)).toBeNull();
    // Funding: a remote row is no sponsor.
    await q('UPDATE workspaces SET sponsor_user_id = $1, agent_funding = $2 WHERE id = $3', [row.id, 'unattended', x.id]);
    const { spaceFunding } = await import('@/core/spaces/funding');
    expect((await spaceFunding(x.id)).sponsorUserId).toBeNull();
    await q('UPDATE workspaces SET sponsor_user_id = NULL, agent_funding = $1 WHERE id = $2', ['own', x.id]);
    // Install models.
    const { mayUseInstallModels } = await import('@/models/install-access');
    expect(await mayUseInstallModels(row.id)).toBe(false);
    // Channel bindings.
    await q(`INSERT INTO channel_identities (user_id, channel_type, external_id, verified_at) VALUES ($1, 'telegram', 'tg-remote', now())`, [row.id]);
    const { ChannelBindingManager } = await import('@/security/channel-bindings');
    expect(await new ChannelBindingManager().findUserByExternalId('telegram', 'tg-remote')).toBeNull();
    // API tokens.
    const { getApiTokenManager } = await import('@/security/api-tokens');
    await expect(getApiTokenManager().issue(row.id, { name: 'x' } as never)).rejects.toThrow(/other installs/);
    // No private session, agent or pipeline of theirs runs here.
    const { resolveAgentScope } = await import('@/core/agent/context');
    await expect(resolveAgentScope({ session: null, userId: row.id, trigger: 'user', workspaceId: x.id })).rejects.toMatchObject({ code: 'forbidden_role' });
  });

  test('a queued room turn and its approval routing see the membership the frame did', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Queued');
    const { setSpaceFunding } = await import('@/core/spaces/funding');
    await setSpaceFunding({ userId: ownerId }, x.id, { mode: 'unattended', sponsor: 'me' });
    const { member } = await joinAs(b, 'b-queued', 'Queue', x.id, 'editor');
    await b.frame(member.handle, 'tab-q', { type: 'room.post', roomId: x.general, content: 'please summarise @octipus' });
    await waitFor(() => fx.turns.find((t) => t.sessionId === x.general), 'the queued remote turn to run');
    await settleRoom(x.general);
    const turn = fx.turns.find((t) => t.sessionId === x.general) as RecordedTurn;
    // The turn ran as the remote member (its access read in the queue's own
    // context), and the approval route did not find them gone: the personal
    // read is refused for the federated audience, not for a lost membership.
    expect(turn.userId).toBe((await rowOf(member.handle)).id);
    expect(turn.decisions.personalReason).toMatch(/other installs/);
  });
});

// ── FI2: parity with a local member of the same role (§7.2, §7.3) ─────

describe('FI2 parity: every frame and operation as for a local member of the role', () => {
  type Role = 'editor' | 'commenter' | 'viewer' | 'guest';
  const ROLES: Role[] = ['editor', 'commenter', 'viewer', 'guest'];
  let space = '';
  let general = '';
  let leads = '';
  let notePlan = '';
  let noteBrief = '';
  const taskIn: Record<'general' | 'leads', string> = { general: '', leads: '' };
  const handles: Partial<Record<Role, string>> = {};
  let b: Visitor;

  beforeAll(async () => {
    b = await dialVisitor(visitorB);
    const s = await newSpace('Parity');
    space = s.id;
    general = s.general;
    const res = await call(ownerId, 'POST', `/api/spaces/${space}/rooms`, { title: 'Leads', visibility: 'private', memberIds: [] });
    leads = (await res.json()).id;
    const scope = { rooms: [general], folders: ['shared'] };
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    for (const role of ROLES) {
      const inv = await createInvite({ userId: ownerId }, space, { role, scope: role === 'guest' ? scope : undefined });
      await acceptInvite({ userId: local[role] }, inv.token);
      handles[role] = (await joinAs(b, `b-parity-${role}`, `Parity ${role}`, space, role, role === 'guest' ? scope : undefined)).member.handle;
    }
    notePlan = await createNote(space, 'plan', 'Plan', 'the plan');
    noteBrief = await createNote(space, 'shared/brief', 'Brief', 'the brief');
    expect(notePlan && noteBrief).toBeTruthy();
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { contentRepos } = await import('@/db/repositories/content');
    const owner = contentRepos(await resolvedPrincipal(ownerId, space));
    taskIn.general = (await owner.tasks.create({ title: 'From general', sourceRef: { sessionId: general } } as never)).id;
    taskIn.leads = (await owner.tasks.create({ title: 'From leads', sourceRef: { sessionId: leads } } as never)).id;
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const fs = WorkspaceFS.forSpace(space);
    await fs.ensureRoot();
    mkdirSync(join(fs.root, 'shared'), { recursive: true });
    writeFileSync(join(fs.root, 'shared', 'readme.md'), 'shared readme');
    writeFileSync(join(fs.root, 'secret.md'), 'top secret');
  });

  /** What a local tab got after a frame: deny when an error came back. */
  async function localFrame(t: Tab, frame: Frame): Promise<'allow' | 'deny'> {
    const before = t.frames.length;
    await t.send(frame);
    await pause();
    return t.frames.slice(before).some((f) => f.type === 'error') ? 'deny' : 'allow';
  }

  async function remoteFrame(handle: string, conn: string, frame: Frame): Promise<'allow' | 'deny'> {
    const before = b.messages(handle, conn).length;
    const refused = await b.refusal('gateway.frame', { frame }, handle, conn);
    if (refused) return 'deny';
    await pause();
    return b.messages(handle, conn).slice(before).some((f) => f.type === 'error') ? 'deny' : 'allow';
  }

  const FRAMES = (): Array<[string, Frame]> => [
    ['ping', { type: 'ping' }],
    ['space.subscribe', { type: 'space.subscribe', spaceId: space }],
    ['room.subscribe general', { type: 'room.subscribe', roomId: general }],
    ['room.subscribe leads', { type: 'room.subscribe', roomId: leads }],
    ['room.typing general', { type: 'room.typing', roomId: general }],
    ['room.post general', { type: 'room.post', roomId: general, content: 'hello from the parity table' }],
    ['room.post leads', { type: 'room.post', roomId: leads, content: 'hello leads' }],
    ['doc.join plan', { type: 'doc.join', noteId: notePlan }],
    ['doc.join brief', { type: 'doc.join', noteId: noteBrief }],
    ['doc.leave brief', { type: 'doc.leave', noteId: noteBrief }],
    ['room.unsubscribe general', { type: 'room.unsubscribe', roomId: general }],
  ];

  test.each(ROLES)('gateway frames: %s', async (role) => {
    const t = await tab(local[role]);
    const handle = handles[role] as string;
    const outcomes: Record<string, [string, string]> = {};
    for (const [name, frame] of FRAMES()) {
      outcomes[name] = [await localFrame(t, frame), await remoteFrame(handle, `parity-${role}`, frame)];
    }
    for (const [name, [l, r]] of Object.entries(outcomes)) expect(r, `${role} ${name}`).toBe(l);
    // The table is not vacuous: each role is refused something, or allowed to post.
    expect(Object.values(outcomes).some(([l]) => l === 'deny') || role === 'editor').toBe(true);
    await closeTab(t);
    await settleRoom(general);
  });

  /** Each §7.3 operation: the local equivalent (a route, or the function a local member's path calls) and the remote request. */
  function operations(role: Role): Array<[string, () => Promise<boolean>, () => Promise<boolean>]> {
    const me = local[role];
    const handle = handles[role] as string;
    const ok = async (res: Promise<Response>) => (await res).status < 300;
    const remote = (type: string, body: Record<string, unknown>) => async () => (await b.refusal(type, { spaceId: space, ...body }, handle)) === null;
    const localFs = async (path: string, read: boolean) => {
      const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
      const { contentRepos } = await import('@/db/repositories/content');
      try {
        const fs = contentRepos(await resolvedPrincipal(me, space)).files();
        const abs = fs.resolve(path);
        if (read) readFileSync(abs);
        return true;
      } catch {
        return false;
      }
    };
    const localPropose = async () => {
      const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
      const { contentRepos } = await import('@/db/repositories/content');
      const { proposeNoteEdit } = await import('@/core/docs/edit-proposals');
      const { sha256Hex } = await import('@/core/docs/hub');
      try {
        await proposeNoteEdit(contentRepos(await resolvedPrincipal(me, space)).noteScope, {
          noteId: noteBrief, sessionId: null, proposerKey: `parity:${me}`, agentId: null, action: 'edit',
          baseBody: 'the brief', baseSha256: sha256Hex('the brief'), body: 'a better brief',
        });
        return true;
      } catch {
        return false;
      }
    };
    return [
      ['space.info', () => ok(call(me, 'GET', `/api/spaces/${space}`)), remote('space.info', {})],
      ['space.members', () => ok(call(me, 'GET', `/api/spaces/${space}/members`)), remote('space.members', {})],
      ['space.rooms', () => ok(call(me, 'GET', `/api/spaces/${space}/rooms`)), remote('space.rooms', {})],
      ['room.page general', () => ok(call(me, 'GET', `/api/spaces/${space}/rooms/${general}/messages`)), remote('room.page', { roomId: general })],
      ['room.page leads', () => ok(call(me, 'GET', `/api/spaces/${space}/rooms/${leads}/messages`)), remote('room.page', { roomId: leads })],
      ['note.list', () => ok(call(me, 'GET', '/api/notes', undefined, space)), remote('note.list', {})],
      ['note.read plan', () => ok(call(me, 'GET', `/api/notes/${notePlan}`, undefined, space)), remote('note.read', { noteId: notePlan })],
      ['note.read brief', () => ok(call(me, 'GET', `/api/notes/${noteBrief}`, undefined, space)), remote('note.read', { noteId: noteBrief })],
      ['note.propose brief', localPropose, async () => {
        const { sha256Hex } = await import('@/core/docs/hub');
        return remote('note.propose', { noteId: noteBrief, baseSha256: sha256Hex('the brief'), body: 'a better brief' })();
      }],
      ['task.list', () => ok(call(me, 'GET', '/api/tasks', undefined, space)), remote('task.list', {})],
      ['task.read general', () => ok(call(me, 'GET', `/api/tasks/${taskIn.general}`, undefined, space)), remote('task.read', { taskId: taskIn.general })],
      ['task.read leads', () => ok(call(me, 'GET', `/api/tasks/${taskIn.leads}`, undefined, space)), remote('task.read', { taskId: taskIn.leads })],
      ['task.create', () => ok(call(me, 'POST', '/api/tasks', { title: `by local ${role}` }, space)), remote('task.create', { title: `by remote ${role}` })],
      ['task.checkout', () => ok(call(me, 'POST', `/api/tasks/${taskIn.general}/checkout`, {}, space)), remote('task.checkout', { taskId: taskIn.general })],
      ['task.release', () => ok(call(me, 'POST', `/api/tasks/${taskIn.general}/release`, {}, space)), remote('task.release', { taskId: taskIn.general })],
      ['task.comment', () => ok(call(me, 'POST', `/api/tasks/${taskIn.general}/comments`, { body: 'noted' }, space)), remote('task.comment', { taskId: taskIn.general, body: 'noted' })],
      ['file.read shared', () => localFs('shared/readme.md', true), remote('file.read', { path: 'shared/readme.md' })],
      ['file.read root', () => localFs('secret.md', true), remote('file.read', { path: 'secret.md' })],
      ['file.list shared', () => localFs('shared', false), remote('file.list', { path: 'shared' })],
      ['memory.list', () => ok(call(me, 'GET', `/api/spaces/${space}/memory`)), remote('memory.list', {})],
    ];
  }

  test.each(ROLES)('REST-shaped operations: %s', async (role) => {
    const outcomes: Record<string, [boolean, boolean]> = {};
    for (const [name, localOp, remoteOp] of operations(role)) {
      // Checkout and release in pairs, each side on its own claim.
      const l = await localOp();
      if (name === 'task.checkout' && l) await call(local[role], 'POST', `/api/tasks/${taskIn.general}/release`, {}, space);
      const r = await remoteOp();
      if (name === 'task.checkout' && r) await b.req('task.release', { spaceId: space, taskId: taskIn.general }, handles[role]);
      outcomes[name] = [l, r];
    }
    for (const [name, [l, r]] of Object.entries(outcomes)) expect(r, `${role} ${name}`).toBe(l);
    // The roles differ where they should (the table is not all-allow).
    if (role === 'viewer') expect(outcomes['task.create']).toEqual([false, false]);
    if (role === 'guest') expect(outcomes['room.page leads']).toEqual([false, false]);
    if (role === 'editor') expect(outcomes['note.propose brief']).toEqual([true, true]);
  });

  test('member lists sent to visitors carry display names, never usernames or e-mail addresses', async () => {
    await q(`UPDATE users SET email = 'owner@host.example' WHERE id = $1`, [ownerId]);
    const res = await b.req('space.members', { spaceId: space }, handles.editor);
    const text = JSON.stringify(res);
    expect(text).not.toContain('owner@host.example');
    expect(text).not.toContain('"username"');
    // A member is named as the room names them (`displayNames`): a remote
    // member never by their `~name@fp8` login handle.
    expect(text).not.toContain('~parity-');
    const { displayNames } = await import('@/core/session-history');
    const names = await displayNames(res.members.map((m: { userId: string }) => m.userId));
    for (const m of res.members) expect(m.displayName).toBe(names.get(m.userId));
    const remote = res.members.filter((m: { remote: boolean }) => m.remote);
    expect(remote.length).toBeGreaterThan(0);
    for (const m of remote) expect(m.displayName).toMatch(/^parity-\w+ \[B:[a-z2-7]{8}\]$/);
    for (const m of res.members) expect(Object.keys(m).sort()).toEqual(['displayName', 'remote', 'role', 'userId']);
  });
});

// ── Virtual connections (§7.2) ────────────────────────────────────────

describe('virtual connections', () => {
  test('allowlist, generic subscribe, commands and rate buckets', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Virtual');
    const { member } = await joinAs(b, 'b-virtual', 'Vee', x.id, 'editor');
    for (const frame of [
      { type: 'chat.send', content: 'hi' },
      { type: 'subscribe', patterns: ['*'], resources: [`room:${x.general}`] },
      { type: 'auth', method: 'session_token', credentials: { token: ownerId }, clientType: 'webchat' },
      { type: 'room.cancel_queued', roomId: x.general, messageId: randomUUID() },
    ]) {
      expect(await b.refusal('gateway.frame', { frame }, member.handle, 'v1'), frame.type).toBe('bad_request');
    }
    expect(await b.refusal('gateway.frame', { frame: { type: 'room.post', roomId: x.general, content: '/clear' } }, member.handle, 'v1')).toBe('forbidden');
    expect(await q(`SELECT 1 FROM messages WHERE session_id = $1 AND content = '/clear'`, [x.general])).toHaveLength(0);
    // The gateway's own buckets: 20 typing frames a minute (paced under the
    // link's own 60 frames a second, which the answers and echoes count against).
    await b.frame(member.handle, 'v1', { type: 'room.subscribe', roomId: x.general });
    for (let i = 0; i < 21; i++) {
      await b.frame(member.handle, 'v1', { type: 'room.typing', roomId: x.general });
      await pause(60);
    }
    await waitFor(() => b.messages(member.handle, 'v1').find((m) => m.type === 'error' && m.code === 'RATE_LIMITED'), 'a rate-limit error');
    // At most 5 connections per visitor per link.
    for (let i = 2; i <= 5; i++) await b.frame(member.handle, `v${i}`, { type: 'ping' });
    expect(await b.refusal('gateway.frame', { frame: { type: 'ping' } }, member.handle, 'v6')).toBe('limit');
    expect(await b.req('conn.close', {}, member.handle, 'v5')).toEqual({ closed: true });
    expect(await b.refusal('gateway.frame', { frame: { type: 'ping' } }, member.handle, 'v6')).toBeNull();
  });

  test('two conns keep separate subscriptions; room.subscribe delivers live room.message', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Two conns');
    const { member } = await joinAs(b, 'b-two', 'Two', x.id, 'editor');
    await b.frame(member.handle, 'one', { type: 'room.subscribe', roomId: x.general });
    await b.frame(member.handle, 'two', { type: 'ping' });
    await waitFor(() => b.messages(member.handle, 'one').find((m) => m.type === 'subscribed'), 'subscribed');
    expect((await call(ownerId, 'POST', `/api/spaces/${x.id}/rooms/${x.general}/messages`, { content: 'live one' })).status).toBe(201);
    await settleRoom(x.general);
    const live = await waitFor(() => b.messages(member.handle, 'one').find((m) => m.type === 'event' && m.event.type === 'room.message'), 'room.message on conn one');
    expect(live.event.payload.message.content).toBe('live one');
    expect(b.messages(member.handle, 'two').some((m) => m.type === 'event' && m.event.type === 'room.message')).toBe(false);
    // Documents too: conn one joins a note, conn two does not.
    const note = await createNote(x.id, 'v-note', 'V', 'v');
    await b.frame(member.handle, 'one', { type: 'doc.join', noteId: note });
    await waitFor(() => b.messages(member.handle, 'one').find((m) => typeof m.type === 'string' && m.type.startsWith('doc.') && m.noteId === note), 'doc join answer');
    const { getDocHub } = await import('@/core/docs');
    const row = await rowOf(member.handle);
    expect(getDocHub().peersIn(x.id).map((p) => p.userId)).toEqual([row.id]);
    // Ten idle minutes and they go, with their room and document subscriptions.
    const { IDLE_MS, sweepIdle } = await import('./virtual-connection');
    expect(sweepIdle(Date.now() + IDLE_MS + 1)).toBeGreaterThanOrEqual(2);
    const { getGatewayHub } = await import('@/core/gateway/hub');
    expect(getGatewayHub().connectionManager.getConnectionsByUser(row.id)).toHaveLength(0);
    await waitFor(() => getDocHub().peersIn(x.id).length === 0, 'the document peer to go');
  });

  test('a virtual connection closes with its link', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Link close');
    const { member } = await joinAs(b, 'b-linkclose', 'Lc', x.id, 'viewer');
    await b.frame(member.handle, 'l1', { type: 'room.subscribe', roomId: x.general });
    const row = await rowOf(member.handle);
    const { getGatewayHub } = await import('@/core/gateway/hub');
    expect(getGatewayHub().connectionManager.getConnectionsByUser(row.id)).toHaveLength(1);
    b.link.close(4000, 'bye');
    await waitFor(() => getGatewayHub().connectionManager.getConnectionsByUser(row.id).length === 0, 'the virtual connection to close');
  });
});

// ── Revocation (§7.6) ─────────────────────────────────────────────────

describe('revocation and blocking', () => {
  test('removal from X keeps Y; later frames for X fail; a downgrade stops posting but keeps reading', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Rev X');
    const y = await newSpace('Rev Y');
    const { member } = await joinAs(b, 'b-rev', 'Rev', x.id, 'editor');
    await joinAs(b, 'b-rev', 'Rev', y.id, 'editor');
    const row = await rowOf(member.handle);
    await b.frame(member.handle, 'r1', { type: 'room.subscribe', roomId: x.general });
    await b.frame(member.handle, 'r1', { type: 'room.subscribe', roomId: y.general });
    await waitFor(() => b.messages(member.handle, 'r1').filter((m) => m.type === 'subscribed').length >= 2, 'both subscribed');

    const { removeMember, setRole } = await import('@/core/spaces/service');
    await removeMember({ userId: ownerId }, x.id, row.id);
    await waitFor(() => b.events.find((e) => e.as === member.handle && e.conn === '*' && (e.body as Frame).type === 'space.revoked' && (e.body as Frame).spaceId === x.id), 'space.revoked');
    expect(await b.refusal('space.info', { spaceId: x.id }, member.handle)).toBe('not_found');
    expect(await b.refusal('room.page', { spaceId: x.id, roomId: x.general }, member.handle)).toBe('not_found');
    const before = b.messages(member.handle, 'r1').length;
    await b.frame(member.handle, 'r1', { type: 'room.post', roomId: x.general, content: 'still here?' });
    await waitFor(() => b.messages(member.handle, 'r1').slice(before).find((m) => m.type === 'error'), 'a refused post');
    // Y stays: the connection is still open and reads and posts there.
    expect(await b.req('space.info', { spaceId: y.id }, member.handle)).toMatchObject({ id: y.id, role: 'editor' });
    await b.frame(member.handle, 'r1', { type: 'room.post', roomId: y.general, content: 'hello Y' });
    await waitFor(() => b.messages(member.handle, 'r1').find((m) => m.type === 'room.posted' && m.roomId === y.general), 'a post in Y');

    // Downgrade to viewer in Y: reads, cannot post.
    await setRole({ userId: ownerId }, y.id, row.id, { role: 'viewer' });
    expect(await b.req('room.page', { spaceId: y.id, roomId: y.general }, member.handle)).toMatchObject({ messages: expect.any(Array) });
    const mark = b.messages(member.handle, 'r1').length;
    await b.frame(member.handle, 'r1', { type: 'room.post', roomId: y.general, content: 'as a viewer' });
    await waitFor(() => b.messages(member.handle, 'r1').slice(mark).find((m) => m.type === 'error'), 'a refused viewer post');
    expect(await q('SELECT 1 FROM messages WHERE session_id = $1 AND content = $2', [y.general, 'as a viewer'])).toHaveLength(0);

    // The last membership goes: the virtual connections close.
    const { virtualConnectionCount } = await import('./virtual-connection');
    expect(virtualConnectionCount(visitorB.instanceId)).toBeGreaterThan(0);
    const { getGatewayHub } = await import('@/core/gateway/hub');
    await removeMember({ userId: ownerId }, y.id, row.id);
    expect(getGatewayHub().connectionManager.getConnectionsByUser(row.id)).toHaveLength(0);
  });

  test('blocking an install removes all its memberships, closes its link and the door refuses at once', async () => {
    const c = await dialVisitor(visitorC);
    const x = await newSpace('Block X');
    const y = await newSpace('Block Y');
    const one = await joinAs(c, 'c-block-1', 'One', x.id, 'editor');
    await joinAs(c, 'c-block-2', 'Two', y.id, 'viewer');
    const rowOne = await rowOf(one.member.handle);
    // Not an admin: refused.
    expect((await call(ownerId, 'POST', `/api/admin/federation/instances/${visitorC.instanceId}/block`)).status).toBe(403);
    const listed = await (await call(adminId, 'GET', '/api/admin/federation/instances')).json();
    expect(listed.instances.find((i: { instanceId: string }) => i.instanceId === visitorC.instanceId)).toMatchObject({ status: 'active', linkUp: true });
    const res = await call(adminId, 'POST', `/api/admin/federation/instances/${visitorC.instanceId}/block`);
    expect(res.status).toBe(200);
    expect((await res.json()).membershipsRemoved).toBeGreaterThanOrEqual(2);
    await waitFor(() => c.link.closed, 'the link to close');
    expect(c.link.closeInfo?.code).toBe(4403);
    const left = await q(`SELECT count(*)::int AS n FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE u.remote_instance_id = $1`, [visitorC.instanceId]);
    expect(left[0].n).toBe(0);
    const { getMembership } = await import('@/core/spaces/service');
    expect(await getMembership(rowOne.id, x.id)).toBeNull();
    expect(await q(`SELECT 1 FROM audit_log WHERE action = 'federation_instance_blocked' AND resource_id = $1`, [visitorC.instanceId])).toHaveLength(1);
    // A redial is refused at the handshake.
    const { dialPeer, DialError } = await import('./dialer');
    const err = await dialPeer(url, hostId.instanceId, { identity: visitorC, lanCidrs: LAN, onRequest: async () => ({}) }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DialError);
    expect((err as InstanceType<typeof DialError>).closeCode).toBe(4403);
    // Unblock restores the status only.
    expect((await call(adminId, 'POST', `/api/admin/federation/instances/${visitorC.instanceId}/unblock`)).status).toBe(200);
    const [row] = await q('SELECT status, blocked_at FROM federation_instances WHERE instance_id = $1', [visitorC.instanceId]);
    expect(row).toEqual({ status: 'active', blocked_at: null });
    expect(await getMembership(rowOne.id, x.id)).toBeNull();
    expect((await call(adminId, 'POST', `/api/admin/federation/instances/${'a'.repeat(26)}/block`)).status).toBe(404);
  });

  test('turning hosting off closes the links and refuses remote rows', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Mode off');
    const { member } = await joinAs(b, 'b-mode', 'Mode', x.id, 'editor');
    await b.frame(member.handle, 'm1', { type: 'ping' });
    const { emitFederationModeChanged } = await import('./mode');
    const { getConfig } = await import('@/config');
    getConfig().federation.mode = 'visit';
    emitFederationModeChanged('visit', 'both', (err) => { throw err; });
    await waitFor(() => b.link.closed, 'the link to close');
    expect(b.link.closeInfo?.code).toBe(4403);
    const { getGatewayHub } = await import('@/core/gateway/hub');
    expect(getGatewayHub().connectionManager.getConnectionsByUser((await rowOf(member.handle)).id)).toHaveLength(0);
    const { getMembership } = await import('@/core/spaces/service');
    expect(await getMembership((await rowOf(member.handle)).id, x.id)).toBeNull();
    getConfig().federation.mode = 'both';
  });
});

// ── Presence (§7.1, §11 item 10) ──────────────────────────────────────

describe('presence', () => {
  test('a remote guest sees only the members of their rooms, even when a local member triggers the publish', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Presence');
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    const editor = randomUUID();
    const viewer = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: editor, username: `pr-editor-${rand(3)}` }, { id: viewer, username: `pr-viewer-${rand(3)}` }]);
    for (const [id, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
      await acceptInvite({ userId: id }, (await createInvite({ userId: ownerId }, x.id, { role })).token);
    }
    const { createRoom } = await import('@/core/rooms/service');
    const leads = await createRoom({ userId: ownerId }, x.id, { title: 'Leads', visibility: 'private', memberIds: [editor] });
    const { member } = await joinAs(b, 'b-presence', 'Gus', x.id, 'guest', { rooms: [leads.id], folders: [] });
    const guestRow = await rowOf(member.handle);
    const te = await tab(editor);
    const tv = await tab(viewer);
    await te.send({ type: 'space.subscribe', spaceId: x.id });
    await tv.send({ type: 'space.subscribe', spaceId: x.id });
    await b.frame(member.handle, 'p1', { type: 'space.subscribe', spaceId: x.id });
    await pause(200);
    // The viewer's own move publishes everyone's view.
    const mark = b.messages(member.handle, 'p1').length;
    await tv.send({ type: 'room.subscribe', roomId: x.general });
    const view = await waitFor(() => b.messages(member.handle, 'p1').slice(mark).reverse().find((m) => m.type === 'event' && m.event.type === 'space.presence'), 'a presence view');
    const ids = view.event.payload.members.map((m: { userId: string }) => m.userId);
    expect(ids).toContain(editor);
    expect(ids).toContain(guestRow.id);
    expect(ids).not.toContain(viewer);
    // The guest's name carries its badge in what locals see.
    const localView = await waitFor(() => te.frames.slice().reverse().find((f) => f.type === 'event' && f.event.type === 'space.presence'
      && f.event.payload.members.some((m: { userId: string }) => m.userId === guestRow.id)), 'the editor\'s view');
    expect(localView.event.payload.members.find((m: { userId: string }) => m.userId === guestRow.id).username).toBe(`gus [B:${visitorB.instanceId.slice(0, 8)}]`);
    await closeTab(te);
    await closeTab(tv);
  });

  test('a null membership yields nobody', async () => {
    const x = await newSpace('Presence null');
    const one = randomUUID();
    const two = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: one, username: `pn-one-${rand(3)}` }, { id: two, username: `pn-two-${rand(3)}` }]);
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    for (const id of [one, two]) await acceptInvite({ userId: id }, (await createInvite({ userId: ownerId }, x.id, { role: 'editor' })).token);
    const t1 = await tab(one);
    const t2 = await tab(two);
    await t1.send({ type: 'space.subscribe', spaceId: x.id });
    await t2.send({ type: 'space.subscribe', spaceId: x.id });
    await pause(150);
    // `one` loses the row without the pruning step (a race, or a stale resource).
    await q('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [x.id, one]);
    const mark = t1.frames.length;
    await t2.send({ type: 'room.subscribe', roomId: x.general });
    const view = await waitFor(() => t1.frames.slice(mark).find((f) => f.type === 'event' && f.event.type === 'space.presence'), 'a presence view');
    expect(view.event.payload.members).toEqual([]);
    await closeTab(t1);
    await closeTab(t2);
  });
});

// ── Posts, mentions, display (§7.4) and host turns (§7.5) ─────────────

describe('posts from other installs', () => {
  test('the input guard refuses a post before it is stored; agent-labelled posts are labelled and capped', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Guarded');
    const { member } = await joinAs(b, 'b-guard', 'Anna', x.id, 'editor');
    await b.frame(member.handle, 'g1', { type: 'room.post', roomId: x.general, content: 'try this: rm -rf / now' });
    const refused = await waitFor(() => b.messages(member.handle, 'g1').find((m) => m.type === 'error'), 'a refused post');
    expect(refused.code).toBe('POST_REFUSED');
    expect(await q(`SELECT 1 FROM messages WHERE session_id = $1 AND content LIKE '%rm -rf%'`, [x.general])).toHaveLength(0);

    const { getConfig } = await import('@/config');
    getConfig().federation.agentPostsPerHour = 2;
    const conn = `agent:${randomUUID()}`;
    for (let i = 0; i < 3; i++) await b.frame(member.handle, conn, { type: 'room.post', roomId: x.general, content: `agent note ${i}` });
    await waitFor(() => b.messages(member.handle, conn).filter((m) => m.type === 'room.posted' || m.type === 'error').length >= 3, 'three answers');
    expect(b.messages(member.handle, conn).find((m) => m.type === 'error')?.code).toBe('RATE_LIMITED');
    const page = await b.req('room.page', { spaceId: x.id, roomId: x.general }, member.handle);
    const agentPosts = page.messages.filter((m: { metadata: { agent?: boolean } }) => m.metadata.agent);
    expect(agentPosts).toHaveLength(2);
    expect(agentPosts[0].authorName).toBe(`anna's agent [B:${visitorB.instanceId.slice(0, 8)}]`);
    // A local member cannot label a post as an agent's.
    const { postRoomMessage } = await import('@/core/rooms/service');
    await expect(postRoomMessage({ userId: ownerId }, x.general, { content: 'mine', agent: true })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('badges render in the room, the transcript and the member list; local look-alikes get none', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Badges');
    const { member } = await joinAs(b, 'b-badge', 'Bea', x.id, 'editor');
    const lookalike = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: lookalike, username: `bea@${visitorB.instanceId.slice(0, 8)}` }]);
    tokens[lookalike] = (await (await import('@/security/auth/session')).getSessionManager().create(lookalike)).token;
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    await acceptInvite({ userId: lookalike }, (await createInvite({ userId: ownerId }, x.id, { role: 'editor' })).token);
    await b.frame(member.handle, 'b1', { type: 'room.post', roomId: x.general, content: 'from B' });
    await waitFor(() => b.messages(member.handle, 'b1').find((m) => m.type === 'room.posted'), 'posted');
    await call(lookalike, 'POST', `/api/spaces/${x.id}/rooms/${x.general}/messages`, { content: 'from the look-alike' });
    const badge = `[B:${visitorB.instanceId.slice(0, 8)}]`;
    const page = await (await call(ownerId, 'GET', `/api/spaces/${x.id}/rooms/${x.general}/messages`)).json();
    expect(page.messages.find((m: { content: string }) => m.content === 'from B').authorName).toBe(`bea ${badge}`);
    expect(page.messages.find((m: { content: string }) => m.content === 'from the look-alike').authorName).toBe(`bea@${visitorB.instanceId.slice(0, 8)}`);
    const { readSessionHistory } = await import('@/core/session-history');
    const history = await readSessionHistory(x.general, { room: { requesterId: ownerId, content: 'next' } });
    expect(history.messages[0].content).toContain(`bea ${badge}: from B`);
    const members = await (await call(ownerId, 'GET', `/api/spaces/${x.id}/members`)).json();
    expect(members.members.find((m: { username: string }) => m.username === member.handle)).toMatchObject({ displayName: `bea ${badge}`, remote: true });
    expect(members.members.find((m: { userId: string }) => m.userId === lookalike)).toMatchObject({ displayName: `bea@${visitorB.instanceId.slice(0, 8)}`, remote: false });
  });

  test('mentions: @~name@fp8 reaches the visitor over the link; @name@fp8 stays local; @octipus@… starts nothing', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Mentions');
    const { member } = await joinAs(b, 'b-mention', 'Anna', x.id, 'editor');
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    await acceptInvite({ userId: annaLocalId }, (await createInvite({ userId: ownerId }, x.id, { role: 'editor' })).token);
    await b.frame(member.handle, 'm1', { type: 'ping' });
    const fp8 = visitorB.instanceId.slice(0, 8);

    await call(ownerId, 'POST', `/api/spaces/${x.id}/rooms/${x.general}/messages`, { content: `ping ${member.handle.replace('~', '@~')} please` });
    const mention = await waitFor(() => b.messages(member.handle, 'm1').find((m) => m.type === 'event' && m.event.type === 'room.mention'), 'room.mention over the link');
    expect(mention.event.payload).toMatchObject({ roomId: x.general, spaceId: x.id, poster: 'fh-owner' });
    // Not a local notification.
    const row = await rowOf(member.handle);
    expect(await q(`SELECT 1 FROM notifications WHERE user_id = $1`, [row.id])).toHaveLength(0);

    const localBefore = (await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'room_mention'`, [annaLocalId])).length;
    const mark = b.messages(member.handle, 'm1').length;
    await call(ownerId, 'POST', `/api/spaces/${x.id}/rooms/${x.general}/messages`, { content: `hey @anna@${fp8}` });
    await pause(200);
    expect(b.messages(member.handle, 'm1').slice(mark).some((m) => m.type === 'event' && m.event.type === 'room.mention')).toBe(false);
    expect((await q(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'room_mention'`, [annaLocalId])).length).toBe(localBefore + 1);

    const { mentionsOctipus } = await import('@/core/rooms/service');
    expect(mentionsOctipus(`ask @octipus@${fp8}`)).toBe(false);
    expect(mentionsOctipus('ask @octipus now')).toBe(true);
    const res = await (await call(ownerId, 'POST', `/api/spaces/${x.id}/rooms/${x.general}/messages`, { content: `ask @octipus@${fp8} about it` })).json();
    expect(res.queuedPosition).toBeUndefined();
    await settleRoom(x.general);
    expect(fx.turns.filter((t) => t.sessionId === x.general)).toHaveLength(0);
  });
});

describe('host turns started by a visitor (§7.5)', () => {
  test('in an own space a visitor\'s @octipus is refused, and the visitor hears why', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Own space');
    const { member } = await joinAs(b, 'b-own', 'Own', x.id, 'editor');
    await b.frame(member.handle, 'o1', { type: 'room.post', roomId: x.general, content: '@octipus help me' });
    await settleRoom(x.general);
    const error = await waitFor(() => b.messages(member.handle, 'o1').find((m) => m.type === 'event' && m.event.type === 'chat.error'), 'the requester error');
    expect(error.event.payload.error).toMatch(/pays for nothing unprompted|funding|sponsor/i);
    expect(fx.turns.filter((t) => t.sessionId === x.general)).toHaveLength(0);
  });

  test('in an unattended space: sponsor-funded, ASK denied, federated audience, and a per-install cap', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Unattended');
    const { setSpaceFunding } = await import('@/core/spaces/funding');
    await setSpaceFunding({ userId: ownerId }, x.id, { mode: 'unattended', sponsor: 'me' });
    const { member } = await joinAs(b, 'b-sponsored', 'Spo', x.id, 'editor');
    await b.frame(member.handle, 's1', { type: 'room.post', roomId: x.general, content: '@octipus what is open?' });
    await waitFor(() => fx.turns.find((t) => t.sessionId === x.general), 'the remote turn');
    await settleRoom(x.general);
    const turn = fx.turns.find((t) => t.sessionId === x.general) as RecordedTurn;
    expect(turn.scope).toMatchObject({ trigger: 'remote', funding: 'sponsor', audienceFederated: true });
    expect(turn.decisions.ask).toBe('deny');
    expect(turn.decisions.personal).toBe('deny');
    const [cost] = await q(`SELECT funding, metadata FROM cost_log WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`, [x.general]);
    expect(cost.funding).toBe('sponsor');
    expect(cost.metadata.remoteInstance).toBe(visitorB.instanceId);

    // The cap: queued and running turns of one install, across rooms.
    const { getConfig } = await import('@/config');
    getConfig().federation.maxRemoteTurnsPerInstance = 1;
    let release: () => void = () => {};
    fx.hold = new Promise<void>((r) => { release = r; });
    await b.frame(member.handle, 's1', { type: 'room.post', roomId: x.general, content: '@octipus first' });
    await waitFor(() => fx.turns.filter((t) => t.sessionId === x.general).length >= 2, 'the held turn');
    await b.frame(member.handle, 's1', { type: 'room.post', roomId: x.general, content: '@octipus second' });
    const capped = await waitFor(() => b.messages(member.handle, 's1').find((m) => m.type === 'room.posted' && typeof m.notQueued === 'string'), 'a refused queue');
    expect(capped.notQueued).toMatch(/your install/);
    release();
    fx.hold = null;
    await settleRoom(x.general);
  });

  test('a local turn in a room with a remote member is federated; one without is not', async () => {
    const b = await dialVisitor(visitorB);
    const x = await newSpace('Federated room');
    await call(ownerId, 'POST', `/api/spaces/${x.id}/rooms/${x.general}/messages`, { content: '@octipus alone', addressed: true });
    await settleRoom(x.general);
    const alone = fx.turns.find((t) => t.sessionId === x.general) as RecordedTurn;
    expect(alone.scope).toMatchObject({ trigger: 'room', audienceFederated: false });
    expect(alone.decisions.ask).toBe('ask_human');
    await joinAs(b, 'b-fedroom', 'Fed', x.id, 'viewer');
    fx.turns.length = 0;
    await call(ownerId, 'POST', `/api/spaces/${x.id}/rooms/${x.general}/messages`, { content: '@octipus with company', addressed: true });
    await settleRoom(x.general);
    const shared = fx.turns.find((t) => t.sessionId === x.general) as RecordedTurn;
    expect(shared.scope).toMatchObject({ trigger: 'room', audienceFederated: true });
    expect(shared.decisions.personal).toBe('deny');
    expect(shared.decisions.personalReason).toMatch(/other installs/);
  });
});
