/**
 * Guest scopes (docs/plans/coworking-spec.md §10, S6; docs/SPACES.md →
 * Guests), through the real `createServer()`, the access layer and the
 * gateway.
 *
 * Space "Launch": rooms General (open), Client (open) and Leads (private,
 * owner and editor). Guest `gina` has the scope { rooms: [Client], folders:
 * [client] }; guest `gus` has { rooms: [Leads], folders: [] }; guest `gail`
 * has the empty scope.
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
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const ids = { owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), gina: randomUUID(), gus: randomUUID(), gail: randomUUID(), stranger: randomUUID() };
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
  // gail has been given nothing yet: no room, no folder.
  await joinAs('gail', 'guest', { rooms: [], folders: [] });

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

  test('a folder whose note-slug form differs from its own segments is refused', async () => {
    const invite = (folders: string[]) => call('owner', 'POST', `/api/spaces/${spaceId}/invites`, { body: { role: 'guest', scope: { rooms: [], folders } }, space: null });
    // `日本/acme` would match the notes under `acme/`; `€/x` those under `x/`; `private/€` all of `private/`.
    for (const folder of ['日本/acme', '€/x', 'private/€', 'a/-b']) expect((await invite([folder])).status, folder).toBe(400);
    // Spelled differently from its slug is fine when every segment keeps one.
    expect((await invite(['Client Docs/Specs'])).status).toBe(201);
    const { normalizeGuestFolder } = await import('@/security/space-access');
    expect(normalizeGuestFolder('日本/acme')).toBeNull();
    expect(normalizeGuestFolder('/client/specs/')).toBe('client/specs');
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
      const sync = sent.find((m) => m.type === 'doc.sync' && m.noteId === briefId);
      expect(sync).toMatchObject({ readOnly: true });
      // A guest's edit is refused, whatever the client says.
      const Y = await import('yjs');
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(Buffer.from(sync!.state as string, 'base64')));
      const before = Y.encodeStateVector(ydoc);
      ydoc.getText('body').insert(0, 'guest was here ');
      const update = Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString('base64');
      sent.length = 0;
      await getDocHub().update({ connectionId: 'guest-test-2', userId: ids.gina }, briefId, sync!.epoch as string, update);
      expect(sent.at(-1)).toMatchObject({ type: 'doc.error', code: 'FORBIDDEN' });
      expect(getDocHub().readLive(briefId)?.text ?? '').not.toContain('guest was here');
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

  test('a scope change takes effect at once: the room, the open note, the running work, presence', async () => {
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const hub = getGatewayHub();
    const { getAgentManager } = await import('@/core/agent-manager');
    const stopped = vi.spyOn(getAgentManager(), 'stopWorkspace');
    const { getDocHub } = await import('@/core/docs');
    const patchGina = (scope: unknown) => call('owner', 'PATCH', `/api/spaces/${spaceId}/members/${ids.gina}`, { body: { role: 'guest', scope }, space: null });
    const tabs: Tab[] = [];
    try {
      const gina = await tab(ids.gina);
      const viewer = await tab(ids.viewer);
      tabs.push(gina, viewer);
      for (const t of tabs) await t.send({ type: 'space.subscribe', spaceId });
      await gina.send({ type: 'room.subscribe', roomId: clientId });
      await waitFor(() => gina.frames.find((f) => f.type === 'subscribed' && f.resources?.includes(`room:${clientId}`)), 'gina in Client');
      await getDocHub().join({ connectionId: gina.id, userId: ids.gina }, briefId);
      await waitFor(() => gina.frames.find((f) => f.type === 'doc.sync' && f.noteId === briefId), 'the brief open');
      await waitFor(() => seen(lastPresence(gina.frames)) === [ids.viewer, ids.gina].sort().join(','), 'gina sees the viewer');

      // The owner takes Client and the folder away.
      await json(await patchGina({ rooms: [], folders: [] }));
      await waitFor(() => gina.frames.find((f) => f.type === 'event' && f.event.type === 'room.removed' && f.event.payload.roomId === clientId), 'room.removed');
      expect(hub.connectionManager.getConnection(gina.id)?.context?.resources.has(`room:${clientId}`)).toBe(false);
      await waitFor(() => gina.frames.find((f) => f.type === 'doc.closed' && f.noteId === briefId), 'doc.closed');
      expect(getDocHub().openDocsFor(ids.gina, spaceId)).toEqual([]);
      expect(stopped).toHaveBeenCalledWith(spaceId, ids.gina);
      await waitFor(() => seen(lastPresence(gina.frames)) === ids.gina, 'gina\'s view is herself only');
    } finally {
      stopped.mockRestore();
      for (const t of tabs) hub.connectionManager.handleClose(t.id, 1000, 'test');
      await json(await patchGina({ rooms: [clientId], folders: ['client'] }));
    }
  });
});

describe('space metadata, activity and budget', () => {
  test('GET /spaces/:id and the space list: a guest sees the members of their rooms only', async () => {
    const asGina = await json(await call('gina', 'GET', `/api/spaces/${spaceId}`, { space: null }));
    // Client is open: every non-guest member, and gina.
    expect(asGina).toMatchObject({ role: 'guest', memberCount: 4, createdBy: ids.owner, sponsorModels: [] });
    const asGail = await json(await call('gail', 'GET', `/api/spaces/${spaceId}`, { space: null }));
    expect(asGail).toMatchObject({ role: 'guest', memberCount: 1, createdBy: null, sponsorUserId: null });
    const listed = await json<{ spaces: Array<{ id: string; memberCount: number; createdBy: string | null }> }>(await call('gail', 'GET', '/api/spaces', { space: null }));
    expect(listed.spaces.find((x) => x.id === spaceId)).toMatchObject({ memberCount: 1, createdBy: null });
    const asViewer = await json(await call('viewer', 'GET', `/api/spaces/${spaceId}`, { space: null }));
    expect(asViewer).toMatchObject({ memberCount: 6, createdBy: ids.owner });
  });

  test('budgets: forbidden to guests', async () => {
    expect((await call('gina', 'GET', `/api/spaces/${spaceId}/budget`, { space: null })).status).toBe(403);
    expect((await call('viewer', 'GET', `/api/spaces/${spaceId}/budget`, { space: null })).status).toBe(200);
  });

  test('activity: a guest gets the rows about their rooms only, actors they may see only', async () => {
    type Entry = { action: string; userId: string | null; username: string | null; resourceType: string | null; resourceId: string | null; details: Record<string, unknown> | null };
    const rows = async (who: Who) => (await json<{ activity: Entry[] }>(await call(who, 'GET', `/api/spaces/${spaceId}/activity?limit=200`, { space: null }))).activity;
    const all = await rows('viewer');
    expect(all.some((e) => e.action === 'space_invite_created')).toBe(true);
    expect(all.some((e) => e.resourceId === leadsId)).toBe(true);

    const gina = await rows('gina');
    expect(gina.length).toBeGreaterThan(0);
    for (const e of gina) expect(e).toMatchObject({ resourceType: 'room', resourceId: clientId });
    expect(gina.find((e) => e.details?.created)).toMatchObject({ userId: ids.owner, username: 'g-owner' });
    expect(await rows('gail')).toEqual([]);

    // A row on Leads by someone outside it (here, the viewer), made while
    // impersonated: gus sees the row, not who acted, not the admin, and only
    // the room members he may see.
    await q(`INSERT INTO audit_log (user_id, action, resource_type, resource_id, workspace_id, details) VALUES ($1, 'space_content_changed', 'room', $2, $3, $4)`,
      [ids.viewer, leadsId, spaceId, JSON.stringify({ impersonatedBy: 'some-admin', members: [ids.owner, ids.viewer] })]);
    const gus = await rows('gus');
    for (const e of gus) expect(e).toMatchObject({ resourceType: 'room', resourceId: leadsId });
    const injected = gus.find((e) => Array.isArray(e.details?.members) && !e.details?.created);
    expect(injected).toMatchObject({ userId: null, username: null, details: { members: [ids.owner] } });
    expect(injected?.details).not.toHaveProperty('impersonatedBy');
  });

  test('file leases: a holder outside the guest\'s rooms is not named', async () => {
    const patch = (scope: unknown) => call('owner', 'PATCH', `/api/spaces/${spaceId}/members/${ids.gail}`, { body: { role: 'guest', scope }, space: null });
    await json(await patch({ rooms: [], folders: ['client'] }));
    try {
      const { leases } = await json<{ leases: Array<{ path: string; holderUserId: string | null; holderName: string | null }> }>(await call('gail', 'GET', `/api/spaces/${spaceId}/file-leases`, { space: null }));
      expect(leases).toEqual([expect.objectContaining({ path: 'client/spec.md', holderUserId: null, holderName: null })]);
      const asGina = await json<{ leases: Array<{ holderUserId: string | null }> }>(await call('gina', 'GET', `/api/spaces/${spaceId}/file-leases`, { space: null }));
      expect(asGina.leases.map((l) => l.holderUserId)).toEqual([ids.editor]);
    } finally {
      await json(await patch({ rooms: [], folders: [] }));
    }
  });

  test('the document hub sends a guest the cursors of the members of their rooms only', async () => {
    const { getDocHub } = await import('@/core/docs');
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } = await import('y-protocols/awareness');
    const Y = await import('yjs');
    const patch = (scope: unknown) => call('owner', 'PATCH', `/api/spaces/${spaceId}/members/${ids.gail}`, { body: { role: 'guest', scope }, space: null });
    await json(await patch({ rooms: [], folders: ['client'] }));
    const inbox = new Map<string, Array<Record<string, any>>>();
    const cm = getGatewayHub().connectionManager;
    const original = cm.sendToConnection.bind(cm);
    cm.sendToConnection = (connectionId: string, message: unknown) => {
      if (connectionId.startsWith('aw-test-')) { (inbox.get(connectionId) ?? inbox.set(connectionId, []).get(connectionId)!).push(message as Record<string, any>); return true; }
      return original(connectionId, message as never);
    };
    // The cursor clients a connection was told about, by owner name.
    const names = (connectionId: string) => {
      const doc = new Y.Doc();
      const seen = new Awareness(doc);
      for (const m of inbox.get(connectionId) ?? []) if (m.type === 'doc.awareness') applyAwarenessUpdate(seen, new Uint8Array(Buffer.from(m.update, 'base64')), 'server');
      return [...seen.getStates().values()].map((st) => (st.user as { name?: string } | undefined)?.name).filter(Boolean).sort();
    };
    const cursor = (clientId: number, connectionId: string) => {
      const doc = new Y.Doc();
      doc.clientID = clientId;
      const a = new Awareness(doc);
      a.setLocalState({ cursor: 1 });
      return getDocHub().awareness({ connectionId, userId: connectionId === 'aw-test-editor' ? ids.editor : connectionId === 'aw-test-gina' ? ids.gina : ids.gail }, briefId, Buffer.from(encodeAwarenessUpdate(a, [clientId])).toString('base64'));
    };
    try {
      await getDocHub().join({ connectionId: 'aw-test-editor', userId: ids.editor }, briefId);
      await getDocHub().join({ connectionId: 'aw-test-gina', userId: ids.gina }, briefId);
      await getDocHub().join({ connectionId: 'aw-test-gail', userId: ids.gail }, briefId);
      await cursor(9101, 'aw-test-editor');
      await cursor(9102, 'aw-test-gina');
      await cursor(9103, 'aw-test-gail');
      // gina (Client is open) sees the editor's cursor; gail (no room) sees
      // her own only; the editor sees everyone.
      expect(names('aw-test-gina')).toEqual(['g-editor']);
      expect(names('aw-test-gail')).toEqual([]);
      expect(names('aw-test-editor')).toEqual(['g-gail', 'g-gina']);
    } finally {
      for (const c of ['aw-test-editor', 'aw-test-gina', 'aw-test-gail']) await getDocHub().leave(c, briefId);
      cm.sendToConnection = original;
      await json(await patch({ rooms: [], folders: [] }));
    }
  });
});

describe('the repo registry and the workspace routes', () => {
  const guestSpace = () => ({ workspaceId: spaceId, role: 'guest' as const, scope: { rooms: [clientId], folders: ['client'] } });

  beforeAll(() => {
    // Two repositories at the top of the space: one in gina's folder, one not.
    writeFileSync(join(filesRoot, 'client', 'package.json'), JSON.stringify({ name: '@launch/client' }));
    writeFileSync(join(filesRoot, 'internal', 'package.json'), JSON.stringify({ name: '@launch/internal' }));
  });

  test('/api/workspace is not a space route: with the space header it acts in the caller\'s own workspace', async () => {
    const listed = await json<{ repositories: Array<{ name: string; path: string }> }>(await call('gina', 'GET', '/api/workspace/repositories'));
    expect(listed.repositories.every((r) => !r.path.startsWith(filesRoot))).toBe(true);
    const created = await json<{ path: string }>(await call('gina', 'POST', '/api/workspace/repositories', { body: { name: 'gina-own' } }));
    expect(created.path.startsWith(filesRoot)).toBe(false);
    const scanned = await json<{ repos: Array<{ name: string }> }>(await call('gina', 'POST', '/api/workspace/repos/scan'));
    expect(scanned.repos.map((r) => r.name)).not.toContain('internal');
  });

  test('in a space, scanning needs the write right, and the membership', async () => {
    const { scanUserRepos, loadRepoGraph } = await import('@/core/repos/registry-service');
    for (const role of ['viewer', 'commenter'] as const) {
      await expect(scanUserRepos({ userId: ids.viewer, workspaceId: spaceId, space: { workspaceId: spaceId, role, scope: null } })).rejects.toMatchObject({ code: 'forbidden_role' });
    }
    await expect(scanUserRepos({ userId: ids.gina, workspaceId: spaceId, space: guestSpace() })).rejects.toMatchObject({ code: 'forbidden_role' });
    // A space named without the membership is refused, never read as the whole space.
    await expect(loadRepoGraph({ userId: ids.editor, workspaceId: spaceId })).rejects.toMatchObject({ code: 'forbidden_role' });
    const scanned = await scanUserRepos({ userId: ids.editor, workspaceId: spaceId, space: { workspaceId: spaceId, role: 'editor', scope: null } });
    expect(scanned.map((r) => r.name)).toEqual(expect.arrayContaining(['client', 'internal']));
  });

  test('a guest reads only the repositories under their folders, and no remote URL carries credentials', async () => {
    const { repoRegistryRepository } = await import('@/db/repositories/repo-registry-repository');
    // gina's registry rows (written before she was a guest): one in her folder, one not.
    for (const name of ['client', 'internal']) {
      await repoRegistryRepository.upsert({
        userId: ids.gina, workspaceId: spaceId, name, rootPath: join(filesRoot, name), kind: 'library', languages: [],
        dependencies: [], hasAgentsMd: false, remoteUrl: 'https://bot:s3cr3t-token@git.example.com/launch.git', lastScannedAt: new Date(),
      });
    }
    const { loadRepoGraph } = await import('@/core/repos/registry-service');
    expect((await loadRepoGraph({ userId: ids.gina, workspaceId: spaceId, space: guestSpace() })).repos.map((r) => r.name)).toEqual(['client']);

    // The agent's tool (a guest's turn is refused it by the approval path; an
    // editor's) shows no credentials either.
    await q(`UPDATE workspace_repos SET remote_url = 'https://bot:s3cr3t-token@git.example.com/launch.git' WHERE user_id = $1 AND name = 'client'`, [ids.editor]);
    const { repoRegistryTool } = await import('@/tools/repo-registry');
    await repoRegistryTool.initialize();
    const handlers = new Map(repoRegistryTool.getToolHandlers().map((h) => [h.name.replace('repo_registry__', ''), h]));
    const { buildAgentContext } = await import('@/core/agent/context');
    const context = buildAgentContext({
      sessionId: clientId, userId: ids.editor, topic: 'general', model: 'm', role: 'general',
      scope: { workspaceId: spaceId, space: { workspaceId: spaceId, role: 'editor', scope: null }, trigger: 'room', funding: 'own' },
    });
    const unwrap = (r: any) => (r && typeof r === 'object' && 'data' in r ? r.data : r);
    const detail = unwrap(await handlers.get('get_repo')!.execute({ repo: join(filesRoot, 'client') }, context));
    expect(detail.remoteUrl).toBe('https://git.example.com/launch.git');

    // And the REST detail of a personal repository.
    const { redactRemoteUrl } = await import('@/core/repos/registry-service');
    expect(redactRemoteUrl('https://user:tok@host/x.git')).toBe('https://host/x.git');
    expect(redactRemoteUrl('ssh://git@host:22/x.git')).toBe('ssh://host:22/x.git');
    expect(redactRemoteUrl('git@host:x.git')).toBe('git@host:x.git');
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const { agentPrincipal } = await import('@/security/principal');
    const personal = WorkspaceFS.forPrincipal(agentPrincipal({ userId: ids.editor, workspaceId: (await q<{ id: string }>(`SELECT id FROM workspaces WHERE user_id = $1 AND is_default`, [ids.editor]))[0].id }));
    mkdirSync(join(personal.root, 'tool'), { recursive: true });
    writeFileSync(join(personal.root, 'tool', 'package.json'), JSON.stringify({ name: 'tool' }));
    await json(await call('editor', 'POST', '/api/workspace/repos/scan', { space: null }));
    await q(`UPDATE workspace_repos SET remote_url = 'https://bot:s3cr3t-token@git.example.com/tool.git' WHERE user_id = $1 AND name = 'tool'`, [ids.editor]);
    const { repos } = await json<{ repos: Array<{ id: string; name: string }> }>(await call('editor', 'GET', '/api/workspace/repos', { space: null }));
    const tool = repos.find((r) => r.name === 'tool')!;
    expect((await json<{ remoteUrl: string }>(await call('editor', 'GET', `/api/workspace/repos/${tool.id}`, { space: null }))).remoteUrl).toBe('https://git.example.com/tool.git');
  });

  test('the root agent\'s project list shows a guest their folders only', async () => {
    const { projectListing } = await import('@/core/agent/agents-md');
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    expect(projectListing(WorkspaceFS.forSpace(spaceId, { guestFolders: ['client'] }))).toEqual(['  - client/']);
    expect(projectListing(WorkspaceFS.forSpace(spaceId, { guestFolders: [] }))).toEqual([]);
    expect(projectListing(WorkspaceFS.forSpace(spaceId))).toEqual(expect.arrayContaining(['  - client/', '  - internal/']));
  });
});

describe('the agent\'s task_state tools', () => {
  test('a guest\'s turn reads the rows of their own turns only; a member\'s reads the room\'s', async () => {
    const { taskStateTool } = await import('@/tools/task-state');
    await taskStateTool.initialize();
    const handlers = new Map(taskStateTool.getToolHandlers().map((h) => [h.name.replace('task_state__', ''), h]));
    const [editorRow] = await q<{ id: string }>(`INSERT INTO task_state (session_id, user_id, workspace_id, owner_agent, task_kind, status, outputs) VALUES ($1, $2, $3, 'research', 'agent_output', 'done', $4) RETURNING id`,
      [clientId, ids.editor, spaceId, JSON.stringify({ text: 'internal/plan.md says: secret plan' })]);
    const [ginaRow] = await q<{ id: string }>(`INSERT INTO task_state (session_id, user_id, workspace_id, owner_agent, task_kind, status, outputs) VALUES ($1, $2, $3, 'research', 'agent_output', 'done', $4) RETURNING id`,
      [clientId, ids.gina, spaceId, JSON.stringify({ text: 'the client brief, summarised' })]);
    const { buildAgentContext } = await import('@/core/agent/context');
    const context = (userId: string, space: { role: 'guest' | 'editor'; scope: { rooms: string[]; folders: string[] } | null }) => buildAgentContext({
      sessionId: clientId, userId, topic: 'general', model: 'm', role: 'general',
      scope: { workspaceId: spaceId, space: { workspaceId: spaceId, ...space }, trigger: 'room', funding: 'own' },
    });
    const gina = context(ids.gina, { role: 'guest', scope: { rooms: [clientId], folders: ['client'] } });
    const editor = context(ids.editor, { role: 'editor', scope: null });
    const run = (name: string, args: Record<string, unknown>, ctx: ReturnType<typeof context>) => handlers.get(name)!.execute(args, ctx) as Promise<any>;
    const unwrap = (r: any) => (r && typeof r === 'object' && 'data' in r ? r.data : r);

    const listed = unwrap(await run('list_recent_session_tasks', {}, gina));
    expect(listed.tasks.map((t: { id: string }) => t.id)).toEqual([ginaRow.id]);
    expect(unwrap(await run('read_task_state', { id: editorRow.id }, gina))).toMatchObject({ error: 'Task is not in the current session.' });
    expect(unwrap(await run('read_task_state', { id: ginaRow.id }, gina))).toMatchObject({ id: ginaRow.id });
    const asEditor = unwrap(await run('list_recent_session_tasks', {}, editor));
    expect(asEditor.tasks.map((t: { id: string }) => t.id).sort()).toEqual([editorRow.id, ginaRow.id].sort());
    expect(unwrap(await run('read_task_state', { id: editorRow.id }, editor))).toMatchObject({ outputs: { text: expect.stringContaining('secret plan') } });
  });
});

describe('search', () => {
  test('global search and hybrid knowledge search: the guest\'s chunks only', async () => {
    const mine = [`note:${briefId}`, join(filesRoot, 'client', 'spec.md')];
    // `/api/search` is not a space route: with the space header it searches
    // the caller's own workspace, never the space's chunks.
    const { results } = await json<{ results: Array<{ type: string; title: string }> }>(await call('gina', 'GET', '/api/search?q=chunk&limit=50'));
    const knowledge = results.filter((r) => r.type === 'knowledge').map((r) => r.title);
    expect(knowledge.filter((title) => title.startsWith('note:') || title.startsWith(filesRoot))).toEqual([]);

    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const { principalKnowledgeScope } = await import('@/core/rag/knowledge-scope');
    const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
    const service = getEmbeddingService();
    const embed = vi.spyOn(service, 'generateEmbedding').mockResolvedValue([0.1, 0.2, 0.3]);
    try {
      const hits = await service.hybridSearch(principalKnowledgeScope(await resolvedPrincipal(ids.gina, spaceId)), 'chunk', 50);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) expect(mine).toContain(hit.sourceId);
      const viewerHits = await service.hybridSearch(principalKnowledgeScope(await resolvedPrincipal(ids.viewer, spaceId)), 'chunk', 50);
      expect(viewerHits.length).toBeGreaterThan(hits.length);
    } finally {
      embed.mockRestore();
    }
  });
});

describe('stored scopes', () => {
  test('a malformed stored scope reads as the empty scope for that guest, and breaks nobody else', async () => {
    const [{ scope: kept }] = await q<{ scope: unknown }>(`SELECT scope FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [spaceId, ids.gus]);
    await q(`UPDATE workspace_members SET scope = '{"foo":1,"rooms":["${leadsId}"]}'::jsonb WHERE workspace_id = $1 AND user_id = $2`, [spaceId, ids.gus]);
    try {
      // Lists that walk every guest still answer.
      expect((await call('owner', 'GET', `/api/spaces/${spaceId}/rooms/${leadsId}/members`, { space: null })).status).toBe(200);
      const members = await json<{ members: Array<{ userId: string; scope?: unknown }> }>(await call('owner', 'GET', `/api/spaces/${spaceId}/members`, { space: null }));
      expect(members.members.find((m) => m.userId === ids.gus)?.scope).toEqual({ rooms: [], folders: [] });
      expect((await call('gina', 'GET', `/api/spaces/${spaceId}/members`, { space: null })).status).toBe(200);
      // gus himself reaches nothing: the least access, never more.
      const { rooms } = await json<{ rooms: unknown[] }>(await call('gus', 'GET', `/api/spaces/${spaceId}/rooms`, { space: null }));
      expect(rooms).toEqual([]);
      const { roomAccess } = await import('@/core/rooms/access');
      expect(await roomAccess(ids.gus, leadsId)).toBeNull();
    } finally {
      await q(`UPDATE workspace_members SET scope = $3 WHERE workspace_id = $1 AND user_id = $2`, [spaceId, ids.gus, JSON.stringify(kept)]);
    }
  });
});
