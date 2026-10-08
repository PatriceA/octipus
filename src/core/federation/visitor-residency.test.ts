/**
 * The visitor's own agent and what the visitor keeps
 * (docs/plans/federation-spec.md §9, F-D11, FI8; tests of §11 items 14 and
 * 15).
 *
 * Two installs in one process, and here the database is B's alone. The
 * visitor (B) is the real one: routes, gateway with `remote.frame`, link
 * pool, agent service, the `remote-space` audience and tools. The host (A)
 * is the real `/federation` endpoint (handshake, seal, link) with its
 * operations answered from memory — A's messages, note and task live in
 * this file, never in the database — so after a full flow every text
 * column of the database is B's, and none may hold A's text outside the
 * rows of the visitor-agent session (F-D11). The model is the only other
 * stand-in: the root turn reads its context and calls the remote tools as
 * a model would.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

/** A's text: in A's memory only. */
const A_TEXT = {
  message: 'Zebra-orchid-4417 the launch moves to Thursday',
  note: 'Quokka-saffron-9921 pricing stays at nine euros',
  task: 'Narwhal-cobalt-3308 renew the venue contract',
};

const fx = vi.hoisted(() => ({
  turns: [] as Array<{ sessionId: string; context: string }>,
  memory: { retrieve: 0, update: 0, learn: 0 },
  /** What the stand-in model does in its turn. */
  act: null as null | ((sessionId: string, userId: string, scope: unknown) => Promise<string>),
}));

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
  retrieveForContext: async () => { fx.memory.retrieve++; return []; },
  renderMemoriesBlock: () => '',
  updateMemoriesAfterTurn: async () => { fx.memory.update++; return []; },
}));
vi.mock('@/core/learning/queue', () => ({ enqueueTurnLearning: async () => { fx.memory.learn++; } }));
vi.mock('@/core/agent/root-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/agent/root-runner')>();
  return {
    ...actual,
    runRootAgent: async (...args: unknown[]) => {
      const [, , sessionId, userId, , , , , context, scope] = args as [unknown, unknown, string, string, string, unknown, unknown, unknown, string, unknown];
      fx.turns.push({ sessionId, context });
      const response = fx.act ? await fx.act(sessionId, userId, scope) : 'ok';
      return { response, agentId: randomUUID(), sources: [], outcome: 'success' };
    },
  };
});
// A's operations are answered from memory below, not by the host operations.
vi.mock('./host-ops', () => ({
  registerHostOps: () => {},
  onRemoteMembershipChanged: async () => {},
  blockInstance: async () => ({ removed: 0, warnings: [] }),
  unblockInstance: async () => {},
  listInstances: async () => [],
  FederationAdminError: class extends Error {},
}));

type Identity = import('./identity').InstanceIdentity;
type Frame = Record<string, any>;

const LAN = ['127.0.0.1/32'];
const annaId = randomUUID();
const tokens: Record<string, string> = {};
let hostId: Identity;
let port = 0;
let app: { handle(request: Request): Promise<Response> };
let stopEndpoint: () => void;

// ── Host A, in memory ─────────────────────────────────────────────────

const A = {
  spaceId: randomUUID(),
  roomId: randomUUID(),
  noteId: randomUUID(),
  taskId: randomUUID(),
  token: rand(32),
  posted: [] as string[],
  proposals: [] as string[],
  doc: new Y.Doc(),
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

async function registerHostA(): Promise<void> {
  const { registerHostHandler } = await import('./host-server');
  A.doc.getText('body').insert(0, `${A_TEXT.note}\n`);
  const message = (id: string, content: string) => ({
    id, roomId: A.roomId, role: 'user', content, authorUserId: randomUUID(), authorName: 'ben', agentId: null,
    createdAt: new Date().toISOString(), metadata: {},
  });
  const pageMessages = [message(randomUUID(), A_TEXT.message)];
  registerHostHandler('space.join', async (raw, ctx) => {
    const body = raw as { token: string; user: { ref: string; name: string } };
    if (body.token !== A.token) throw new (await import('./link')).LinkRequestError('invite_invalid', 'Invite not found');
    const { queryRaw } = await import('@/db/postgres');
    await queryRaw(`INSERT INTO federation_instances (instance_id, public_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ctx.instanceId, ctx.link.peerPublicKey]);
    return { space: { id: A.spaceId, name: 'Launch', role: 'editor', scope: null }, member: { handle: `~anna@${ctx.instanceId.slice(0, 8)}` } };
  });
  registerHostHandler('space.info', async () => ({ id: A.spaceId, name: 'Launch', role: 'editor', scope: null, memberCount: 2 }));
  registerHostHandler('space.members', async () => ({ members: [{ userId: randomUUID(), displayName: 'ben', role: 'owner', remote: false }] }));
  registerHostHandler('space.rooms', async () => ({ rooms: [{ id: A.roomId, title: 'General', visibility: 'space', unreadCount: 0, muted: false }] }));
  registerHostHandler('room.page', async () => ({ messages: pageMessages, hasMore: false }));
  registerHostHandler('note.list', async () => ({ notes: [{ id: A.noteId, title: 'Pricing', slug: 'pricing', updatedAt: new Date().toISOString() }] }));
  registerHostHandler('note.read', async () => {
    const body = A.doc.getText('body').toString();
    return { id: A.noteId, title: 'Pricing', slug: 'pricing', body, bodySha256: sha(body), updatedAt: new Date().toISOString() };
  });
  registerHostHandler('note.propose', async (raw) => {
    A.proposals.push((raw as { body: string }).body);
    return { proposal: { id: randomUUID(), noteId: A.noteId, status: 'pending', updatedAt: new Date().toISOString() } };
  });
  registerHostHandler('task.list', async () => ({ tasks: [{ id: A.taskId, title: A_TEXT.task, status: 'open' }] }));
  registerHostHandler('task.read', async () => ({ task: { id: A.taskId, title: A_TEXT.task, status: 'open' }, comments: [], truncated: false }));
  registerHostHandler('task.create', async (raw) => ({ task: { id: randomUUID(), title: (raw as { title: string }).title, status: 'open' } }));
  registerHostHandler('conn.close', async () => ({ closed: true }));
  registerHostHandler('space.leave', async () => ({}));
  registerHostHandler('gateway.frame', async (raw, ctx) => {
    const { frame } = raw as { frame: Frame };
    const event = (body: Frame) => { ctx.link.sendEvent(ctx.as as string, ctx.conn as string, body); };
    if (frame.type === 'room.subscribe') {
      event({ type: 'subscribed', resources: [`room:${A.roomId}`] });
      event({ type: 'event', event: { type: 'room.message', payload: { roomId: A.roomId, message: pageMessages[0] } } });
    } else if (frame.type === 'room.post') {
      const id = randomUUID();
      A.posted.push(frame.content);
      event({ type: 'room.posted', roomId: frame.roomId, messageId: id, ...(frame.clientId ? { clientId: frame.clientId } : {}) });
    } else if (frame.type === 'doc.join') {
      event({
        type: 'doc.sync', noteId: A.noteId, epoch: 'e1', state: b64(Y.encodeStateAsUpdate(A.doc)), stateVector: b64(Y.encodeStateVector(A.doc)),
        readOnly: false, sha256: sha(A.doc.getText('body').toString()), maxBytes: 100_000,
      });
    } else if (frame.type === 'doc.update') {
      Y.applyUpdate(A.doc, Buffer.from(frame.update, 'base64'));
      event({ type: 'doc.saved', noteId: A.noteId, sha256: sha(A.doc.getText('body').toString()), revisionId: randomUUID(), savedAt: new Date().toISOString() });
    }
    return {};
  });
}

// ── B ─────────────────────────────────────────────────────────────────

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

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[annaId]}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function ok<T = any>(res: Promise<Response>): Promise<T> {
  const r = await res;
  expect(r.status, await r.clone().text()).toBeLessThan(300);
  return r.json() as Promise<T>;
}

async function tab(userId: string) {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const hub = getGatewayHub();
  const frames: Frame[] = [];
  const ws = { data: {}, readyState: 1, close: () => {}, send: (f: string) => frames.push(JSON.parse(f)) };
  const id = hub.connectionManager.handleOpen(ws, '127.0.0.1') as string;
  const send = async (msg: Frame) => { await hub.connectionManager.handleMessage(id, JSON.stringify(msg)); };
  await send({ type: 'auth', method: 'session_token', credentials: { token: userId }, clientType: 'webchat' });
  return { id, frames, send, close: () => hub.connectionManager.handleClose(id, 1000, 'test') };
}

/** A context for a remote tool call in `sessionId`, as the root agent's would be. */
async function agentContext(sessionId: string) {
  const [{ buildAgentContext }, { turnWorkspaceId }] = await Promise.all([import('@/core/agent/context'), import('@/core/agent/session-resolver')]);
  return buildAgentContext({
    sessionId, userId: annaId, topic: 'general', model: 'test-model', role: 'general', root: true, attended: true,
    scope: { workspaceId: await turnWorkspaceId(annaId, null), space: null, trigger: 'user', funding: 'own' },
  });
}

let remoteSpaceId = '';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-fed-residency-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octipus-fed-residency-files-')));
  const cfg = getConfig();
  cfg.federation.mode = 'both';
  cfg.federation.lanCidrs = LAN;
  // Learning and memory run per turn when on: the audience must keep them off.
  cfg.memory.extractionCadence = 'per_turn';
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'embedded' });
  const { initializeVault } = await import('@/security/vault');
  await initializeVault();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: annaId, username: 'anna' }]);
  const { getSessionManager } = await import('@/security/auth/session');
  tokens[annaId] = (await getSessionManager().create(annaId)).token;

  const { createServer } = await import('@/api/server');
  app = createServer();
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const hub = getGatewayHub();
  hub.setSessionValidator(async (token) => ({ userId: token, username: token, isAdmin: false }));
  hub.setWorkspaceResolver(async () => 'ws');
  const { wireMessageHandler } = await import('@/core/gateway/message-handler');
  wireMessageHandler(hub);

  const identity = await import('./identity');
  hostId = identity.identityFromPrivateKeyPem(identity.generateIdentityPem());
  await registerHostA();
  const { App, listen } = await import('@/api/http');
  const { setupFederationWebSocket } = await import('./host-server');
  const endpoint = new App();
  // biome-ignore lint/suspicious/noExplicitAny: the route builder type the server passes
  setupFederationWebSocket(endpoint as any, { identity: async () => hostId });
  const server = listen(endpoint, { hostname: '127.0.0.1', port: 0 });
  await waitFor(() => server.port !== 0, 'the endpoint to listen');
  port = server.port;
  stopEndpoint = () => server.stop();
  const [{ startVisitorOps }, { VisitorLinkPool }] = await Promise.all([import('./visitor-ops'), import('./visitor-client')]);
  startVisitorOps(new VisitorLinkPool(), hub);

  const { remoteSpace } = await ok(call('POST', '/api/remote-spaces/join', { link: `http://127.0.0.1:${port}/join/${A.token}#octipus=${hostId.instanceId}`, confirm: true }));
  remoteSpaceId = remoteSpace.id;
}, 120_000);

afterAll(async () => {
  const [{ _resetVisitorOpsForTests }, { _resetFederationHostForTests }] = await Promise.all([import('./visitor-ops'), import('./host-server')]);
  _resetVisitorOpsForTests();
  _resetFederationHostForTests();
  stopEndpoint?.();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

// ── §11 item 14: the visitor's agent ──────────────────────────────────

describe('the visitor\'s agent (§9, §11 item 14)', () => {
  test('the remote-space audience turns memory, learning, the profile, indexing and compaction off', async () => {
    const { session } = await ok(call('POST', `/api/remote-spaces/${remoteSpaceId}/rooms/${A.roomId}/agent`));
    expect(session.context.remoteRoom).toEqual({ remoteSpaceId, roomId: A.roomId, roomTitle: 'General' });
    // Opened once per room.
    expect((await ok(call('POST', `/api/remote-spaces/${remoteSpaceId}/rooms/${A.roomId}/agent`))).session.id).toBe(session.id);
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const row = await sessionRepository.findById(session.id);
    const { sessionAudience } = await import('@/core/agent/audience');
    expect(await sessionAudience(row)).toEqual({
      kind: 'remote-space', shared: true, personalMemoryOff: true, personalProfileOff: true, contentStorageOff: true,
    });
    // Marked shared at creation: a private read asks.
    const { isSharedAudience, getFlowLabel } = await import('@/security/flow-guard');
    expect(isSharedAudience(session.id)).toBe(true);
    expect(getFlowLabel(session.id).suspicious).toBe(true);

    fx.memory = { retrieve: 0, update: 0, learn: 0 };
    const { getAgentService } = await import('@/core/agent');
    const result = await getAgentService().handleMessage(session.id, annaId, 'What changed?', 'webchat');
    expect(result.response).toBe('ok');
    await new Promise((r) => setTimeout(r, 100));
    expect(fx.memory).toEqual({ retrieve: 0, update: 0, learn: 0 });
    // The turn got the room, fenced, for this turn only.
    const turn = fx.turns.find((t) => t.sessionId === session.id);
    expect(turn?.context).toContain(A_TEXT.message);
    expect(turn?.context).toMatch(/--- SPACE TURN CONTEXT [0-9a-f]{12} \(this turn only\) ---/);
    // Compaction is refused, forced or not.
    const { maybeCompactSession } = await import('@/core/agent/session-compaction');
    expect(await maybeCompactSession(session.id, { force: true })).toBe(false);
    expect(await q('SELECT 1 FROM compaction_entries WHERE session_id = $1', [session.id])).toHaveLength(0);
    // remoteRoom cannot be set through the sessions routes, nor changed or dropped.
    const made = await call('POST', '/api/sessions', { channelType: 'webchat', context: { remoteRoom: { remoteSpaceId, roomId: A.roomId, roomTitle: 'x' } } });
    expect(made.status).toBe(400);
    const patched = await ok(call('PATCH', `/api/sessions/${session.id}`, { context: { other: 1 } }));
    expect(patched.context.remoteRoom).toEqual(session.context.remoteRoom);
    expect((await call('PATCH', `/api/sessions/${session.id}`, { context: { remoteRoom: { remoteSpaceId, roomId: randomUUID(), roomTitle: 'x' } } })).status).toBe(400);
  });

  test('only the remote space tools and the web reads are offered', async () => {
    const [{ getToolRegistry }, { WebSearchTool }, { NotesTool }] = await Promise.all([
      import('@/tools/registry'), import('@/tools/websearch'), import('@/tools/notes'),
    ]);
    const registry = getToolRegistry();
    for (const tool of [new WebSearchTool(), new NotesTool()]) {
      if (!registry.get(tool.id)) await registry.register(tool);
      await registry.initialize(tool.id);
    }
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const { turnWorkspaceId } = await import('@/core/agent/session-resolver');
    const session = await sessionRepository.create({
      userId: annaId, workspaceId: await turnWorkspaceId(annaId, null), channelType: 'webchat', channelId: 'webchat', title: 'tools',
      context: { remoteRoom: { remoteSpaceId, roomId: A.roomId, roomTitle: 'General' } },
    });
    const actual = await vi.importActual<typeof import('@/core/agent/root-runner')>('@/core/agent/root-runner');
    const { getAgentManager } = await import('@/core/agent-manager');
    const manager = getAgentManager();
    const spawn = manager.spawn.bind(manager);
    let captured: { tools: Array<{ name: string }>; contextMetadata?: Record<string, unknown> } | null = null;
    (manager as unknown as { spawn: unknown }).spawn = async (opts: typeof captured) => { captured = opts; throw new Error('captured'); };
    try {
      const { getAgentService } = await import('@/core/agent');
      const { ModelSelector } = await import('@/core/agent/model-selector');
      const deps = {
        modelSelector: { selectForRootAgent: async () => ({ modelId: 'test-model', name: 'test-model' }) } as unknown as InstanceType<typeof ModelSelector>,
        emit: () => {}, setLastWorkerResult: () => {}, getLastWorkerResult: () => null,
      };
      await expect(actual.runRootAgent(
        getAgentService(), deps, session.id, annaId, 'summarise', { type: 'task', confidence: 1 } as never, [], 'webchat', '',
        { workspaceId: session.workspaceId, space: null, trigger: 'user', funding: 'own' },
      )).rejects.toThrow('captured');
    } finally {
      (manager as unknown as { spawn: unknown }).spawn = spawn;
    }
    const names = (captured as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    expect(names).toEqual(['remote_space_post', 'remote_space_propose_note', 'remote_space_read', 'remote_space_task_op', 'websearch__fetch_page', 'websearch__search']);
    expect((captured as unknown as { contextMetadata: Record<string, unknown> }).contextMetadata.remoteRoom).toBe(true);
  });

  test('a post asks every time after a private read, and only the first time in a clean session', async () => {
    const [{ remoteSpaceTools }, { sessionRepository }, { turnWorkspaceId }, { observeFlow }] = await Promise.all([
      import('./visitor-agent'), import('@/db/repositories/session-repository'), import('@/core/agent/session-resolver'), import('@/security/flow-guard'),
    ]);
    const ref = { remoteSpaceId, roomId: A.roomId, roomTitle: 'General' };
    const asked: string[] = [];
    const asker = { requestApproval: async (summary: string) => { asked.push(summary); return { approved: true }; } };
    const post = remoteSpaceTools(asker, ref).find((t) => t.name === 'remote_space_post')!;
    const newSession = async () => (await sessionRepository.create({
      userId: annaId, workspaceId: await turnWorkspaceId(annaId, null), channelType: 'webchat', channelId: 'webchat', title: 'post', context: { remoteRoom: ref },
    })).id;

    const clean = await agentContext(await newSession());
    expect(await post.execute({ content: 'one' }, clean)).toMatchObject({ posted: true });
    expect(await post.execute({ content: 'two' }, clean)).toMatchObject({ posted: true });
    expect(asked).toHaveLength(1);

    asked.length = 0;
    const tainted = await agentContext(await newSession());
    observeFlow(tainted.sessionId, { toolId: 'google-workspace', action: 'email_read' });
    for (const content of ['three', 'four', 'five']) expect(await post.execute({ content }, tainted)).toMatchObject({ posted: true });
    expect(asked).toHaveLength(3);
    expect(asked[0]).toMatch(/private data/);

    // Refused: nothing goes out.
    const refusing = { requestApproval: async () => ({ approved: false }) };
    const refused = remoteSpaceTools(refusing, ref).find((t) => t.name === 'remote_space_post')!;
    const before = A.posted.length;
    expect(await refused.execute({ content: 'six' }, tainted)).toMatchObject({ posted: false });
    expect(A.posted.length).toBe(before);
    // Unattended (an addressed turn): blocked until the member approved once in that session.
    const unattended = { ...(await agentContext(await newSession())), attended: false };
    expect(await post.execute({ content: 'seven' }, unattended)).toMatchObject({ posted: false });
  });
});

// ── §11 item 15: residency ────────────────────────────────────────────

describe('residency (FI8, §11 item 15)', () => {
  test('after a full flow, no text column on B outside the agent session holds A\'s text; memories, knowledge and embeddings are empty', async () => {
    // Read.
    expect((await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}`))).info.name).toBe('Launch');
    await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}/rooms`));
    await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}/members`));
    expect(JSON.stringify(await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}/rooms/${A.roomId}/messages`)))).toContain(A_TEXT.message);
    await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}/notes`));
    const note = await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}/notes/${A.noteId}`));
    expect(note.body).toContain(A_TEXT.note);
    expect(JSON.stringify(await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}/tasks`)))).toContain(A_TEXT.task);
    await ok(call('GET', `/api/remote-spaces/${remoteSpaceId}/tasks/${A.taskId}`));
    // Post.
    await ok(call('POST', `/api/remote-spaces/${remoteSpaceId}/rooms/${A.roomId}/messages`, { content: `Re: ${A_TEXT.message}` }));
    await ok(call('POST', `/api/remote-spaces/${remoteSpaceId}/tasks`, { title: `Follow up ${A_TEXT.task}` }));
    // Note edit: a proposal, and live through remote.frame.
    await ok(call('POST', `/api/remote-spaces/${remoteSpaceId}/notes/${A.noteId}/proposals`, { baseSha256: note.bodySha256, body: `${note.body}more` }));
    const t = await tab(annaId);
    await t.send({ type: 'remote.frame', remoteSpaceId, frame: { type: 'room.subscribe', roomId: A.roomId } });
    await t.send({ type: 'remote.frame', remoteSpaceId, frame: { type: 'doc.join', noteId: A.noteId } });
    const sync = await waitFor(() => t.frames.find((f) => f.type === 'remote.event' && f.event.type === 'doc.sync')?.event, 'doc.sync through B');
    const mine = new Y.Doc();
    Y.applyUpdate(mine, Buffer.from(sync.state, 'base64'));
    const vector = Y.encodeStateVector(mine);
    mine.getText('body').insert(0, 'edited on B: ');
    await t.send({ type: 'remote.frame', remoteSpaceId, frame: { type: 'doc.update', noteId: A.noteId, epoch: 'e1', update: b64(Y.encodeStateAsUpdate(mine, vector)) } });
    await waitFor(() => t.frames.find((f) => f.type === 'remote.event' && f.event.type === 'doc.saved'), 'doc.saved through B');
    expect(A.doc.getText('body').toString()).toContain('edited on B: ');
    expect(t.frames.some((f) => f.type === 'remote.event' && JSON.stringify(f.event).includes(A_TEXT.message))).toBe(true);
    t.close();

    // An agent turn that reads the note and the task and posts, quoting them.
    const { session } = await ok(call('POST', `/api/remote-spaces/${remoteSpaceId}/rooms/${A.roomId}/agent`));
    fx.act = async (sessionId, userId) => {
      const { remoteSpaceTools } = await import('./visitor-agent');
      const tools = remoteSpaceTools({ requestApproval: async () => ({ approved: true }) }, { remoteSpaceId, roomId: A.roomId, roomTitle: 'General' });
      const run = (name: string, args: Record<string, unknown>) => agentContext(sessionId).then((ctx) => tools.find((x) => x.name === name)!.execute(args, { ...ctx, userId }));
      const read = await run('remote_space_read', { kind: 'note', id: A.noteId }) as { body: string };
      await run('remote_space_read', { kind: 'task', id: A.taskId });
      await run('remote_space_post', { content: `Summary: ${read.body}` });
      return `Done. The room said: ${A_TEXT.message}; the note: ${read.body}; the task: ${A_TEXT.task}`;
    };
    try {
      const { getAgentService } = await import('@/core/agent');
      await getAgentService().handleMessage(session.id, annaId, 'Summarise the room and post it', 'webchat');
    } finally {
      fx.act = null;
    }
    expect(A.posted.some((p) => p.startsWith('Summary:'))).toBe(true);
    await new Promise((r) => setTimeout(r, 200));

    // The agent session holds A's text: the allowlist (F-D11).
    const agentSessions = (await q<{ id: string }>(`SELECT id FROM sessions WHERE context ? 'remoteRoom'`)).map((r) => r.id);
    expect(agentSessions).toContain(session.id);
    expect((await q('SELECT 1 FROM messages WHERE session_id = $1 AND content LIKE $2', [session.id, `%${A_TEXT.message}%`])).length).toBeGreaterThan(0);

    /** Rows of these tables keyed to a visitor-agent session are the F-D11 allowlist. */
    const ALLOWLIST: Record<string, string> = {
      messages: 'session_id', tool_actions: 'session_id', run_events: 'run_id', trajectory_runs: 'root_session_id', agent_approvals: 'session_id', sessions: 'id',
    };
    const columns = await q<{ table_name: string; column_name: string }>(`
      SELECT c.table_name, c.column_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'json', 'jsonb', 'ARRAY')`);
    expect(columns.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const { table_name: table, column_name: column } of columns) {
      const keyed = ALLOWLIST[table];
      const exclude = keyed ? ` AND NOT (${keyed}::text = ANY($4))` : '';
      const rows = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${table}" WHERE ("${column}"::text LIKE '%' || $1 || '%' OR "${column}"::text LIKE '%' || $2 || '%' OR "${column}"::text LIKE '%' || $3 || '%')${exclude}`,
        [A_TEXT.message, A_TEXT.note, A_TEXT.task, ...(keyed ? [agentSessions] : [])],
      );
      if (rows[0].n > 0) found.push(`${table}.${column}`);
    }
    expect(found).toEqual([]);
    for (const table of ['memories', 'embeddings', 'compaction_entries']) {
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n, table).toBe(0);
    }
    const knowledge = (await q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'knowledge%'`)).map((r) => r.table_name);
    for (const table of knowledge) expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))[0].n, table).toBe(0);
    // The pointer row: metadata only.
    const [pointer] = await q('SELECT * FROM remote_spaces WHERE id = $1', [remoteSpaceId]);
    expect(Object.keys(pointer).sort()).toEqual([
      'agent_answers_when_addressed', 'host_instance_id', 'host_public_key', 'host_url', 'id', 'joined_at', 'left_at', 'member_handle', 'role', 'space_id', 'space_name', 'user_id',
    ]);
  }, 60_000);
});
