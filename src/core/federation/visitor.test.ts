/**
 * The visitor side of spaces across installs (docs/plans/federation-spec.md
 * §6.2, §6.3, §8.2; tests of §11 items 11 and 16, the `/api/remote-spaces`
 * ownership and the gateway demux).
 *
 * Two installs in one process, each with its own identity. The host (A):
 * the real `/federation` endpoint on 127.0.0.1 with the real host
 * operations, spaces, rooms and document hub. The visitor (B): the real
 * `/api/remote-spaces` routes (`createServer()`), the real gateway hub with
 * `remote.frame`, and the real link pool, dialling A through the guarded
 * dialer. They share the process's database (the residency test,
 * visitor-residency.test.ts, gives B a database of its own).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getDefaultModel: async () => ({ modelId: 'test-model', name: 'test-model' }),
    getAllModels: async () => [{ modelId: 'test-model' }],
    getModelForTopic: async () => null,
    getModelByModelId: async () => null,
    getModel: async () => null,
  }),
}));
vi.mock('@/core/agent/root-runner', () => ({
  runRootAgent: async () => ({ response: 'ok', agentId: randomUUID(), sources: [], outcome: 'success' }),
}));

type Identity = import('./identity').InstanceIdentity;
type Frame = Record<string, any>;

const LAN = ['127.0.0.1/32'];
const ownerId = randomUUID();
const annaId = randomUUID();
const bobId = randomUUID();
const tokens: Record<string, string> = {};

let hostId: Identity;
let port = 0;
let app: { handle(request: Request): Promise<Response> };
let stopEndpoint: () => void;

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

// ── Gateway tabs (a browser connection on either install) ─────────────

interface Tab {
  id: string;
  userId: string;
  frames: Frame[];
  listeners: Set<(f: Frame) => void>;
  send(msg: Frame): Promise<void>;
}

async function tab(userId: string): Promise<Tab> {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const hub = getGatewayHub();
  const frames: Frame[] = [];
  const listeners = new Set<(f: Frame) => void>();
  const ws = {
    data: {}, readyState: 1, close: () => {},
    send: (f: string) => {
      const frame = JSON.parse(f);
      frames.push(frame);
      for (const l of listeners) l(frame);
    },
  };
  const id = hub.connectionManager.handleOpen(ws, '127.0.0.1') as string;
  const send = async (msg: Frame) => { await hub.connectionManager.handleMessage(id, JSON.stringify(msg)); };
  await send({ type: 'auth', method: 'session_token', credentials: { token: userId }, clientType: 'webchat' });
  expect(frames.at(-1)).toMatchObject({ type: 'auth_ok', userId });
  return { id, userId, frames, listeners, send };
}

async function closeTab(t: Tab): Promise<void> {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  getGatewayHub().connectionManager.handleClose(t.id, 1000, 'test');
}

/** The host's messages a B tab got for `remoteSpaceId`. */
function remoteEvents(t: Tab, remoteSpaceId: string): Frame[] {
  return t.frames.filter((f) => f.type === 'remote.event' && f.remoteSpaceId === remoteSpaceId).map((f) => f.event);
}

/** A gateway connection as `LiveNoteSession` (web/lib/live-note.ts) uses it: local, or through `remote.frame`. */
function liveGateway(t: Tab, remoteSpaceId?: string) {
  return {
    getStatus: () => 'connected',
    send: (message: Frame) => {
      const frame = remoteSpaceId ? { type: 'remote.frame', remoteSpaceId, frame: message } : message;
      t.send(frame).catch((err: unknown) => { throw err; });
      return true;
    },
    onMessage: (listener: (m: Frame) => void) => {
      const wrapped = (f: Frame) => {
        if (remoteSpaceId) {
          if (f.type === 'remote.event' && f.remoteSpaceId === remoteSpaceId) listener(f.event);
        } else if (f.type !== 'remote.event' && f.type !== 'remote.link') {
          listener(f);
        }
      };
      t.listeners.add(wrapped);
      return () => { t.listeners.delete(wrapped); };
    },
    onStatus: () => () => {},
  };
}

// ── Spaces on A, joined from B ────────────────────────────────────────

async function newSpace(name: string): Promise<{ id: string; general: string }> {
  const { createSpace } = await import('@/core/spaces/service');
  const space = await createSpace({ userId: ownerId }, { name });
  const [row] = await q<{ id: string }>(`SELECT id FROM sessions WHERE workspace_id = $1 AND kind = 'room' AND title = 'General'`, [space.id]);
  return { id: space.id, general: row.id };
}

async function inviteLink(spaceId: string, role: 'editor' | 'commenter' | 'viewer' | 'guest' = 'editor'): Promise<string> {
  const { createInvite } = await import('@/core/spaces/invites');
  const { token } = await createInvite({ userId: ownerId }, spaceId, { role });
  return `http://127.0.0.1:${port}/join/${token}#octipus=${hostId.instanceId}`;
}

/** Join `spaceId` from B as `userId` through the routes; returns the pointer row's id. */
async function joinFromB(userId: string, spaceId: string, role: 'editor' | 'commenter' | 'viewer' | 'guest' = 'editor'): Promise<string> {
  const link = await inviteLink(spaceId, role);
  const res = await call(userId, 'POST', '/api/remote-spaces/join', { link, confirm: true });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()).remoteSpace.id;
}

async function listenEndpoint(): Promise<void> {
  const { App, listen } = await import('@/api/http');
  const { setupFederationWebSocket } = await import('./host-server');
  const endpoint = new App();
  // biome-ignore lint/suspicious/noExplicitAny: the route builder type the server passes
  setupFederationWebSocket(endpoint as any, { identity: async () => hostId });
  const server = listen(endpoint, { hostname: '127.0.0.1', port });
  await waitFor(() => server.port !== 0, 'the endpoint to listen');
  port = server.port;
  stopEndpoint = () => server.stop();
}

/** B restarts: its connections, link pool and listeners are gone; what is stored stays. */
async function restartVisitor(): Promise<void> {
  const [{ _resetVisitorOpsForTests, startVisitorOps }, { VisitorLinkPool }, { getGatewayHub }] = await Promise.all([
    import('./visitor-ops'), import('./visitor-client'), import('@/core/gateway/hub'),
  ]);
  _resetVisitorOpsForTests();
  // Short backoff: a host retained for its leaves is redialled within the test.
  startVisitorOps(new VisitorLinkPool({ reconnect: { baseMs: 50, maxMs: 200 } }), getGatewayHub());
}

/** Anna's remote rows on A that are members of `spaceId`. */
function remoteMembersOf(spaceId: string) {
  return q(`SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.kind = 'remote'`, [spaceId]);
}

type PoolRequest = import('./visitor-client').VisitorLinkPool['request'];

/** Run `body` with the pool's requests going through `wrap` (then restored). */
async function withRequests<T>(wrap: (original: PoolRequest) => PoolRequest, body: () => Promise<T>): Promise<T> {
  const { visitorPool } = await import('./visitor-ops');
  const pool = visitorPool();
  const original = pool.request.bind(pool);
  pool.request = wrap(original);
  try {
    return await body();
  } finally {
    pool.request = original;
  }
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-fed-visitor-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octipus-fed-visitor-files-')));
  const cfg = getConfig();
  cfg.federation.mode = 'both';
  cfg.federation.lanCidrs = LAN;
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  // B's identity is the install's own (a vault system secret).
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'fv-owner' },
    { id: annaId, username: 'anna' },
    { id: bobId, username: 'bob' },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const id of [ownerId, annaId, bobId]) tokens[id] = (await getSessionManager().create(id)).token;

  const { createServer } = await import('@/api/server');
  app = createServer();
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const hub = getGatewayHub();
  hub.setSessionValidator(async (token) => ({ userId: token, username: token, isAdmin: false }));
  hub.setWorkspaceResolver(async () => 'ws');
  const { wireMessageHandler } = await import('@/core/gateway/message-handler');
  wireMessageHandler(hub);
  const { wireDocumentHub } = await import('@/core/docs');
  wireDocumentHub();
  const { startRoomFanout } = await import('@/core/rooms/fanout');
  await startRoomFanout();

  const identity = await import('./identity');
  hostId = identity.identityFromPrivateKeyPem(identity.generateIdentityPem());
  await listenEndpoint();
  await restartVisitor();
}, 120_000);

afterAll(async () => {
  const [{ _resetVisitorOpsForTests }, { _resetFederationHostForTests }] = await Promise.all([import('./visitor-ops'), import('./host-server')]);
  _resetVisitorOpsForTests();
  _resetFederationHostForTests();
  stopEndpoint?.();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  const { getConfig } = await import('@/config');
  const cfg = getConfig();
  cfg.federation.mode = 'both';
  cfg.federation.lanCidrs = LAN;
  const { _resetHostOpsForTests } = await import('./host-ops');
  _resetHostOpsForTests();
});

// ── Joining (§6.2) ────────────────────────────────────────────────────

describe('joining from B', () => {
  test('the link is parsed and its fingerprint shown before anything is dialled; the join writes a pointer row', async () => {
    const x = await newSpace('Visit join');
    const link = await inviteLink(x.id, 'commenter');
    const preview = await call(annaId, 'POST', '/api/remote-spaces/join', { link });
    expect(preview.status).toBe(200);
    const { displayInstanceId } = await import('./identity');
    expect((await preview.json()).preview).toMatchObject({
      hostInstanceId: hostId.instanceId, fingerprint: displayInstanceId(hostId.instanceId), hostUrl: `ws://127.0.0.1:${port}/federation`,
    });
    // Nothing joined yet.
    expect(await q('SELECT 1 FROM remote_spaces WHERE user_id = $1 AND space_id = $2', [annaId, x.id])).toHaveLength(0);
    // A link without the fingerprint is refused.
    const bare = await call(annaId, 'POST', '/api/remote-spaces/join', { link: link.replace(/#.*$/, ''), confirm: true });
    expect(bare.status).toBe(400);
    expect((await bare.json()).code).toBe('no_fingerprint');

    const res = await call(annaId, 'POST', '/api/remote-spaces/join', { link, confirm: true });
    expect(res.status).toBe(201);
    const { remoteSpace } = await res.json();
    expect(remoteSpace).toMatchObject({ spaceId: x.id, spaceName: 'Visit join', role: 'commenter', hostInstanceId: hostId.instanceId, link: 'up' });
    expect(remoteSpace.memberHandle).toMatch(/^~anna@[a-z2-7]{8}$/);
    const [row] = await q('SELECT host_public_key FROM remote_spaces WHERE id = $1', [remoteSpace.id]);
    expect(row.host_public_key).toBe(hostId.publicKeySpkiB64);
    const [audit] = await q(`SELECT details FROM audit_log WHERE action = 'remote_space_joined' AND resource_id = $1`, [remoteSpace.id]);
    expect(audit.details).toMatchObject({ instanceId: hostId.instanceId, memberHandle: remoteSpace.memberHandle });
    // Refreshed from the host.
    const one = await call(annaId, 'GET', `/api/remote-spaces/${remoteSpace.id}`);
    expect((await one.json()).info).toMatchObject({ name: 'Visit join', role: 'commenter' });
  });

  test('the member is named to the host by a per-host HMAC of their id, stable across joins', async () => {
    const x = await newSpace('Ref one');
    const y = await newSpace('Ref two');
    await joinFromB(annaId, x.id);
    await joinFromB(annaId, y.id);
    const refs = await q<{ ref: string; id: string }>(
      `SELECT DISTINCT u.remote_user_ref AS ref, u.id FROM users u JOIN workspace_members m ON m.user_id = u.id
        WHERE u.kind = 'remote' AND m.workspace_id = ANY($1)`, [[x.id, y.id]],
    );
    // One remote row for both spaces: the same ref each time.
    expect(refs).toHaveLength(1);
    const { memberRef } = await import('./visitor-ops');
    expect(refs[0].ref).toBe(await memberRef(hostId.instanceId, annaId));
    expect(refs[0].ref).not.toContain(annaId);
    expect(refs[0].ref).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Another host gets another value; another member another one.
    const identity = await import('./identity');
    const other = identity.identityFromPrivateKeyPem(identity.generateIdentityPem()).instanceId;
    expect(await memberRef(other, annaId)).not.toBe(refs[0].ref);
    expect(await memberRef(hostId.instanceId, bobId)).not.toBe(refs[0].ref);
  });

  test('visiting off refuses the join', async () => {
    const { getConfig } = await import('@/config');
    const x = await newSpace('Visit off');
    const link = await inviteLink(x.id);
    getConfig().federation.mode = 'host';
    const res = await call(annaId, 'POST', '/api/remote-spaces/join', { link, confirm: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('federation_off');
  });
});

// ── Ownership of pointer rows ─────────────────────────────────────────

describe('/api/remote-spaces: a pointer row is its user\'s only', () => {
  test('another user of B cannot read, post, propose, leave or frame through my row', async () => {
    const x = await newSpace('Mine only');
    const id = await joinFromB(annaId, x.id);
    expect((await call(annaId, 'GET', `/api/remote-spaces/${id}/rooms`)).status).toBe(200);
    for (const [method, path, body] of [
      ['GET', `/api/remote-spaces/${id}`],
      ['GET', `/api/remote-spaces/${id}/rooms`],
      ['GET', `/api/remote-spaces/${id}/members`],
      ['GET', `/api/remote-spaces/${id}/notes`],
      ['GET', `/api/remote-spaces/${id}/tasks`],
      ['GET', `/api/remote-spaces/${id}/files`],
      ['GET', `/api/remote-spaces/${id}/rooms/${x.general}/messages`],
      ['POST', `/api/remote-spaces/${id}/rooms/${x.general}/messages`, { content: 'not mine' }],
      ['POST', `/api/remote-spaces/${id}/tasks`, { title: 'not mine' }],
      ['POST', `/api/remote-spaces/${id}/rooms/${x.general}/agent`],
      ['PATCH', `/api/remote-spaces/${id}`, { agentAnswersWhenAddressed: true }],
      ['DELETE', `/api/remote-spaces/${id}`],
    ] as Array<[string, string, unknown?]>) {
      const res = await call(bobId, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(((await (await call(bobId, 'GET', '/api/remote-spaces')).json()).remoteSpaces as unknown[])).toHaveLength(0);
    // Nor through the gateway.
    const bobTab = await tab(bobId);
    await bobTab.send({ type: 'remote.frame', remoteSpaceId: id, frame: { type: 'room.subscribe', roomId: x.general } });
    await waitFor(() => remoteEvents(bobTab, id).find((e) => e.type === 'error'), 'the refusal');
    expect(remoteEvents(bobTab, id)).toEqual([{ type: 'error', code: 'NOT_FOUND', message: 'Space not found' }]);
    await closeTab(bobTab);
    // Anna's row is untouched and works.
    const page = await call(annaId, 'GET', `/api/remote-spaces/${id}/rooms/${x.general}/messages`);
    expect(page.status).toBe(200);
  });

  test('REST reads and a post are forwarded as the row\'s member', async () => {
    const x = await newSpace('Forwarded');
    const id = await joinFromB(annaId, x.id);
    const posted = await call(annaId, 'POST', `/api/remote-spaces/${id}/rooms/${x.general}/messages`, { content: 'hello from B', clientId: 'c-1' });
    expect(posted.status, await posted.clone().text()).toBe(200);
    const { messageId } = await posted.json();
    const [stored] = await q<{ content: string; author_user_id: string }>('SELECT content, author_user_id FROM messages WHERE id = $1', [messageId]);
    expect(stored.content).toBe('hello from B');
    const [author] = await q<{ username: string; kind: string }>('SELECT username, kind FROM users WHERE id = $1', [stored.author_user_id]);
    expect(author.kind).toBe('remote');
    const page = await (await call(annaId, 'GET', `/api/remote-spaces/${id}/rooms/${x.general}/messages?limit=10`)).json();
    expect(page.messages.map((m: { content: string }) => m.content)).toContain('hello from B');
    const created = await call(annaId, 'POST', `/api/remote-spaces/${id}/tasks`, { title: 'Ship it' });
    expect(created.status).toBe(200);
    const taskId = (await created.json()).task.id;
    expect((await call(annaId, 'POST', `/api/remote-spaces/${id}/tasks/${taskId}/checkout`, {})).status).toBe(200);
    expect((await call(annaId, 'POST', `/api/remote-spaces/${id}/tasks/${taskId}/comment`, { body: 'on it' })).status).toBe(200);
    // Files: a folder listing and a file by its path in the URL.
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const fs = WorkspaceFS.forSpace(x.id);
    await fs.ensureRoot();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(fs.resolve('docs'), { recursive: true });
    await writeFile(fs.resolve('docs/read me.txt'), 'the brief');
    const listing = await (await call(annaId, 'GET', `/api/remote-spaces/${id}/files?path=docs`)).json();
    expect(listing.entries).toEqual([{ name: 'read me.txt', type: 'file', size: 9 }]);
    const file = await call(annaId, 'GET', `/api/remote-spaces/${id}/files/docs/read%20me.txt`);
    expect(file.status).toBe(200);
    expect(await file.json()).toMatchObject({ path: 'docs/read me.txt', encoding: 'utf8', content: 'the brief' });
    // A command is refused by the host and comes back as an error.
    const command = await call(annaId, 'POST', `/api/remote-spaces/${id}/rooms/${x.general}/messages`, { content: '/clear' });
    expect(command.status).toBe(403);
  });

  test('a REST post that asks the host\'s agent needs the chat scope', async () => {
    const x = await newSpace('Scoped post');
    const id = await joinFromB(annaId, x.id);
    const { getApiTokenManager } = await import('@/security/api-tokens');
    const { plaintext } = await getApiTokenManager().issue(annaId, { name: `rw-${randomUUID().slice(0, 8)}`, scopes: ['api:read', 'api:write'] });
    const post = (body: unknown) => app.handle(new Request(`http://localhost/api/remote-spaces/${id}/rooms/${x.general}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    for (const body of [{ content: 'please answer', addressed: true }, { content: '@octipus what is next?' }]) {
      const refused = await post(body);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: 'missing_scope' });
    }
    const before = await q('SELECT 1 FROM messages WHERE session_id = $1', [x.general]);
    // A post among members is not an agent request: it goes.
    expect((await post({ content: 'just a note for the room' })).status).toBe(200);
    expect(await q('SELECT 1 FROM messages WHERE session_id = $1', [x.general])).toHaveLength(before.length + 1);
  });

  test('a post is answered only by the room.posted carrying its clientId', async () => {
    const x = await newSpace('Correlated post');
    const id = await joinFromB(annaId, x.id);
    const { inboundLink } = await import('./host-server');
    const { getInstanceIdentity } = await import('./identity');
    const visitorInstance = (await getInstanceIdentity()).instanceId;
    const forged = randomUUID();
    const res = await withRequests((original) => (async (host, type, body, opts) => {
      const frame = (body as { frame?: { type?: string; roomId?: string } }).frame;
      if (type === 'gateway.frame' && frame?.type === 'room.post' && opts?.as && opts.conn) {
        // Another post's answer arrives first on the same connection.
        inboundLink(visitorInstance)?.sendEvent(opts.as, opts.conn, { type: 'room.posted', roomId: frame.roomId, messageId: forged, clientId: 'someone-else' });
        await pause(100);
      }
      return original(host, type, body, opts);
    }) as PoolRequest, () => call(annaId, 'POST', `/api/remote-spaces/${id}/rooms/${x.general}/messages`, { content: 'mine, correlated' }));
    expect(res.status).toBe(200);
    const { messageId } = await res.json();
    expect(messageId).not.toBe(forged);
    const [stored] = await q<{ content: string }>('SELECT content FROM messages WHERE id = $1', [messageId]);
    expect(stored.content).toBe('mine, correlated');
  });
});

// ── Gateway demux (§8.2) ──────────────────────────────────────────────

describe('remote.frame and remote.event', () => {
  test('host events reach only the connection named, and the link state is announced', async () => {
    const x = await newSpace('Demux');
    const annaRow = await joinFromB(annaId, x.id);
    const bobRow = await joinFromB(bobId, x.id);
    const annaOne = await tab(annaId);
    const annaTwo = await tab(annaId);
    const bobTab = await tab(bobId);
    await annaOne.send({ type: 'remote.frame', remoteSpaceId: annaRow, frame: { type: 'room.subscribe', roomId: x.general } });
    await bobTab.send({ type: 'remote.frame', remoteSpaceId: bobRow, frame: { type: 'space.subscribe', spaceId: randomUUID() } });
    await waitFor(() => remoteEvents(bobTab, bobRow).find((e) => e.type === 'subscribed'), 'bob\'s space subscription');
    await waitFor(() => remoteEvents(annaOne, annaRow).find((e) => e.type === 'subscribed'), 'anna\'s room subscription');
    const { postRoomMessage } = await import('@/core/rooms/service');
    await postRoomMessage({ userId: ownerId }, x.general, { content: 'only for room subscribers' });
    await waitFor(() => remoteEvents(annaOne, annaRow).find((e) => e.type === 'event' && e.event.type === 'room.message'), 'the room message on anna\'s first tab');
    await pause(150);
    // Anna's other tab subscribed nothing; Bob subscribed the space, not the room.
    expect(annaTwo.frames.filter((f) => f.type === 'remote.event')).toEqual([]);
    expect(remoteEvents(bobTab, bobRow).filter((e) => e.type === 'event' && e.event.type === 'room.message')).toEqual([]);
    // Bob's space subscription named his pointer row's space, whatever he sent.
    expect(remoteEvents(bobTab, bobRow).find((e) => e.type === 'subscribed')?.resources).toEqual([`space:${x.id}`]);
    // A frame of a type no visitor may send is refused before it travels.
    await annaOne.send({ type: 'remote.frame', remoteSpaceId: annaRow, frame: { type: 'chat.send', content: 'x' } });
    expect(annaOne.frames.at(-1)).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' });

    // Closing a tab closes its connection on the host.
    const { virtualConnectionCount } = await import('./virtual-connection');
    const { getInstanceIdentity } = await import('./identity');
    const visitorInstance = (await getInstanceIdentity()).instanceId;
    const before = virtualConnectionCount(visitorInstance);
    await closeTab(annaOne);
    await waitFor(() => virtualConnectionCount(visitorInstance) === before - 1, 'the host to drop the closed tab\'s connection');

    // Link down and up: told, and re-subscribed to the space.
    const { visitorPool } = await import('./visitor-ops');
    const pool = visitorPool();
    bobTab.frames.length = 0;
    const { inboundLink } = await import('./host-server');
    inboundLink(visitorInstance)?.close(4000, 'blip');
    await waitFor(() => bobTab.frames.find((f) => f.type === 'remote.link' && f.state === 'down'), 'link down');
    await waitFor(() => pool.state(hostId.instanceId) === 'up' && bobTab.frames.find((f) => f.type === 'remote.link' && f.state === 'up'), 'link up again');
    await waitFor(() => remoteEvents(bobTab, bobRow).find((e) => e.type === 'subscribed'), 'the space re-subscribed');
    await closeTab(annaTwo);
    await closeTab(bobTab);
  }, 30_000);
});

// ── §11 item 11: live notes through B ─────────────────────────────────

describe('live note through remote.frame (§11 item 11)', () => {
  test('a local client on A and a client through B converge; oversized and non-text updates are refused', async () => {
    const { getConfig } = await import('@/config');
    const x = await newSpace('Live');
    const remoteSpaceId = await joinFromB(annaId, x.id, 'editor');
    const res = await call(ownerId, 'POST', '/api/notes', { slug: 'live', title: 'Live', body: 'Hello\n' }, x.id);
    expect(res.status).toBe(200);
    const noteId = (await res.json()).note.id;
    const { LiveNoteSession } = await import('../../../web/lib/live-note');
    type GatewayArg = ConstructorParameters<typeof LiveNoteSession>[0];
    const ownerTab = await tab(ownerId);
    const annaTab = await tab(annaId);
    const onA = new LiveNoteSession(liveGateway(ownerTab) as unknown as GatewayArg, noteId, { id: ownerId, name: 'owner' }, async () => 'conflict');
    const viaB = new LiveNoteSession(liveGateway(annaTab, remoteSpaceId) as unknown as GatewayArg, noteId, { id: annaId, name: 'anna' }, async () => 'conflict');
    await waitFor(() => onA.getState().synced && viaB.getState().synced, 'both to sync');
    expect(viaB.getState().readOnly).toBe(false);
    onA.text.insert(0, 'A says hi. ');
    viaB.text.insert(viaB.text.length, 'B was here.\n');
    await waitFor(() => onA.text.toString() === viaB.text.toString() && onA.text.toString().includes('B was here') && viaB.text.toString().includes('A says hi'), 'the two copies to converge');
    expect(onA.text.toString()).toBe('A says hi. Hello\nB was here.\n');

    // Straight through the frame, as a crafted client would.
    const epoch = remoteEvents(annaTab, remoteSpaceId).find((e) => e.type === 'doc.sync')?.epoch as string;
    const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
    const forged = new Y.Doc();
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(viaB.doc));
    const vector = Y.encodeStateVector(forged);
    forged.getMap('junk').set('k', 'x'.repeat(200));
    await annaTab.send({ type: 'remote.frame', remoteSpaceId, frame: { type: 'doc.update', noteId, epoch, update: b64(Y.encodeStateAsUpdate(forged, vector)) } });
    await waitFor(() => remoteEvents(annaTab, remoteSpaceId).find((e) => e.type === 'doc.error' && e.code === 'INVALID_UPDATE'), 'the non-text update refused');
    const big = new Y.Doc();
    Y.applyUpdate(big, Y.encodeStateAsUpdate(viaB.doc));
    const bigVector = Y.encodeStateVector(big);
    big.getText('body').insert(0, 'z'.repeat(getConfig().spaces.noteMaxBytes + 10));
    await annaTab.send({ type: 'remote.frame', remoteSpaceId, frame: { type: 'doc.update', noteId, epoch, update: b64(Y.encodeStateAsUpdate(big, bigVector)) } });
    await waitFor(() => remoteEvents(annaTab, remoteSpaceId).find((e) => e.type === 'doc.error' && e.code === 'TOO_LARGE'), 'the oversized update refused');
    await pause(100);
    expect(onA.text.toString()).toBe('A says hi. Hello\nB was here.\n');
    onA.destroy();
    viaB.destroy();
    await closeTab(ownerTab);
    await closeTab(annaTab);
  }, 30_000);
});

// ── §11 item 16: leaving ──────────────────────────────────────────────

describe('leaving (§6.3, §11 item 16)', () => {
  test('a leave the host acknowledged deletes the row and the membership', async () => {
    const x = await newSpace('Leave now');
    const id = await joinFromB(annaId, x.id, 'viewer');
    const res = await call(annaId, 'DELETE', `/api/remote-spaces/${id}`);
    expect(await res.json()).toEqual({ left: true, pending: false });
    expect(await q('SELECT 1 FROM remote_spaces WHERE id = $1', [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.kind = 'remote'`, [x.id])).toHaveLength(0);
    const [audit] = await q(`SELECT details FROM audit_log WHERE action = 'remote_space_left' AND resource_id = $1`, [id]);
    expect(audit.details).toMatchObject({ instanceId: hostId.instanceId, spaceId: x.id });
  });

  test('a tombstone survives a restart of B and is delivered when the link next opens', async () => {
    const { getConfig } = await import('@/config');
    const x = await newSpace('Leave later');
    const id = await joinFromB(annaId, x.id, 'viewer');
    const members = () => q(`SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.kind = 'remote'`, [x.id]);
    expect(await members()).toHaveLength(1);
    // The host goes away.
    stopEndpoint();
    const { inboundLink } = await import('./host-server');
    const { getInstanceIdentity } = await import('./identity');
    const visitorInstance = (await getInstanceIdentity()).instanceId;
    inboundLink(visitorInstance)?.close(4000, 'host stopping');
    await waitFor(async () => (await import('./visitor-ops')).visitorPool().state(hostId.instanceId) === 'down', 'the link to drop');
    const res = await call(annaId, 'DELETE', `/api/remote-spaces/${id}`);
    expect(await res.json()).toEqual({ left: true, pending: true });
    // Gone from the list, pending among the leaves; the host still has the member.
    const list = await (await call(annaId, 'GET', '/api/remote-spaces')).json();
    expect(list.remoteSpaces.map((r: { id: string }) => r.id)).not.toContain(id);
    expect(list.pendingLeaves.map((r: { id: string }) => r.id)).toContain(id);
    expect(await members()).toHaveLength(1);

    // B restarts while the host is still away: the tombstone is a row, it stays,
    // and the host is retained for it (redialled with backoff).
    await restartVisitor();
    const { visitorPool } = await import('./visitor-ops');
    await waitFor(() => visitorPool().retainerCount(hostId.instanceId) === 1, 'the host to be retained for its leave');
    await pause(300);
    expect(await q('SELECT left_at FROM remote_spaces WHERE id = $1', [id])).toHaveLength(1);

    // The host comes back: a redial (nothing else asks for the host) delivers
    // the leave, and the host is let go.
    await listenEndpoint();
    getConfig().federation.mode = 'both';
    await waitFor(async () => (await q('SELECT 1 FROM remote_spaces WHERE id = $1', [id])).length === 0, 'the tombstone to be delivered');
    expect(await members()).toHaveLength(0);
    await waitFor(() => visitorPool().retainerCount(hostId.instanceId) === 0, 'the host to be released');
  }, 30_000);

  test('at start, B delivers the leaves pending since the last run', async () => {
    const x = await newSpace('Leave at start');
    const id = await joinFromB(annaId, x.id, 'viewer');
    // A tombstone left by an earlier run (written straight to the table).
    await q('UPDATE remote_spaces SET left_at = now() WHERE id = $1', [id]);
    await restartVisitor();
    await waitFor(async () => (await q('SELECT 1 FROM remote_spaces WHERE id = $1', [id])).length === 0, 'the pending leave to be delivered at start');
    expect(await q(`SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.kind = 'remote'`, [x.id])).toHaveLength(0);
  });

  test('a leave being delivered and a rejoin never interleave: the rejoin keeps its membership', async () => {
    const x = await newSpace('Rejoin race');
    const first = await joinFromB(annaId, x.id, 'viewer');
    await q('UPDATE remote_spaces SET left_at = now() WHERE id = $1', [first]);
    const { deliverTombstones } = await import('./visitor-ops');
    const order: string[] = [];
    const second = await withRequests((original) => (async (host, type, body, opts) => {
      if (type === 'space.leave') {
        order.push('leave');
        // The leave is slow to go: a rejoin meanwhile must wait for it.
        await pause(300);
      }
      if (type === 'space.join') order.push('join');
      return original(host, type, body, opts);
    }) as PoolRequest, async () => {
      const delivering = deliverTombstones(hostId.instanceId);
      await waitFor(() => order.includes('leave'), 'the leave to start');
      const rejoined = await joinFromB(annaId, x.id, 'viewer');
      await delivering;
      return rejoined;
    });
    expect(order).toEqual(['leave', 'join']);
    expect(await q('SELECT id, left_at FROM remote_spaces WHERE space_id = $1 AND user_id = $2', [x.id, annaId])).toEqual([{ id: second, left_at: null }]);
    expect(await remoteMembersOf(x.id)).toHaveLength(1);
  });

  test('a delivery that waited for a rejoin re-reads the tombstone and sends no leave', async () => {
    const x = await newSpace('Rejoin first');
    const first = await joinFromB(annaId, x.id, 'viewer');
    await q('UPDATE remote_spaces SET left_at = now() WHERE id = $1', [first]);
    const { deliverTombstones } = await import('./visitor-ops');
    const order: string[] = [];
    let joining = false;
    await withRequests((original) => (async (host, type, body, opts) => {
      if (type === 'space.join') {
        joining = true;
        order.push('join');
        await pause(300);
      }
      if (type === 'space.leave') order.push('leave');
      return original(host, type, body, opts);
    }) as PoolRequest, async () => {
      const rejoin = joinFromB(annaId, x.id, 'viewer');
      await waitFor(() => joining, 'the join to start');
      await Promise.all([rejoin, deliverTombstones(hostId.instanceId)]);
    });
    expect(order).toEqual(['join']);
    expect(await q('SELECT left_at FROM remote_spaces WHERE space_id = $1 AND user_id = $2', [x.id, annaId])).toEqual([{ left_at: null }]);
    expect(await remoteMembersOf(x.id)).toHaveLength(1);
  });

  test('a rejoin drops a pending leave of the same space', async () => {
    const x = await newSpace('Rejoin');
    const first = await joinFromB(annaId, x.id, 'viewer');
    await q('UPDATE remote_spaces SET left_at = now() WHERE id = $1', [first]);
    const second = await joinFromB(annaId, x.id, 'viewer');
    expect(second).not.toBe(first);
    expect(await q('SELECT id FROM remote_spaces WHERE space_id = $1 AND user_id = $2', [x.id, annaId])).toEqual([{ id: second }]);
  });
});

// ── The gateway allowlist is the protocol's ───────────────────────────

test('the gateway\'s remote.frame types are the visitor allowlist', async () => {
  const [{ RemoteFrameSchema }, { GATEWAY_FRAME_ALLOWLIST }] = await Promise.all([import('@/core/gateway/protocol'), import('./protocol')]);
  expect([...RemoteFrameSchema.shape.frame.shape.type.options].sort()).toEqual([...GATEWAY_FRAME_ALLOWLIST].sort());
});
