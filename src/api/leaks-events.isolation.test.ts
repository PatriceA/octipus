/**
 * Coworking S0a, L4 and L9 — events and live artifacts across users.
 *
 *   - User B (an admin, on loopback) receives none of user A's swarm,
 *     pipeline and turn events, on the legacy `/ws` socket nor on `/gateway`:
 *     events built here with A's `userId` test the delivery filter, and the
 *     real `SwarmSpawner` emitters test that an emitter stamps the owner.
 *   - `artifact_token` viewers are capped per artifact, closed when their
 *     token expires, and closed (their token refused) when the artifact is
 *     deleted or its visibility changes.
 *   - Artifact events go to the resource `artifact:<id>` only: a non-owner's
 *     subscribe is refused, an `artifact_token` connection can subscribe to
 *     its own artifact and nothing else, and may send nothing but
 *     ping/subscribe/unsubscribe.
 *   - The artifacts tool writes into `context.workspaceId` and fails when the
 *     agent has none, instead of guessing one of the user's workspaces.
 *
 * Real routes (`/ws`, `/gateway`), real hub and connection manager, real
 * artifacts tool over embedded PGlite. Only the agent runtime behind `/ws` is
 * stood in by an event emitter, and the permission gate allows the tool call.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurnEvent } from '@/core/agent/service';
import type { AgentContext } from '@/core/types';

vi.mock('@electric-sql/pglite', async importOriginal => {
  const actual = await importOriginal<typeof import('@electric-sql/pglite')>();
  return { ...actual, PGlite: { create: (options: Record<string, unknown>) => actual.PGlite.create({ ...options, dataDir: undefined }) } };
});

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-4111-8111-111111111111';
const bobId = '22222222-2222-4222-8222-222222222222';
const aliceSession = randomUUID();
const aliceDefaultWs = randomUUID();
const aliceWorkWs = randomUUID();

const users: Record<string, { userId: string; username: string; isAdmin: boolean }> = {
  'tok-alice': { userId: aliceId, username: 'alice', isAdmin: false },
  // An admin: trust and admin rights must not widen what B sees.
  'tok-bob': { userId: bobId, username: 'bob', isAdmin: true },
};

const runtime = vi.hoisted(() => ({ turnListeners: new Set<(e: TurnEvent) => void>() }));

vi.mock('@/security/auth/session', () => ({
  getSessionManager: () => ({ validate: async (token: string) => users[token] ?? null }),
}));
vi.mock('@/security/permissions', () => ({
  getPermissionManager: () => ({
    onRequest: () => () => {},
    onResolved: () => () => {},
    check: async () => ({ level: 'ALLOW', source: 'policy' }),
  }),
}));
vi.mock('@/channels/webchat', () => ({ webChatChannel: { registerConnection: () => randomUUID(), unregisterConnection: () => {} } }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ onEvent: () => () => {}, get: () => undefined }) }));
vi.mock('@/core/agent', () => ({
  getAgentService: () => ({
    onEvent: (fn: (e: TurnEvent) => void) => {
      runtime.turnListeners.add(fn);
      return () => runtime.turnListeners.delete(fn);
    },
  }),
}));
vi.mock('@/core/documents/queue', () => ({ getDocumentQueue: () => ({ on: () => {}, off: () => {} }) }));
vi.mock('@/core/gateway/message-handler', () => ({ trySteerRunningRootAgent: async () => false }));
vi.mock('./browser-bridge', () => ({ getBrowserBridge: () => ({}) }));
vi.mock('./voice-media-ws', () => ({ setupVoiceMediaWebSocket: () => {} }));
vi.mock('./voice-ws', () => ({ setupVoiceWebSocket: () => {} }));

import { Elysia } from '@/api/http';
import { setupGatewayWebSocket } from './gateway-ws';
import { setupWebSocket } from './websocket';

type Frame = Record<string, any>;
interface FakeSocket { ws: any; frames: Frame[] }

function fakeSocket(path: string): FakeSocket {
  const frames: Frame[] = [];
  const ws = {
    data: { request: new Request(`http://localhost${path}`) },
    remoteAddress: '127.0.0.1',
    readyState: 1,
    send: (f: string) => frames.push(JSON.parse(f)),
    close: vi.fn(),
  };
  return { ws, frames };
}

const app = new Elysia();
setupWebSocket(app);
setupGatewayWebSocket(app);
const route = (path: string) => app.websocketRoutes().find(r => r.path === path)!.handlers;

async function openLegacy(token: string): Promise<FakeSocket> {
  const s = fakeSocket(`/ws?token=${token}`);
  await route('/ws').open!(s.ws);
  return s;
}

async function openGateway(auth: Frame): Promise<FakeSocket> {
  const s = fakeSocket('/gateway');
  const h = route('/gateway');
  await h.open!(s.ws);
  await h.message!(s.ws, JSON.stringify({ type: 'auth', clientType: 'webchat', ...auth }));
  return s;
}

async function sendGateway(s: FakeSocket, frame: Frame): Promise<void> {
  await route('/gateway').message!(s.ws, JSON.stringify(frame));
}

async function waitForFrame(s: FakeSocket, match: (f: Frame) => boolean): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    const hit = s.frames.find(match);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`no matching frame; got ${JSON.stringify(s.frames)}`);
}

function emitTurn(event: Omit<TurnEvent, 'timestamp'>): void {
  const full: TurnEvent = { ...event, timestamp: new Date() };
  for (const fn of runtime.turnListeners) fn(full);
}

async function hubAndBridge() {
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const { turnEventToGateway } = await import('@/core/gateway/event-bridge');
  return { hub: getGatewayHub(), turnEventToGateway };
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-leaks-events-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob', isAdmin: true },
  ]);
  // Alice's default workspace is created first, so "the first workspace of
  // the user" — the old fallback — would pick it, not the one she works in.
  await executeRaw(`INSERT INTO workspaces (id, user_id, slug, name, is_default) VALUES ('${aliceDefaultWs}', '${aliceId}', 'default', 'Default', true)`);
  await executeRaw(`INSERT INTO workspaces (id, user_id, slug, name) VALUES ('${aliceWorkWs}', '${aliceId}', 'work', 'Work')`);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe("user B receives none of user A's events", () => {
  test('legacy /ws: delivery of turn, pipeline and swarm events stamped for A goes to A only', async () => {
    const a = await openLegacy('tok-alice');
    const b = await openLegacy('tok-bob');
    const { hub } = await hubAndBridge();

    emitTurn({ type: 'chat_response', sessionId: aliceSession, userId: aliceId, data: { response: 'alice-reply' } });
    emitTurn({ type: 'pipeline_event', sessionId: aliceSession, userId: aliceId, data: { event: 'stage_started', pipelineId: 'p-alice' } });
    hub.publishEvent({
      type: 'swarm.node_spawned', source: 'swarm:root', userId: aliceId, sessionId: aliceSession,
      payload: { rootSessionId: aliceSession, nodeId: 'n-alice' },
    });

    const aText = JSON.stringify(a.frames);
    expect(aText).toContain('alice-reply');
    expect(aText).toContain('p-alice');
    expect(aText).toContain('n-alice');
    expect(JSON.stringify(b.frames)).not.toContain(aliceSession);
  });

  test('/gateway: delivery to an admin on loopback filters them out too', async () => {
    const a = await openGateway({ method: 'session_token', credentials: { token: 'tok-alice' } });
    const b = await openGateway({ method: 'session_token', credentials: { token: 'tok-bob' } });
    await waitForFrame(a, f => f.type === 'auth_ok');
    await waitForFrame(b, f => f.type === 'auth_ok');
    const { hub, turnEventToGateway } = await hubAndBridge();

    for (const turn of [
      { type: 'chat_response', sessionId: aliceSession, userId: aliceId, data: { response: 'alice-reply' } },
      { type: 'pipeline_event', sessionId: aliceSession, userId: aliceId, data: { event: 'pipeline_created', pipelineId: 'p-alice' } },
    ] as const) {
      hub.publishEvent(turnEventToGateway({ ...turn, timestamp: new Date() }));
    }
    for (const type of ['swarm.node_spawned', 'swarm.call_graph_cycle_blocked'] as const) {
      hub.publishEvent({ type, source: 'swarm:root', userId: aliceId, sessionId: aliceSession, payload: { rootSessionId: aliceSession } });
    }

    const aEvents = a.frames.filter(f => f.type === 'event').map(f => f.event.type);
    expect(aEvents).toEqual(['chat.response', 'pipeline.event', 'swarm.node_spawned', 'swarm.call_graph_cycle_blocked']);
    expect(b.frames.filter(f => f.type === 'event')).toEqual([]);
  });
});

describe('a real emitter stamps the owner', () => {
  test("SwarmSpawner's swarm events reach the node's user only, on /gateway and /ws", async () => {
    const a = await openGateway({ method: 'session_token', credentials: { token: 'tok-alice' } });
    const b = await openGateway({ method: 'session_token', credentials: { token: 'tok-bob' } });
    await waitForFrame(a, f => f.type === 'auth_ok');
    await waitForFrame(b, f => f.type === 'auth_ok');
    const legacyA = await openLegacy('tok-alice');
    const legacyB = await openLegacy('tok-bob');
    const { hub } = await hubAndBridge();

    const { SwarmSpawner } = await import('@/core/swarm/spawner');
    const spawner = new SwarmSpawner(hub);
    const root = SwarmSpawner.makeSwarmRoot({
      id: 'root-alice', rootSessionId: aliceSession, userId: aliceId, role: 'general', model: 'test',
      allowedToolIds: [], signal: new AbortController().signal,
    });
    root.budget.tokens.used = root.budget.tokens.cap;
    // The spawner's own publish paths, as a spawn reaches them.
    const emitters = spawner as unknown as {
      emitBudgetWarning(node: typeof root): void;
      emitNodeSpawned(parent: typeof root, payload: Record<string, unknown>): void;
      emitNodeCompleted(parent: typeof root, payload: Record<string, unknown>): void;
    };
    emitters.emitBudgetWarning(root);
    emitters.emitNodeSpawned(root, { nodeId: 'child-alice' });
    emitters.emitNodeCompleted(root, { nodeId: 'child-alice' });

    const events = a.frames.filter(f => f.type === 'event').map(f => f.event);
    expect(events.map(e => e.type)).toEqual(['swarm.budget_warning', 'swarm.node_spawned', 'swarm.node_completed']);
    expect(events.every(e => e.userId === aliceId)).toBe(true);
    expect(b.frames.filter(f => f.type === 'event')).toEqual([]);
    expect(JSON.stringify(legacyA.frames)).toContain('child-alice');
    expect(JSON.stringify(legacyB.frames)).not.toContain('child-alice');
  });
});

describe('artifacts', () => {
  let artifactId = '';
  let otherArtifactId = '';

  async function artifactsTool() {
    const { ArtifactsTool } = await import('@/tools/artifacts');
    const tool = new ArtifactsTool();
    await tool.initialize();
    return new Map(tool.getToolHandlers().map(h => [h.name.replace('artifacts__', ''), h]));
  }

  const ctx = (workspaceId: string | null): AgentContext => ({
    id: randomUUID(), sessionId: aliceSession, userId: aliceId, workspaceId,
    topic: 'test', model: 'test', role: 'general', status: 'running',
    createdAt: new Date(), updatedAt: new Date(), metadata: {},
  });

  test('the tool fails without a workspace instead of picking one', async () => {
    const tools = await artifactsTool();
    await expect(tools.get('create_live_artifact')!.execute({ slug: 'no-ws', title: 'x', type: 'html' }, ctx(null)))
      .rejects.toThrow(/workspace/);
    await expect(tools.get('list_live_artifacts')!.execute({}, ctx(null))).rejects.toThrow(/workspace/);
  });

  test("the tool writes into the agent's workspace", async () => {
    const tools = await artifactsTool();
    const created = await tools.get('create_live_artifact')!.execute({ slug: 'board', title: 'Board', type: 'html' }, ctx(aliceWorkWs)) as { id: string };
    const other = await tools.get('create_live_artifact')!.execute({ slug: 'other', title: 'Other', type: 'html' }, ctx(aliceWorkWs)) as { id: string };
    artifactId = created.id;
    otherArtifactId = other.id;
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    expect((await artifactsRepository.getById(artifactId))?.workspaceId).toBe(aliceWorkWs);

    // Listing from the default workspace does not see it.
    const listed = await tools.get('list_live_artifacts')!.execute({}, ctx(aliceDefaultWs)) as { artifacts?: Array<{ id: string }> };
    expect(JSON.stringify(listed)).not.toContain(artifactId);
  });

  test('a non-owner cannot subscribe to the artifact; the owner can', async () => {
    const a = await openGateway({ method: 'session_token', credentials: { token: 'tok-alice' } });
    const b = await openGateway({ method: 'session_token', credentials: { token: 'tok-bob' } });
    await waitForFrame(b, f => f.type === 'auth_ok');
    await waitForFrame(a, f => f.type === 'auth_ok');

    await sendGateway(b, { type: 'subscribe', resources: [`artifact:${artifactId}`] });
    await sendGateway(a, { type: 'subscribe', resources: [`artifact:${artifactId}`] });
    expect(await waitForFrame(b, f => f.type === 'error')).toMatchObject({ code: 'FORBIDDEN' });
    expect(await waitForFrame(a, f => f.type === 'subscribed')).toEqual({ type: 'subscribed', resources: [`artifact:${artifactId}`] });

    const { publishArtifactVersionUpdated } = await import('@/core/artifacts/events');
    publishArtifactVersionUpdated(artifactId, 'v-1');
    expect(a.frames.filter(f => f.type === 'event').map(f => f.event.payload)).toEqual([{ artifactId, versionId: 'v-1' }]);
    expect(b.frames.filter(f => f.type === 'event')).toEqual([]);
  });

  test('an artifact_token connection can subscribe to its artifact only', async () => {
    const { signArtifactToken } = await import('@/core/artifacts/token');
    const now = Math.floor(Date.now() / 1000);
    const token = signArtifactToken({ aid: artifactId, wid: aliceWorkWs, scope: 'view', iat: now, exp: now + 300 });

    // The token names one artifact; it does not open another.
    const wrong = await openGateway({ method: 'artifact_token', credentials: { artifactId: otherArtifactId, token } });
    expect(await waitForFrame(wrong, f => f.type === 'auth_error')).toBeTruthy();

    const viewer = await openGateway({ method: 'artifact_token', credentials: { artifactId, token } });
    expect(await waitForFrame(viewer, f => f.type === 'auth_ok')).toMatchObject({ capabilities: ['subscribe', 'ping'] });

    await sendGateway(viewer, { type: 'subscribe', resources: [`artifact:${otherArtifactId}`] });
    expect(await waitForFrame(viewer, f => f.type === 'error')).toMatchObject({ code: 'FORBIDDEN' });
    await sendGateway(viewer, { type: 'subscribe', resources: [`artifact:${artifactId}`] });
    expect(await waitForFrame(viewer, f => f.type === 'subscribed')).toEqual({ type: 'subscribed', resources: [`artifact:${artifactId}`] });

    // Not a user: it cannot chat or run commands.
    viewer.frames.length = 0;
    await sendGateway(viewer, { type: 'command', name: 'help' });
    expect(await waitForFrame(viewer, f => f.type === 'error')).toMatchObject({ code: 'FORBIDDEN' });

    // It gets its artifact's events, and no user's events.
    viewer.frames.length = 0;
    const { publishArtifactDataUpdated } = await import('@/core/artifacts/events');
    publishArtifactDataUpdated(otherArtifactId, 'feed', 'snap-0', new Date());
    publishArtifactDataUpdated(artifactId, 'feed', 'snap-1', new Date());
    const { hub } = await hubAndBridge();
    hub.publishEvent({ type: 'swarm.node_spawned', source: 'swarm:root', userId: aliceId, sessionId: aliceSession, payload: {} });
    expect(viewer.frames.map(f => [f.event.type, f.event.payload.artifactId, f.event.payload.snapshotId])).toEqual([
      ['artifact.data_updated', artifactId, 'snap-1'],
    ]);
  });

  const viewerToken = async (aid: string, iat: number, exp: number) => {
    const { signArtifactToken } = await import('@/core/artifacts/token');
    return signArtifactToken({ aid, wid: aliceWorkWs, scope: 'view', iat, exp });
  };

  test('a viewer connection closes when its token expires', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await viewerToken(artifactId, now, now + 2);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const viewer = await openGateway({ method: 'artifact_token', credentials: { artifactId, token } });
      expect(viewer.frames.at(-1)).toMatchObject({ type: 'auth_ok' });
      vi.advanceTimersByTime(1_000);
      expect(viewer.ws.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(viewer.ws.close).toHaveBeenCalledWith(4001, 'Artifact token expired');
    } finally {
      vi.useRealTimers();
    }
  });

  test('viewers of one artifact are capped', async () => {
    const { MAX_VIEWERS_PER_ARTIFACT } = await import('@/core/gateway/connection-manager');
    const now = Math.floor(Date.now() / 1000);
    const token = await viewerToken(otherArtifactId, now - 5, now + 300);
    const viewers: FakeSocket[] = [];
    for (let i = 0; i < MAX_VIEWERS_PER_ARTIFACT; i++) {
      viewers.push(await openGateway({ method: 'artifact_token', credentials: { artifactId: otherArtifactId, token } }));
    }
    expect(viewers.every(v => v.frames.at(-1)?.type === 'auth_ok')).toBe(true);
    const over = await openGateway({ method: 'artifact_token', credentials: { artifactId: otherArtifactId, token } });
    expect(over.frames.at(-1)).toEqual({ type: 'auth_error', reason: 'Too many connections' });

    // Deleting the artifact closes every viewer, and the token opens nothing.
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    await artifactsRepository.softDelete(otherArtifactId);
    for (const v of viewers) expect(v.ws.close).toHaveBeenCalledWith(4003, 'Artifact deleted');
    const { getGatewayHub } = await import('@/core/gateway/hub');
    expect(getGatewayHub().connectionManager.getConnectionsByUser(`artifact:${otherArtifactId}`)).toEqual([]);
    const again = await openGateway({ method: 'artifact_token', credentials: { artifactId: otherArtifactId, token } });
    expect(again.frames.at(-1)).toMatchObject({ type: 'auth_error' });
  });

  test('a visibility change closes viewers and refuses the tokens issued before it', async () => {
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const now = Math.floor(Date.now() / 1000);
    const token = await viewerToken(artifactId, now - 5, now + 300);
    const viewer = await openGateway({ method: 'artifact_token', credentials: { artifactId, token } });
    expect(viewer.frames.at(-1)).toMatchObject({ type: 'auth_ok' });

    // A title edit that keeps the visibility leaves viewers alone.
    const before = (await artifactsRepository.getById(artifactId))!;
    await artifactsRepository.update(artifactId, { title: 'Board 2', visibility: before.visibility });
    expect(viewer.ws.close).not.toHaveBeenCalled();

    await artifactsRepository.update(artifactId, { visibility: before.visibility === 'public' ? 'private' : 'public' });
    expect(viewer.ws.close).toHaveBeenCalledWith(4003, 'Artifact visibility changed');
    const again = await openGateway({ method: 'artifact_token', credentials: { artifactId, token } });
    expect(again.frames.at(-1)).toEqual({ type: 'auth_error', reason: 'Invalid or expired artifact token' });

    // A token minted after the change (a page reload) is accepted.
    const fresh = await viewerToken(artifactId, now + 2, now + 300);
    const reloaded = await openGateway({ method: 'artifact_token', credentials: { artifactId, token: fresh } });
    expect(reloaded.frames.at(-1)).toMatchObject({ type: 'auth_ok' });
  });
});
