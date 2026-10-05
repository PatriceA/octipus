/**
 * Guest scopes (docs/plans/coworking-spec.md §10, S6; docs/SPACES.md →
 * Guests), through the real `createServer()`, the access layer and the
 * gateway.
 *
 * Space "Launch": rooms General (open), Client (open) and Leads (private,
 * owner and editor). Guest `gina` has the scope { rooms: [Client], folders:
 * [client] }; guest `gus` has { rooms: [Leads], folders: [] }.
 *
 *   - scope writes are validated (shape, rooms of this space, guests only);
 *   - rooms: gina lists and enters Client only, posts there, nowhere else;
 *   - members: gina sees the members of Client (every non-guest) and herself,
 *     not gus; gus sees Leads' members and himself;
 *   - notes, links, revisions: the notes under `client/` only;
 *   - tasks: the ones raised from Client, and commenting on them;
 *   - documents, artifacts, space memory: nothing;
 *   - knowledge: the chunks of her notes and files only;
 *   - files: under `client/` only, symlinks included; file leases likewise;
 *   - private chats and private-session agent runs: refused;
 *   - presence: gina's view lists the members of her rooms only.
 *
 * Backed by ephemeral PGlite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const ids = { owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), gina: randomUUID(), gus: randomUUID(), stranger: randomUUID() };
type Who = keyof typeof ids;

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let spaceId: string;
let otherSpaceId: string;
let generalId: string;
let clientId: string;
let leadsId: string;
let otherRoomId: string;

async function call(who: Who, method: string, path: string, opts: { body?: unknown; space?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  const space = opts.space === undefined ? spaceId : opts.space;
  if (space) headers['x-octipus-workspace'] = space;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }));
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { queryRaw } = await import('@/db/postgres');
  return (await queryRaw(sql, params)).rows as T[];
}

async function json<T = Record<string, any>>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json() as Promise<T>;
}

async function joinAs(who: Who, role: string, scope?: unknown): Promise<void> {
  const created = await json(await call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { body: scope === undefined ? { role } : { role, scope }, space: null }), 201);
  await json(await call(who, 'POST', `/api/invites/${created.token}/accept`, { space: null }));
}

let filesRoot: string;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-guests-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octipus-guests-files-')));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers(Object.entries(ids).map(([name, id]) => ({ id, username: `g-${name}` })));
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of Object.entries(ids)) tokens[name] = (await getSessionManager().create(id)).token;
  const { createServer } = await import('@/api/server');
  app = createServer();

  spaceId = (await json(await call('owner', 'POST', '/api/spaces', { body: { name: 'Launch' }, space: null }), 201)).id;
  [{ id: generalId }] = await q<{ id: string }>(`SELECT id FROM sessions WHERE workspace_id = $1 AND kind = 'room'`, [spaceId]);
  await joinAs('editor', 'editor');
  await joinAs('viewer', 'viewer');
  clientId = (await json(await call('owner', 'POST', `/api/spaces/${spaceId}/rooms`, { body: { title: 'Client', visibility: 'space' }, space: null }), 201)).id;
  leadsId = (await json(await call('owner', 'POST', `/api/spaces/${spaceId}/rooms`, { body: { title: 'Leads', visibility: 'private', memberIds: [ids.editor] }, space: null }), 201)).id;
  await joinAs('gina', 'guest', { rooms: [clientId], folders: ['client'] });
  await joinAs('gus', 'guest', { rooms: [leadsId], folders: [] });

  otherSpaceId = (await json(await call('stranger', 'POST', '/api/spaces', { body: { name: 'Elsewhere' }, space: null }), 201)).id;
  [{ id: otherRoomId }] = await q<{ id: string }>(`SELECT id FROM sessions WHERE workspace_id = $1 AND kind = 'room'`, [otherSpaceId]);

  const { WorkspaceFS } = await import('@/security/workspace-fs');
  filesRoot = WorkspaceFS.forSpace(spaceId).root;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('scope writes', () => {
  test('a guest invite and a member PATCH validate the scope', async () => {
    const invite = (body: unknown) => call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { body, space: null });
    // Another space's room, a chat id, a bad folder, a scope on a non-guest.
    expect((await invite({ role: 'guest', scope: { rooms: [otherRoomId], folders: [] } })).status).toBe(400);
    expect((await invite({ role: 'guest', scope: { rooms: [randomUUID()], folders: [] } })).status).toBe(400);
    expect((await invite({ role: 'guest', scope: { rooms: [], folders: ['../etc'] } })).status).toBe(400);
    expect((await invite({ role: 'guest', scope: { rooms: [], folders: ['a\\b'] } })).status).toBe(400);
    expect((await invite({ role: 'guest', scope: { rooms: ['not-a-uuid'], folders: [] } })).status).toBe(400);
    expect((await invite({ role: 'editor', scope: { rooms: [], folders: [] } })).status).toBe(400);
    expect([400, 422]).toContain((await invite({ role: 'guest', scope: { rooms: [], folders: [], everything: true } })).status);

    // Stored in one spelling.
    const [gina] = await q<{ scope: unknown }>(`SELECT scope FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [spaceId, ids.gina]);
    expect(gina.scope).toEqual({ rooms: [clientId], folders: ['client'] });

    const patch = (userId: string, body: unknown) => call('owner', 'PATCH', `/api/spaces/${spaceId}/members/${userId}`, { body, space: null });
    expect((await patch(ids.gus, { role: 'guest', scope: { rooms: [otherRoomId], folders: [] } })).status).toBe(400);
    expect((await patch(ids.viewer, { role: 'viewer', scope: { rooms: [], folders: [] } })).status).toBe(400);
    // A PATCH naming no scope keeps the guest's.
    await json(await patch(ids.gus, { role: 'guest' }));
    const [gus] = await q<{ scope: unknown }>(`SELECT scope FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [spaceId, ids.gus]);
    expect(gus.scope).toEqual({ rooms: [leadsId], folders: [] });
    // Only an owner sets one; owners see guests' scopes in the member list.
    expect((await call('editor', 'PATCH', `/api/spaces/${spaceId}/members/${ids.gus}`, { body: { role: 'guest', scope: { rooms: [], folders: [] } }, space: null })).status).toBe(403);
    const asOwner = await json<{ members: Array<{ userId: string; scope?: unknown }> }>(await call('owner', 'GET', `/api/spaces/${spaceId}/members`, { space: null }));
    expect(asOwner.members.find((m) => m.userId === ids.gina)?.scope).toEqual({ rooms: [clientId], folders: ['client'] });
    const asEditor = await json<{ members: Array<{ userId: string; scope?: unknown }> }>(await call('editor', 'GET', `/api/spaces/${spaceId}/members`, { space: null }));
    expect(asEditor.members.find((m) => m.userId === ids.gina)?.scope).toBeUndefined();
  });

  test('a guest cannot be put in a private room by its member list (their rooms are their scope)', async () => {
    expect((await call('owner', 'POST', `/api/spaces/${spaceId}/rooms/${leadsId}/members/${ids.gina}`, { space: null })).status).toBe(400);
  });
});

describe('rooms and members', () => {
  test('a guest lists and enters the rooms of their scope only, and posts there only', async () => {
    const { rooms } = await json<{ rooms: Array<{ id: string }> }>(await call('gina', 'GET', `/api/spaces/${spaceId}/rooms`, { space: null }));
    expect(rooms.map((r) => r.id)).toEqual([clientId]);
    expect((await call('gina', 'GET', `/api/spaces/${spaceId}/rooms/${clientId}/messages`, { space: null })).status).toBe(200);
    for (const room of [generalId, leadsId]) {
      expect((await call('gina', 'GET', `/api/spaces/${spaceId}/rooms/${room}/messages`, { space: null })).status, room).toBe(404);
      expect((await call('gina', 'POST', `/api/spaces/${spaceId}/rooms/${room}/messages`, { body: { content: 'hi' }, space: null })).status, room).toBe(404);
    }
    expect((await call('gina', 'POST', `/api/spaces/${spaceId}/rooms/${clientId}/messages`, { body: { content: 'hello from gina' }, space: null })).status).toBe(201);
    // gus enters the private room of his scope without a room_members row.
    const { roomAccess } = await import('@/core/rooms/access');
    expect(await roomAccess(ids.gus, leadsId)).not.toBeNull();
    expect(await roomAccess(ids.gus, clientId)).toBeNull();
    // A guest's own `room_members` row grants nothing beyond the scope.
    await q(`INSERT INTO room_members (session_id, user_id) VALUES ($1, $2)`, [leadsId, ids.gina]);
    expect(await roomAccess(ids.gina, leadsId)).toBeNull();
    await q(`DELETE FROM room_members WHERE session_id = $1 AND user_id = $2`, [leadsId, ids.gina]);
  });

  test('a guest sees only the members of their rooms', async () => {
    const names = async (who: Who) => (await json<{ members: Array<{ username: string }> }>(await call(who, 'GET', `/api/spaces/${spaceId}/members`, { space: null }))).members.map((m) => m.username).sort();
    // Client is open: every non-guest member, and gina; not gus.
    expect(await names('gina')).toEqual(['g-editor', 'g-gina', 'g-owner', 'g-viewer']);
    // Leads is private: its room_members (owner as creator, editor), and gus.
    expect(await names('gus')).toEqual(['g-editor', 'g-gus', 'g-owner']);
    // Room member lists show the guests whose scope names the room.
    const client = await json<{ members: Array<{ userId: string }> }>(await call('owner', 'GET', `/api/spaces/${spaceId}/rooms/${clientId}/members`, { space: null }));
    expect(client.members.map((m) => m.userId)).toContain(ids.gina);
    expect(client.members.map((m) => m.userId)).not.toContain(ids.gus);
    const leads = await json<{ members: Array<{ userId: string }> }>(await call('editor', 'GET', `/api/spaces/${spaceId}/rooms/${leadsId}/members`, { space: null }));
    expect(leads.members.map((m) => m.userId)).toContain(ids.gus);
  });
});

let briefId: string;
let planId: string;

describe('content', () => {
  test('notes, links and revisions: the notes under the guest\'s folders only', async () => {
    const plan = await json(await call('editor', 'POST', '/api/notes', { body: { slug: 'internal/plan', title: 'Plan', body: 'secret plan\n' } }));
    planId = plan.note.id;
    const brief = await json(await call('editor', 'POST', '/api/notes', { body: { slug: 'client/brief', title: 'Brief', body: 'see [[internal/plan]]\n' } }));
    briefId = brief.note.id;
    await json(await call('editor', 'POST', '/api/notes', { body: { slug: 'clientele', title: 'Clientele', body: 'not a folder match\n' } }));

    const list = await json<{ notes: Array<{ slug: string }> }>(await call('gina', 'GET', '/api/notes'));
    expect(list.notes.map((n) => n.slug)).toEqual(['client/brief']);
    expect((await call('gina', 'GET', `/api/notes/${planId}`)).status).toBe(404);
    expect((await call('gina', 'GET', `/api/notes/${planId}/revisions`)).status).toBe(404);
    const detail = await json<{ outgoing: unknown[] }>(await call('gina', 'GET', `/api/notes/${briefId}`));
    // The edge to a note outside her folders is not hers to see.
    expect(detail.outgoing).toEqual([]);
    const asEditor = await json<{ outgoing: unknown[] }>(await call('editor', 'GET', `/api/notes/${briefId}`));
    expect(asEditor.outgoing.length).toBeGreaterThan(0);
    expect((await call('gina', 'GET', `/api/notes/${briefId}/revisions`)).status).toBe(200);
    // Guests read; they never write.
    expect((await call('gina', 'POST', '/api/notes', { body: { slug: 'client/mine', title: 'Mine', body: 'x\n' } })).status).toBe(403);
    // gus has no folder: no note.
    expect((await json<{ notes: unknown[] }>(await call('gus', 'GET', '/api/notes'))).notes).toEqual([]);
  });

  test('the document hub opens a note of the guest\'s folders only, read-only', async () => {
    const { getDocHub } = await import('@/core/docs');
    const sent: Array<Record<string, any>> = [];
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const original = getGatewayHub().connectionManager.sendToConnection.bind(getGatewayHub().connectionManager);
    getGatewayHub().connectionManager.sendToConnection = (connectionId: string, message: unknown) => {
      if (connectionId.startsWith('guest-test-')) { sent.push(message as Record<string, any>); return true; }
      return original(connectionId, message as never);
    };
    try {
      await getDocHub().join({ connectionId: 'guest-test-1', userId: ids.gina }, planId);
      expect(sent.at(-1)).toMatchObject({ type: 'doc.error', code: 'NOT_FOUND' });
      await getDocHub().join({ connectionId: 'guest-test-2', userId: ids.gina }, briefId);
      expect(sent.some((m) => m.type === 'doc.state' || m.type === 'doc.joined' || m.readOnly === true)).toBe(true);
      await getDocHub().leave('guest-test-2', briefId);
    } finally {
      getGatewayHub().connectionManager.sendToConnection = original;
    }
  });

  test('tasks: the ones raised from the guest\'s rooms, and commenting on them', async () => {
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { contentRepos } = await import('@/db/repositories/content');
    const editor = contentRepos(await resolvedPrincipal(ids.editor, spaceId));
    const fromClient = await editor.tasks.create({ title: 'from client room', sourceRef: { sessionId: clientId } });
    const fromGeneral = await editor.tasks.create({ title: 'from general', sourceRef: { sessionId: generalId } });
    const plain = await editor.tasks.create({ title: 'no room' });

    const { tasks } = await json<{ tasks: Array<{ id: string }> }>(await call('gina', 'GET', '/api/tasks'));
    expect(tasks.map((t) => t.id)).toEqual([fromClient.id]);
    expect((await call('gina', 'GET', `/api/tasks/${fromGeneral.id}`)).status).toBe(404);
    expect((await call('gina', 'GET', `/api/tasks/${plain.id}`)).status).toBe(404);
    expect((await call('gina', 'POST', `/api/tasks/${fromClient.id}/comments`, { body: { body: 'looks good' } })).status).toBe(200);
    expect((await call('gina', 'POST', `/api/tasks/${fromGeneral.id}/comments`, { body: { body: 'sneaky' } })).status).toBe(404);
    expect((await call('gina', 'PATCH', `/api/tasks/${fromClient.id}`, { body: { title: 'renamed' } })).status).toBe(403);
    // Through the repository too (the agent's tools use it).
    const gina = contentRepos(await resolvedPrincipal(ids.gina, spaceId));
    expect((await gina.tasks.listOwn()).map((t) => t.id)).toEqual([fromClient.id]);
    expect(await gina.tasks.findById(plain.id)).toBeNull();
  });

  test('documents, artifacts and space memory: nothing', async () => {
    await q(`INSERT INTO documents (user_id, filename, original_name, mime_type, size, storage_path, workspace_id) VALUES ($1, 'f', 'contract.pdf', 'application/pdf', 1, '/x', $2)`, [ids.editor, spaceId]);
    await q(`INSERT INTO artifacts (slug, workspace_id, created_by_user_id, title, type) VALUES ('board', $1, $2, 'Board', 'html')`, [spaceId, ids.editor]);
    const docs = await json<{ documents?: unknown[] }>(await call('gina', 'GET', '/api/documents'));
    expect(docs.documents ?? []).toEqual([]);
    expect((await json<{ documents?: unknown[] }>(await call('editor', 'GET', '/api/documents'))).documents?.length).toBe(1);
    const artifacts = await json<{ artifacts?: unknown[] }>(await call('gina', 'GET', '/api/artifacts'));
    expect(artifacts.artifacts ?? []).toEqual([]);
    expect((await call('gina', 'GET', '/api/artifacts/board')).status).toBe(404);
    const { findViewableArtifactBySlug } = await import('@/db/repositories/space');
    expect(await findViewableArtifactBySlug(ids.gina, 'board')).toBeNull();
    expect((await call('gina', 'GET', `/api/spaces/${spaceId}/memory`, { space: null })).status).toBe(403);
    expect((await call('viewer', 'GET', `/api/spaces/${spaceId}/memory`, { space: null })).status).toBe(200);
  });

  test('knowledge: the chunks of the guest\'s notes and files only', async () => {
    const insert = (sourceId: string, content: string, purpose = 'note', metadata: Record<string, unknown> = {}) =>
      q(`INSERT INTO embeddings (source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, workspace_id, metadata)
         VALUES ($1, $2, 'm', '[0.1,0.2,0.3]', $3, $4, 'm/3', $5, $6, $7)`, [sourceId, content, purpose, randomUUID(), ids.editor, spaceId, JSON.stringify(metadata)]);
    await insert(`note:${briefId}`, 'brief chunk');
    await insert(`note:${planId}`, 'plan chunk');
    await insert(join(filesRoot, 'client', 'spec.md'), 'client file chunk', 'document', { filePath: join(filesRoot, 'client', 'spec.md') });
    await insert(join(filesRoot, 'clientele', 'x.md'), 'clientele file chunk', 'document');
    await insert(join(filesRoot, 'internal', 'y.md'), 'internal file chunk', 'document');
    await insert(randomUUID(), 'uploaded document chunk', 'document');

    const contents = async (who: Who) => (await json<{ entries: Array<{ sourceId: string }> }>(await call(who, 'GET', '/api/knowledge?limit=200'))).entries.map((e) => e.sourceId).sort();
    expect(await contents('gina')).toEqual([`note:${briefId}`, join(filesRoot, 'client', 'spec.md')].sort());
    expect(await contents('gus')).toEqual([]);
    expect((await contents('viewer')).length).toBe(6);
    expect((await call('gina', 'POST', '/api/knowledge/index', { body: { path: 'client/spec.md' } })).status).toBe(403);
  });

  test('files: under the guest\'s folders only, symlinks included; file leases likewise', async () => {
    mkdirSync(join(filesRoot, 'client'), { recursive: true });
    mkdirSync(join(filesRoot, 'internal'), { recursive: true });
    writeFileSync(join(filesRoot, 'client', 'spec.md'), 'spec');
    writeFileSync(join(filesRoot, 'internal', 'y.md'), 'secret');
    symlinkSync(join(filesRoot, 'internal'), join(filesRoot, 'client', 'escape'));

    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { contentRepos } = await import('@/db/repositories/content');
    const fs = contentRepos(await resolvedPrincipal(ids.gina, spaceId)).files();
    expect(fs.resolve('client/spec.md')).toContain(join('client', 'spec.md'));
    for (const path of ['internal/y.md', '.', 'client/../internal/y.md', 'clientele/x.md', 'client/escape/y.md']) {
      expect(() => fs.resolve(path), path).toThrow(/outside the folders|outside workspace/);
    }
    // The agent's file tools use the same root.
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const { buildAgentContext } = await import('@/core/agent/context');
    const context = buildAgentContext({
      sessionId: clientId, userId: ids.gina, topic: 'general', model: 'm', role: 'general',
      scope: { workspaceId: spaceId, space: { workspaceId: spaceId, role: 'guest', scope: { rooms: [clientId], folders: ['client'] } }, trigger: 'room', funding: 'own' },
    });
    expect(() => WorkspaceFS.forAgent(context).resolve('internal/y.md')).toThrow(/outside the folders/);
    expect(WorkspaceFS.forAgent(context).resolve('client/spec.md')).toContain('spec.md');
    // An editor's root is the whole space.
    expect(contentRepos(await resolvedPrincipal(ids.editor, spaceId)).files().resolve('internal/y.md')).toContain('y.md');

    await json(await call('editor', 'POST', `/api/spaces/${spaceId}/file-leases`, { body: { path: 'client/spec.md' }, space: null }));
    await json(await call('editor', 'POST', `/api/spaces/${spaceId}/file-leases`, { body: { path: 'internal/y.md' }, space: null }));
    const leases = await json<{ leases: Array<{ path: string }> }>(await call('gina', 'GET', `/api/spaces/${spaceId}/file-leases`, { space: null }));
    expect(leases.leases.map((l) => l.path)).toEqual(['client/spec.md']);
    expect((await json<{ leases: unknown[] }>(await call('viewer', 'GET', `/api/spaces/${spaceId}/file-leases`, { space: null }))).leases).toHaveLength(2);
  });
});

describe('the agent', () => {
  test('a guest has no private chat in the space and runs no private-session turn', async () => {
    expect((await call('gina', 'POST', '/api/sessions', { body: { title: 'mine' } })).status).toBe(403);
    const { resolveAgentScope } = await import('@/core/agent/context');
    await expect(resolveAgentScope({ session: null, userId: ids.gina, trigger: 'user', workspaceId: spaceId })).rejects.toMatchObject({ code: 'forbidden_role' });
    // In a room of their scope, the turn's scope carries theirs.
    const room = await resolveAgentScope({ session: { id: clientId, userId: ids.owner, workspaceId: spaceId, kind: 'room' }, userId: ids.gina, trigger: 'room' });
    expect(room.space).toMatchObject({ role: 'guest', scope: { rooms: [clientId], folders: ['client'] } });
    await expect(resolveAgentScope({ session: { id: generalId, userId: ids.owner, workspaceId: spaceId, kind: 'room' }, userId: ids.gina, trigger: 'room' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('presence', () => {
  type Frame = Record<string, any>;
  interface Tab { id: string; frames: Frame[]; send(msg: Frame): Promise<void> }

  async function waitFor<T>(read: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
    const until = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value as NonNullable<T>;
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async function tab(userId: string): Promise<Tab> {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const hub = getGatewayHub();
    const frames: Frame[] = [];
    const ws = { data: {}, readyState: 1, send: (f: string) => frames.push(JSON.parse(f)), close: () => {} };
    const id = hub.connectionManager.handleOpen(ws, '127.0.0.1')!;
    const send = async (msg: Frame) => { await hub.connectionManager.handleMessage(id, JSON.stringify(msg)); };
    await send({ type: 'auth', method: 'session_token', credentials: { token: userId }, clientType: 'webchat' });
    expect(frames.at(-1)).toMatchObject({ type: 'auth_ok', userId });
    await send({ type: 'subscribe', patterns: ['*'] });
    return { id, frames, send };
  }
  const lastPresence = (frames: Frame[]) => frames.filter((f) => f.type === 'event' && f.event.type === 'space.presence').at(-1)?.event.payload.members as Array<{ userId: string; where?: { kind: string; id: string } }> | undefined;
  const seen = (members: Array<{ userId: string }> | undefined) => (members ?? []).map((m) => m.userId).sort().join(',');

  beforeAll(async () => {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const hub = getGatewayHub();
    hub.setSessionValidator(async (token) => ({ userId: token, username: token, isAdmin: false }));
    hub.setWorkspaceResolver(async () => 'ws');
    const { wireMessageHandler } = await import('@/core/gateway/message-handler');
    wireMessageHandler(hub);
  });

  test('a guest\'s view of who is online holds the members of their rooms only, and their notes only', async () => {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const hub = getGatewayHub();

    const tabs: Tab[] = [];
    try {
      const gus = await tab(ids.gus);
      const viewer = await tab(ids.viewer);
      const gina = await tab(ids.gina);
      tabs.push(gus, viewer, gina);
      for (const t of tabs) await t.send({ type: 'space.subscribe', spaceId });
      // gina sees the viewer (Client is open) and herself, never gus; the viewer sees everyone online.
      const everyone = [ids.gus, ids.viewer, ids.gina].sort().join(',');
      await waitFor(() => seen(lastPresence(viewer.frames)) === everyone, 'the viewer to see everyone');
      await waitFor(() => seen(lastPresence(gina.frames)) === [ids.viewer, ids.gina].sort().join(','), 'gina\'s view');
      await waitFor(() => seen(lastPresence(gus.frames)) === [ids.gus].join(','), 'gus\'s view (the viewer is not in Leads)');

      // A note `where` is shown to a guest only for a note of their folders.
      const { getDocHub } = await import('@/core/docs');
      const { publishSpacePresence } = await import('@/core/rooms/presence');
      const whereOf = (frames: Frame[], userId: string) => lastPresence(frames)?.find((m) => m.userId === userId)?.where;
      await getDocHub().join({ connectionId: viewer.id, userId: ids.viewer }, planId);
      await publishSpacePresence(spaceId);
      await waitFor(() => whereOf(viewer.frames, ids.viewer)?.id === planId, 'the viewer in the plan note');
      expect(whereOf(gina.frames, ids.viewer)).toBeUndefined();
      await getDocHub().leave(viewer.id, planId);
      await getDocHub().join({ connectionId: viewer.id, userId: ids.viewer }, briefId);
      await publishSpacePresence(spaceId);
      await waitFor(() => whereOf(gina.frames, ids.viewer)?.id === briefId, 'gina to see the viewer in the brief');
      await getDocHub().leave(viewer.id, briefId);
    } finally {
      for (const t of tabs) hub.connectionManager.handleClose(t.id, 1000, 'test');
    }
  });

  test('task.changed reaches a guest for the tasks of their rooms only', async () => {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const hub = getGatewayHub();
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const { contentRepos } = await import('@/db/repositories/content');
    const editor = contentRepos(await resolvedPrincipal(ids.editor, spaceId));
    const tabs: Tab[] = [];
    try {
      const gina = await tab(ids.gina);
      const viewer = await tab(ids.viewer);
      tabs.push(gina, viewer);
      for (const t of tabs) await t.send({ type: 'space.subscribe', spaceId });
      // Creating a task publishes task.changed (detached, after the write).
      const inScope = await editor.tasks.create({ title: 'client follow-up', sourceRef: { sessionId: clientId } });
      const outOfScope = await editor.tasks.create({ title: 'internal follow-up' });
      const changed = (t: Tab) => t.frames.filter((f) => f.type === 'event' && f.event.type === 'task.changed').map((f) => f.event.payload.taskId as string);
      await waitFor(() => changed(viewer).includes(inScope.id) && changed(viewer).includes(outOfScope.id), 'the viewer hears both');
      expect(changed(gina)).toEqual([inScope.id]);
    } finally {
      for (const t of tabs) hub.connectionManager.handleClose(t.id, 1000, 'test');
    }
  });
});
