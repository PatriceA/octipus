/**
 * Coworking S0c — workspaces become real.
 *
 * Drives the TUI's real path on a real listening server: a gateway socket
 * opened with `?workspace=<slug>`, `auth`, then `chat.send` on a fresh
 * session id. The connection resolves the workspace at auth, the new session
 * is created in it, and the turn runs in it: the task, the artifact and the
 * file the agent writes, and the memories the turn reads and learns, all land
 * in that (non-default) workspace — not in the user's default.
 *
 * The model is the only stand-in: `runRootAgent` is replaced by an "agent"
 * that calls the real tasks, artifacts and filesystem tools with the context
 * the turn hands it, and the compaction summary is a fixed text. Memory
 * extraction needs a model too, so the memory module is observed rather
 * than run. Session compaction itself is real.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import WebSocket from 'ws';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const fx = vi.hoisted(() => ({
  turns: [] as Array<{ workspaceId: string | null; filePath?: string; taskId?: string; artifactId?: string }>,
  retrieve: [] as Array<{ workspaceId?: string | null }>,
  update: [] as Array<{ workspaceId?: string | null; userMessage?: string }>,
}));

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }), getModelForTopic: async () => null }),
}));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({
  retrieveForContext: async (scope: { workspaceId?: string | null }) => { fx.retrieve.push(scope); return []; },
  renderMemoriesBlock: () => '',
  updateMemoriesAfterTurn: async (input: { workspaceId?: string | null; userMessage?: string }) => { fx.update.push(input); return []; },
}));
vi.mock('@/core/learning/queue', () => ({ enqueueTurnLearning: async () => {} }));
vi.mock('@/core/cli-session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/cli-session-store')>()),
  acknowledgeProviderTurn: async () => {},
}));
vi.mock('@/utils/context-compaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/context-compaction')>()),
  createLLMSummary: async () => ({
    summaryText: 'The launch moved to May.',
    message: { role: 'user', content: 'The launch moved to May.', timestamp: new Date() },
    fileOps: { read: [], written: [], edited: [] },
  }),
}));
vi.mock('./root-runner', () => ({
  // The "agent": the real tools, run with the context the turn built.
  runRootAgent: async (...args: unknown[]) => {
    const [, , sessionId, userId, , , , , , workspaceId] = args as [unknown, unknown, string, string, unknown, unknown, unknown, unknown, unknown, string | null];
    const now = new Date();
    const context: AgentContext = {
      id: `agent-${randomUUID()}`, sessionId, userId, workspaceId, topic: 'general', model: 'test-model',
      role: 'general', root: true, status: 'running', createdAt: now, updatedAt: now, metadata: {},
    };
    const tool = async (id: string) => {
      const mod = id === 'tasks' ? await import('@/tools/tasks') : id === 'artifacts' ? await import('@/tools/artifacts') : await import('@/tools/filesystem');
      const instance = 'TasksTool' in mod ? new mod.TasksTool() : 'ArtifactsTool' in mod ? new mod.ArtifactsTool() : new (mod as typeof import('@/tools/filesystem')).FilesystemTool();
      await instance.initialize();
      return (instance as unknown as { tools: Map<string, { execute(a: Record<string, unknown>, c: AgentContext): Promise<any> }> }).tools;
    };
    const task = await (await tool('tasks')).get('create_task')!.execute({ title: 'draft the launch plan' }, context);
    const artifact = await (await tool('artifacts')).get('create_live_artifact')!.execute(
      { slug: `launch-${rand(3)}`, title: 'Launch board', type: 'table' }, context);
    const file = await (await tool('filesystem')).get('write_file')!.execute({ path: 'launch-plan.md', content: '# Launch\n' }, context);
    fx.turns.push({ workspaceId, filePath: file.path, taskId: task.task?.id ?? task.id, artifactId: artifact.id });
    return { response: 'Done.', agentId: context.id, sources: [], outcome: 'success' };
  },
}));

const aliceId = '44444444-4444-4444-8444-444444444444';
const bobId = '55555555-5555-4555-8555-555555555555';
let port = 0;
let stopServer: () => void = () => {};
let dataRoot = '';
const tokens: Record<string, string> = {};
const sockets: WebSocket[] = [];
let defaultWs = '';
let projectWs = '';
let bobWs = '';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-ws-turn-'));
  dataRoot = mkdtempSync(join(tmpdir(), 'octipus-ws-turn-files-'));

  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', dataRoot);

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: aliceId, username: 'alice-ws' }, { id: bobId, username: 'bob-ws' }]);
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const mgr = getOrgWorkspaceManager();
  defaultWs = (await mgr.ensureDefaultWorkspace(aliceId)).id;
  projectWs = (await mgr.createWorkspace(aliceId, { slug: 'launch', name: 'Launch' })).id;
  bobWs = (await mgr.ensureDefaultWorkspace(bobId)).id;

  const { getPermissionManager } = await import('@/security/permissions');
  for (const [tool, action] of [['tasks', 'write'], ['artifacts', 'write'], ['filesystem', 'write']] as const) {
    await getPermissionManager().setPermission(aliceId, tool, action, 'ALLOW');
  }

  const { getSessionManager } = await import('@/security/auth/session');
  for (const id of [aliceId, bobId]) tokens[id] = (await getSessionManager().create(id)).token;

  const { Elysia, listen } = await import('@/api/http');
  const { setupGatewayWebSocket } = await import('@/api/gateway-ws');
  const { getGatewayHub } = await import('@/core/gateway/hub');
  const { wireMessageHandler } = await import('@/core/gateway/message-handler');
  const app = new Elysia();
  setupGatewayWebSocket(app);
  wireMessageHandler(getGatewayHub());
  const server = listen(app, { hostname: '127.0.0.1', port: 0 });
  stopServer = () => server.stop();
  await vi.waitFor(() => expect(server.port).toBeGreaterThan(0));
  port = server.port;
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.terminate();
  stopServer();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

type Frame = Record<string, any>;

/** A gateway socket the way the TUI opens it: `?workspace=` in the URL, then `auth`. */
async function tui(userId: string, workspace?: string) {
  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway${query}`);
  sockets.push(ws);
  const frames: Frame[] = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token: tokens[userId] }, clientType: 'tui' }));
  const waitFor = async (pred: (f: Frame) => boolean) => {
    let found: Frame | undefined;
    await vi.waitFor(() => { found = frames.find(pred); expect(found).toBeDefined(); }, { timeout: 15_000 });
    return found!;
  };
  await waitFor((f) => f.type === 'auth_ok' || f.type === 'auth_error');
  return { ws, frames, waitFor, send: (frame: Frame) => ws.send(JSON.stringify(frame)) };
}

async function rowWorkspace(table: string, id: string): Promise<string | null> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT workspace_id FROM ${table} WHERE id = $1`, [id]);
  return rows[0]?.workspace_id ?? null;
}

describe("the TUI's workspace", () => {
  test('resolves at auth and holds the connection', async () => {
    const client = await tui(aliceId, 'launch');
    expect(client.frames).toContainEqual(expect.objectContaining({ type: 'auth_ok' }));
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const conns = getGatewayHub().connectionManager.getConnectionsByUser(aliceId);
    expect(conns.some((c) => c.context?.workspaceId === projectWs)).toBe(true);
  });

  test('without ?workspace= the connection works in the default workspace', async () => {
    const client = await tui(aliceId);
    const authOk = client.frames.find((f) => f.type === 'auth_ok')!;
    const { getGatewayHub } = await import('@/core/gateway/hub');
    const conn = getGatewayHub().connectionManager.getActiveConnections().find((c) => c.connectionId === authOk.connectionId)!;
    expect(conn.workspaceId).toBe(defaultWs);
  });

  test("an unknown workspace, or another user's, fails the sign-in instead of switching silently", async () => {
    for (const hint of ['no-such-workspace', bobWs]) {
      const client = await tui(aliceId, hint);
      expect(client.frames.find((f) => f.type === 'auth_error')?.reason).toBe('Unknown workspace');
      expect(client.frames.find((f) => f.type === 'auth_ok')).toBeUndefined();
    }
  });
});

describe('a turn in a non-default workspace', () => {
  test('creates the session there and writes its task, artifact, file and memories there', async () => {
    const client = await tui(aliceId, 'launch');
    const sessionId = randomUUID();
    client.send({ type: 'chat.send', sessionId, content: 'Prepare the launch: a task, a board and a plan file.' });
    await client.waitFor((f) => f.type === 'event' && f.event?.type === 'chat.response' || f.type === 'chat.response' || f.type === 'error');
    expect(client.frames.find((f) => f.type === 'error')).toBeUndefined();

    // The session was created in the connection's workspace.
    expect(await rowWorkspace('sessions', sessionId)).toBe(projectWs);

    // The turn ran there, and so did everything the agent wrote.
    expect(fx.turns).toHaveLength(1);
    const turn = fx.turns[0];
    expect(turn.workspaceId).toBe(projectWs);
    expect(await rowWorkspace('tasks', turn.taskId!)).toBe(projectWs);
    expect(await rowWorkspace('artifacts', turn.artifactId!)).toBe(projectWs);
    const projectRoot = join(dataRoot, 'users', aliceId, 'workspaces', projectWs, 'files');
    expect(turn.filePath!.startsWith(projectRoot + sep)).toBe(true);
    expect(readFileSync(turn.filePath!, 'utf8')).toBe('# Launch\n');
    expect(existsSync(join(dataRoot, 'users', aliceId, 'workspaces', 'default', 'files', 'launch-plan.md'))).toBe(false);

    // Memories are read from and learned into the session's workspace.
    await vi.waitFor(() => expect(fx.update.length).toBeGreaterThan(0));
    expect(fx.retrieve.every((s) => s.workspaceId === projectWs)).toBe(true);
    expect(fx.update.every((s) => s.workspaceId === projectWs)).toBe(true);
  });

  test("a compaction's memories are learned into the session's workspace", async () => {
    // A session of the project workspace with two exchanges to summarize.
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { executeRaw, queryRaw } = await import('@/db/postgres');
    const { id: sessionId } = await seedSession({ userId: aliceId, channelType: 'tui', channelId: rand(4) });
    await executeRaw(`UPDATE sessions SET workspace_id = '${projectWs}' WHERE id = '${sessionId}'`);
    const lines = [['user', 'Plan the launch.'], ['assistant', 'Planned for April.'], ['user', 'Move it to May.'], ['assistant', 'Moved to May.']];
    for (const [i, [role, content]] of lines.entries()) {
      await queryRaw(
        `INSERT INTO messages (session_id, role, content, created_at) VALUES ($1, $2, $3, now() - make_interval(secs => $4))`,
        [sessionId, role, content, 60 - i],
      );
    }

    const { refreshConfigKey } = await import('@/config');
    refreshConfigKey('memory.extractionCadence', 'on_compaction');
    try {
      const { maybeCompactSession } = await import('./session-compaction');
      expect(await maybeCompactSession(sessionId, { force: true })).toBe(true);
      await vi.waitFor(() => expect(fx.update.some((u) => u.userMessage === 'The launch moved to May.')).toBe(true));
      const fromCompaction = fx.update.filter((u) => u.userMessage === 'The launch moved to May.');
      expect(fromCompaction.every((u) => u.workspaceId === projectWs)).toBe(true);
    } finally {
      refreshConfigKey('memory.extractionCadence', 'per_turn');
    }
  });

  test('an existing session keeps its workspace whatever the connection says', async () => {
    const before = fx.turns.length;
    const { seedSession } = await import('@/test-helpers/multiuser-fixtures');
    const { executeRaw } = await import('@/db/postgres');
    const { id: sessionId } = await seedSession({ userId: aliceId, channelType: 'tui', channelId: rand(4) });
    await executeRaw(`UPDATE sessions SET workspace_id = '${defaultWs}' WHERE id = '${sessionId}'`);
    const client = await tui(aliceId, 'launch');
    client.send({ type: 'chat.send', sessionId, content: 'One more task for the default workspace, please.' });
    await vi.waitFor(() => expect(fx.turns.length).toBe(before + 1), { timeout: 15_000 });
    expect(fx.turns.at(-1)!.workspaceId).toBe(defaultWs);
    expect(await rowWorkspace('tasks', fx.turns.at(-1)!.taskId!)).toBe(defaultWs);
    expect(fx.turns.at(-1)!.filePath!.startsWith(join(dataRoot, 'users', aliceId, 'workspaces', 'default', 'files') + sep)).toBe(true);
  });
});
