/**
 * The agent inside a space (docs/plans/coworking-spec.md §5.6; I4–I7, D5,
 * D9, D13, D14).
 *
 * Real database (PGlite), real space service, real tools, real approval
 * paths and the real `POST /api/agents` route; the model is the only stand-in
 * (`runRootAgent` records the scope it was handed and makes two accounted
 * model calls), and the memory module is observed rather than run.
 *
 *   - every spawner builds its context through `buildAgentContext`
 *     (source-shape: no AgentContext literal that does not derive from a
 *     context, in any typed form), every spawn passes a scope, and
 *     `routeApproval(` is called only by `routeApprovalFor`;
 *   - a member's private space session runs with the space scope; a viewer
 *     cannot run the agent (turn and `POST /api/agents`), a stranger gets 404;
 *   - the role cap holds on all six approval paths and for a CLI model;
 *   - personal memories are not loaded in a space turn (children included,
 *     run through `spawnWorker`), and the requester's profile stays out;
 *   - personal-only tools (global ones such as `update_skill` included) are
 *     neither offered nor run; writes through personal connections (OAuth
 *     connectors, MCP servers, the real browser) are refused, their reads
 *     mark the session private; a coding agent's configuration (`.claude/`)
 *     is never written in a space;
 *   - I6: after a private read, a write into the space asks — the flow
 *     guard switched off — on the base-tool, tool-executor and CLI relay
 *     paths, with the label produced by a real read and kept across a
 *     restart (stored on the session);
 *   - a removed member's running agent stops mid-turn, and the spawn of a
 *     child fails; their next turn fails; an archived space runs no agent;
 *   - cost rows of the turn — and of a worker's own calls — carry the space
 *     and its funding, install-topic calls `install`;
 *   - a pipeline's verify command, a pipeline resume and an artifact's data
 *     sources follow the space rules too;
 *   - permission requests carry the space, and an admin who is not a member
 *     cannot see or answer them.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentContext, AgentSpace } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const fx = vi.hoisted(() => ({
  turns: [] as Array<{ sessionId: string; userId: string; scope: { workspaceId: string | null; space: { workspaceId: string; role: string } | null; trigger: string; funding: string } }>,
  retrieve: [] as Array<{ userId: string; workspaceId?: string | null }>,
  update: [] as Array<{ userId: string }>,
  /** Registry rows of CLI models an operator marked for shared use (D14). */
  cliModels: {
    'cli/claude': { modelId: 'cli/claude', provider: 'cli', metadata: { cliAgent: { sharedUse: true } } },
    'cli/vibe': { modelId: 'cli/vibe', provider: 'cli', metadata: { cliAgent: { sharedUse: true } } },
  } as Record<string, unknown>,
}));

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getDefaultModel: async () => ({ modelId: 'test-model' }),
    getAllModels: async () => [],
    getModelForTopic: async () => null,
    getUserBinding: async () => null,
    getModelByModelId: async (id: string) => fx.cliModels[id] ?? null,
    getModel: async () => null,
  }),
}));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({
  retrieveForContext: async (scope: { userId: string; workspaceId?: string | null }) => { fx.retrieve.push(scope); return []; },
  renderMemoriesBlock: () => '',
  updateMemoriesAfterTurn: async (input: { userId: string }) => { fx.update.push(input); return []; },
}));
vi.mock('@/core/learning/queue', () => ({ enqueueTurnLearning: async () => {} }));
vi.mock('@/core/cli-session-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/cli-session-store')>()),
  acknowledgeProviderTurn: async () => {},
}));
vi.mock('./session-compaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-compaction')>()),
  maybeCompactSession: async () => false,
}));
vi.mock('./root-runner', () => ({
  // The "agent": records the scope the turn built and makes one chat call
  // and one embedding call through the real usage accounting.
  runRootAgent: async (...args: unknown[]) => {
    const [, , sessionId, userId, , , , , , scope] = args as [unknown, unknown, string, string, unknown, unknown, unknown, unknown, unknown, (typeof fx.turns)[number]['scope']];
    fx.turns.push({ sessionId, userId, scope });
    const { recordProviderUsage } = await import('@/models/providers/instrumented');
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    await recordProviderUsage({ model: 'test-model', messages: [], sessionId }, 'test', { model: 'test-model', usage });
    await recordProviderUsage({ model: 'embed-model', messages: [], requestType: 'embedding' }, 'test', { model: 'embed-model', usage });
    return { response: 'Done.', agentId: randomUUID(), sources: [], outcome: 'success' };
  },
}));

const ownerId = randomUUID();
const editorId = randomUUID();
const commenterId = randomUUID();
const viewerId = randomUUID();
const adminId = randomUUID();

type App = { handle(request: Request): Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let spaceId = '';
let editorSession = '';
let commenterSession = '';
let viewerSession = '';
let editorPersonalSession = '';

async function call(who: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${tokens[who]}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

async function spaceSession(userId: string): Promise<string> {
  const { resolvedPrincipal } = await import('@/test-helpers/space-fixtures');
  const { contentRepos } = await import('@/db/repositories/content');
  const repos = contentRepos(await resolvedPrincipal(userId, spaceId));
  const session = await repos.sessions.create({ channelType: 'webchat', channelId: `space-${rand(4)}`, title: 'Space chat', status: 'active' });
  return session.id;
}

/** A context of `userId` in the space with `role` — built the one way contexts are built. */
async function spaceContext(userId: string, sessionId: string, role: AgentSpace['role'], opts: { attended?: boolean } = {}): Promise<AgentContext> {
  const { buildAgentContext } = await import('./context');
  return buildAgentContext({
    sessionId,
    userId,
    scope: { workspaceId: spaceId, space: { workspaceId: spaceId, role, scope: null }, trigger: 'user', funding: 'own' },
    topic: 'general',
    model: 'test-model',
    role: 'general',
    root: true,
    attended: opts.attended ?? false,
    status: 'running',
  });
}

async function notesHandlers() {
  const { NotesTool } = await import('@/tools/notes');
  const tool = new NotesTool();
  await tool.initialize();
  return (tool as unknown as { tools: Map<string, import('@/core/agent-base').ToolHandler> }).tools;
}

/** A worker of `userId` in the space, spawned the way every agent is (scope resolved, membership re-read). */
async function spaceWorker(userId: string, sessionId: string) {
  const { getAgentManager } = await import('@/core/agent-manager');
  const { resolveAgentScope } = await import('./context');
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  const scope = await resolveAgentScope({ session: await sessionRepository.findById(sessionId), userId, trigger: 'user' });
  return getAgentManager().spawn({ sessionId, userId, ...scope, model: 'test-model', topic: 'general' });
}

type Completion = import('@/models/litellm-client').CompletionResult;
const completion = (content: string, toolCalls: Completion['toolCalls'] = []): Completion => ({
  content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, model: 'test-model', latencyMs: 1,
});
/** Stand in for the worker's model: `next` answers each call. */
function scriptModel(worker: unknown, next: () => Promise<Completion>): void {
  (worker as { getCompletion: () => Promise<Completion> }).getCompletion = next;
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-space-turn-'));
  const { getConfig, refreshConfigKey } = await import('@/config');
  getConfig();
  refreshConfigKey('workspace.rootPath', mkdtempSync(join(tmpdir(), 'octipus-space-turn-files-')));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: ownerId, username: 'st-owner' },
    { id: editorId, username: 'st-editor' },
    { id: commenterId, username: 'st-commenter' },
    { id: viewerId, username: 'st-viewer' },
    { id: adminId, username: 'st-admin', isAdmin: true },
  ]);
  const { getSessionManager } = await import('@/security/auth/session');
  for (const [name, id] of [['owner', ownerId], ['editor', editorId], ['commenter', commenterId], ['viewer', viewerId], ['admin', adminId]]) {
    tokens[name] = (await getSessionManager().create(id)).token;
  }
  const { getPermissionManager } = await import('@/security/permissions');
  for (const id of [editorId, commenterId]) {
    for (const [tool, action] of [['notes', 'write'], ['notes', 'read'], ['shell', 'execute']] as const) {
      await getPermissionManager().setPermission(id, tool, action, 'ALLOW');
    }
    await getPermissionManager().setPermission(id, 'mcp', '*', 'ALLOW');
  }
  // What the editor's stored permissions allow, so a refusal below is the space's, not the policy's.
  for (const [tool, action] of [['filesystem', 'write'], ['filesystem', 'read'], ['connector', 'connector_call_tool'],
    ['cli-native:Write', 'Write'], ['artifacts', 'write'], ['artifacts', 'read']] as const) {
    await getPermissionManager().setPermission(editorId, tool, action, 'ALLOW');
  }
  const { createServer } = await import('@/api/server');
  app = createServer();

  const { spaceWith } = await import('@/test-helpers/space-fixtures');
  spaceId = await spaceWith(ownerId, [[editorId, 'editor'], [commenterId, 'commenter'], [viewerId, 'viewer']], 'Launch room');
  editorSession = await spaceSession(editorId);
  commenterSession = await spaceSession(commenterId);
  // A viewer cannot open a chat in the space; this one stands for a session
  // kept from before a downgrade.
  const { queryRaw } = await import('@/db/postgres');
  viewerSession = randomUUID();
  await queryRaw("INSERT INTO sessions (id, user_id, workspace_id, channel_type, channel_id, title, status) VALUES ($1, $2, $3, 'webchat', $4, 'Old chat', 'active')",
    [viewerSession, viewerId, spaceId, `v-${rand(4)}`]);
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const personalWs = (await getOrgWorkspaceManager().ensureDefaultWorkspace(editorId)).id;
  const { sessionRepository } = await import('@/db/repositories/session-repository');
  editorPersonalSession = (await sessionRepository.create({ userId: editorId, workspaceId: personalWs, channelType: 'webchat', channelId: `p-${rand(4)}`, title: 'Mine', status: 'active' })).id;
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

// ── Source shape ──────────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) out.push(path);
  }
  return out;
}
const SRC = join(import.meta.dirname, '..', '..');

/** Index of the brace that closes the one opening at `open`. */
function closingBrace(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return j;
  }
  return -1;
}

/** Index of the brace that opens the one closing at `close`. */
function openingBrace(src: string, close: number): number {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (src[j] === '}') depth++;
    else if (src[j] === '{' && --depth === 0) return j;
  }
  return -1;
}

/**
 * Object literals typed as an `AgentContext` in any form — annotated
 * (`: AgentContext = {`), cast (`{ … } as AgentContext`), checked
 * (`satisfies AgentContext`), or returned (`(): AgentContext => ({`,
 * `): AgentContext { return {`) — that do not derive from an existing
 * context: a literal whose first member spreads one (`{ ...context, … }`)
 * keeps its scope and is allowed.
 */
function handBuiltContexts(src: string): string[] {
  const opens: number[] = [];
  for (const m of src.matchAll(/:\s*(?:import\([^)]*\)\.)?AgentContext\s*=\s*\{/g)) opens.push(m.index + m[0].length - 1);
  for (const m of src.matchAll(/\)\s*:\s*(?:import\([^)]*\)\.)?AgentContext\s*=>\s*\(\s*\{/g)) opens.push(m.index + m[0].length - 1);
  for (const m of src.matchAll(/\)\s*:\s*(?:import\([^)]*\)\.)?AgentContext\s*\{\s*return\s*\{/g)) opens.push(m.index + m[0].length - 1);
  for (const m of src.matchAll(/\}\s*(?:as|satisfies)\s+(?:import\([^)]*\)\.)?AgentContext\b/g)) opens.push(openingBrace(src, m.index));
  return opens
    .filter((open) => open >= 0 && !/^\{\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*\.\.\./.test(src.slice(open, closingBrace(src, open) + 1)))
    .map((open) => src.slice(open, open + 60).replace(/\s+/g, ' '));
}

describe('one place builds agent contexts, one function decides tool calls', () => {
  test('the hand-built context check catches every typed literal form, and lets derived ones through', () => {
    const forms = [
      'const c: AgentContext = { id: "x", userId: "u" };',
      'const c = { id: "x", userId: "u" } as AgentContext;',
      'const c = { id: "x" } satisfies AgentContext;',
      'const make = (): AgentContext => ({ id: "x", userId: "u" });',
      'function make(): AgentContext {\n  return { id: "x", userId: "u" };\n}',
      'const c: import("@/core/types").AgentContext = { id: "x" };',
    ];
    for (const form of forms) expect(handBuiltContexts(form), form).toHaveLength(1);
    expect(handBuiltContexts('run({ ...context, stageName: "a", metadata: {} } as AgentContext);')).toEqual([]);
    expect(handBuiltContexts('const c: AgentContext = {\n  // the parent, plus a stage\n  ...parent, role: "qa" };')).toEqual([]);
    expect(handBuiltContexts('function make(): AgentContext { return buildAgentContext(input); }')).toEqual([]);
  });

  test('no AgentContext literal is hand-built outside context.ts', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('core', 'agent', 'context.ts')))
      .flatMap((f) => handBuiltContexts(readFileSync(f, 'utf8')).map((at) => `${relative(SRC, f)}: ${at}`));
    expect(offenders, 'build the context with buildAgentContext (src/core/agent/context.ts)').toEqual([]);
  });

  test('every agent spawn passes a space scope', () => {
    const calls: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b(?:agentManager|getAgentManager\(\)|manager)\.spawn\(\{/g)) {
        const open = m.index + m[0].length - 1;
        calls.push(`${relative(SRC, f)}: ${src.slice(m.index, closingBrace(src, open) + 1)}`);
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const c of calls) expect(c, c.split(':')[0]).toMatch(/\.\.\.(scope|inheritScope\()/);
  });

  test('routeApproval( is called only by routeApprovalFor', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('security', 'approval-policy.ts')) && !f.endsWith(join('security', 'approval-route.ts')))
      .filter((f) => /\brouteApproval\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders, 'decide through routeApprovalFor (src/security/approval-route.ts)').toEqual([]);
  });

  test('child workers read the session audience before loading memories and profile facts', () => {
    const src = readFileSync(join(SRC, 'core', 'agent', 'worker-spawner.ts'), 'utf8');
    expect(src).toContain('const audience = await sessionAudience(session)');
    expect(src).toContain('context.userId && !audience.personalProfileOff');
    expect(src).toContain('context.userId && !audience.personalMemoryOff');
    const direct = readFileSync(join(SRC, 'core', 'agent', 'direct-response.ts'), 'utf8');
    expect(direct).toContain('!(await sessionAudience(session)).personalProfileOff');
  });
});

// ── Turns ─────────────────────────────────────────────────────────────

describe('a private session in a space', () => {
  test('runs with the space scope, no personal memories, and cost rows carry the space and its funding', async () => {
    const { getAgentService } = await import('./service');
    const before = fx.turns.length;
    const retrieved = fx.retrieve.length;
    const result = await getAgentService().handleMessage(editorSession, editorId, 'Summarise the launch notes', 'webchat');
    expect(result.outcome).toBe('success');
    expect(fx.turns).toHaveLength(before + 1);
    const turn = fx.turns.at(-1)!;
    expect(turn.scope).toMatchObject({ workspaceId: spaceId, space: { workspaceId: spaceId, role: 'editor' }, trigger: 'user', funding: 'own' });
    // I7: no personal memories read or learned.
    expect(fx.retrieve.slice(retrieved).filter((r) => r.userId === editorId)).toEqual([]);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(
      'SELECT model_name, workspace_id, funding FROM cost_log WHERE user_id = $1 AND session_id = $2 ORDER BY created_at',
      [editorId, editorSession],
    );
    expect(rows).toContainEqual(expect.objectContaining({ model_name: 'test-model', workspace_id: spaceId, funding: 'own' }));
    const install = await queryRaw("SELECT workspace_id, funding FROM cost_log WHERE user_id = $1 AND model_name = 'embed-model'", [editorId]);
    expect(install.rows).toContainEqual({ workspace_id: spaceId, funding: 'install' });
  });

  test('a personal session still loads personal memories (control)', async () => {
    const { getAgentService } = await import('./service');
    const retrieved = fx.retrieve.length;
    await getAgentService().handleMessage(editorPersonalSession, editorId, 'What did I plan?', 'webchat');
    expect(fx.retrieve.slice(retrieved).some((r) => r.userId === editorId)).toBe(true);
    expect(fx.turns.at(-1)!.scope.space).toBeNull();
  });

  test('the session audience switches personal memories and profile off', async () => {
    const { sessionAudience } = await import('./audience');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    expect(await sessionAudience(await sessionRepository.findById(editorSession))).toMatchObject({ kind: 'space', personalMemoryOff: true, personalProfileOff: true, shared: false });
    expect(await sessionAudience(await sessionRepository.findById(editorPersonalSession))).toMatchObject({ kind: 'personal', personalMemoryOff: false, personalProfileOff: false });
  });

  test('a viewer cannot run the agent: the turn refuses before any model call', async () => {
    const { getAgentService } = await import('./service');
    const before = fx.turns.length;
    const result = await getAgentService().handleMessage(viewerSession, viewerId, 'hello', 'webchat');
    expect(fx.turns).toHaveLength(before);
    expect(result.response).toMatch(/viewer.*cannot run the agent/);
  });

  test('POST /api/agents: a viewer gets 403, a stranger 404, a scheduled trigger has no producer in a space', async () => {
    const viewer = await call('viewer', 'POST', '/api/agents', { sessionId: viewerSession, model: 'test-model' });
    expect(viewer.status).toBe(403);
    const stranger = await call('admin', 'POST', '/api/agents', { sessionId: editorSession, model: 'test-model' });
    expect(stranger.status).toBe(404);
    // A pipeline's stages write: a commenter cannot start one in the space.
    const { getPipelineManager } = await import('./pipeline-manager');
    const commenterCtx = await spaceContext(commenterId, commenterSession, 'commenter');
    await expect(getPipelineManager().createAndRun(commenterCtx.id, commenterSession, commenterId, 'Launch', 'any', 'Plan it', commenterCtx))
      .rejects.toThrow(/commenter.*cannot start a pipeline/);
    const { resolveAgentScope } = await import('./context');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    await expect(resolveAgentScope({ session: await sessionRepository.findById(editorSession), userId: editorId, trigger: 'schedule' }))
      .rejects.toThrow(/schedule run cannot start in a space/);
  });

  test('an agent in a space sees the space through its tools (reposFor)', async () => {
    const ctx = await spaceContext(editorId, editorSession, 'editor');
    const tools = await notesHandlers();
    const saved = await tools.get('write_note')!.execute({ title: 'Launch checklist', body: 'Ship on Monday' }, ctx) as { id: string };
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw('SELECT workspace_id, user_id FROM notes WHERE id = $1', [saved.id]);
    expect(rows[0]).toEqual({ workspace_id: spaceId, user_id: editorId });
    // Another member's agent reads it; the author's personal agent does not.
    const commenterCtx = await spaceContext(commenterId, commenterSession, 'commenter');
    const listed = await tools.get('list_notes')!.execute({}, commenterCtx) as { notes: Array<{ id: string }> };
    expect(listed.notes.map((n) => n.id)).toContain(saved.id);
    const { reposFor } = await import('@/db/repositories/content');
    const { agentKnowledgeOwner } = await import('@/core/rag/knowledge-scope');
    expect(reposFor(ctx).kind).toBe('space');
    // No knowledge chunk of a space is written without its workspace id.
    expect(agentKnowledgeOwner(ctx)).toEqual({ ownerUserId: editorId, workspaceId: spaceId });
    const chunks = await queryRaw(
      "SELECT count(*)::int AS n FROM embeddings WHERE workspace_id IS NULL AND source_id = 'note:' || $1",
      [saved.id],
    );
    expect(chunks.rows[0].n).toBe(0);
  });
});

// ── Role cap on every approval path (I4) ──────────────────────────────

describe('the role cap holds on all six approval paths', () => {
  test('base tool: a commenter writes nothing, reads and comments', async () => {
    const ctx = await spaceContext(commenterId, commenterSession, 'commenter');
    const tools = await notesHandlers();
    await expect(tools.get('write_note')!.execute({ title: 'Nope' }, ctx)).rejects.toThrow(/commenter.*only read and comment/);
    await expect(tools.get('list_notes')!.execute({}, ctx)).resolves.toBeDefined();
  });

  test('tool executor: the write is refused before it runs', async () => {
    const { ToolExecutor } = await import('@/core/tool-executor');
    const ctx = await spaceContext(commenterId, commenterSession, 'commenter');
    const exec = new ToolExecutor(ctx, () => {});
    exec.registerTool((await notesHandlers()).get('write_note')!);
    const [result] = await exec.handleToolCalls([{ id: 'c1', name: 'notes__write_note', arguments: { title: 'Nope' } }]);
    expect(String(result.content)).toMatch(/Permission denied: your role \(commenter\) can only read and comment/);
  });

  test('CLI permission relay: a native write is denied with the reason', async () => {
    const { answerCliPermissionRequest } = await import('@/core/cli-permissions');
    const ctx = await spaceContext(commenterId, commenterSession, 'commenter', { attended: true });
    const raw = { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch x' }, tool_use_id: 't' } };
    const out = await answerCliPermissionRequest(raw, ctx, () => {}) as { response: { response: { behavior: string; message?: string } } };
    expect(out.response.response.behavior).toBe('deny');
    expect(out.response.response.message).toMatch(/commenter/);
  });

  test('MCP transport: a non-read call is refused', async () => {
    const { authorizeMcpDispatch } = await import('@/security/mcp-authorization');
    const ctx = await spaceContext(commenterId, commenterSession, 'commenter');
    await expect(authorizeMcpDispatch(ctx, 'tracker.create_issue', {})).rejects.toThrow(/commenter.*only read and comment/);
  });

  test('scorer gate: a command check does not run for a commenter', async () => {
    const { runScorers } = await import('@/core/swarm/scorers');
    const outcome = await runScorers(
      [{ kind: 'command_exit_zero', command: 'true' }],
      { output: '', notes: '' },
      { userId: commenterId, sessionId: commenterSession, role: 'general', canRunCommands: true, workspaceRoot: tmpdir(),
        space: { workspaceId: spaceId, role: 'commenter', scope: null } },
    );
    expect(outcome.failures[0]?.reason).toMatch(/refused/);
  });

  test('action recovery: no replay approval is asked of a commenter', async () => {
    const { ActionRecovery, RecoveryReviewRequiredError } = await import('@/core/action-recovery');
    const { getPermissionManager } = await import('@/security/permissions');
    const spy = vi.spyOn(getPermissionManager(), 'requestApproval');
    const recovery = new ActionRecovery({
      pending: async () => [{ id: randomUUID(), toolName: 'notes__write_note', status: 'started', createdAt: new Date() }],
    } as never);
    const ctx = await spaceContext(commenterId, commenterSession, 'commenter', { attended: true });
    await expect(recovery.run(ctx, 'notes', 'notes__write_note', {}, async () => 'ran')).rejects.toBeInstanceOf(RecoveryReviewRequiredError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('CLI models: a commenter runs API models only; an editor only a CLI model marked for shared use', async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const spawn = (userId: string, sessionId: string, role: AgentSpace['role']) => getAgentManager().spawn({
      sessionId, userId, workspaceId: spaceId, space: { workspaceId: spaceId, role, scope: null }, trigger: 'user', funding: 'own',
      model: 'cli/claude-code', topic: 'general',
    });
    await expect(spawn(commenterId, commenterSession, 'commenter')).rejects.toThrow(/API models only/);
    await expect(spawn(editorId, editorSession, 'editor')).rejects.toThrow(/personal CLI subscription/);
  });
});

// ── I6 ────────────────────────────────────────────────────────────────

describe('I6: personal data reaches the space only with consent', () => {
  test('after a private read, a write into the space asks — flow guard off — on the base-tool and MCP paths', async () => {
    const { refreshConfigKey } = await import('@/config');
    refreshConfigKey('agent.flowGuard', 'off');
    const { observeFlow } = await import('@/security/flow-guard');
    const { ApprovalBlockedError } = await import('@/security/dispatch-authorization');
    const sessionId = await spaceSession(editorId);
    observeFlow(sessionId, { toolId: 'google-workspace', action: 'email_read' });
    const ctx = await spaceContext(editorId, sessionId, 'editor');
    const tools = await notesHandlers();
    // Reads still run; the write needs a human, and this run cannot ask one.
    await expect(tools.get('list_notes')!.execute({}, ctx)).resolves.toBeDefined();
    await expect(tools.get('write_note')!.execute({ title: 'From my inbox' }, ctx)).rejects.toBeInstanceOf(ApprovalBlockedError);
    // An MCP server is the requester's own: its writes are refused outright in a space.
    const { authorizeMcpDispatch } = await import('@/security/mcp-authorization');
    await expect(authorizeMcpDispatch(ctx, 'tracker.create_issue', {})).rejects.toThrow(/writes through your personal connection/);

    const { routeApprovalFor } = await import('@/security/approval-route');
    const decision = await routeApprovalFor({ ...ctx, attended: true }, { toolId: 'notes', action: 'write', toolName: 'write_note' }, { level: 'ALLOW' });
    expect(decision).toMatchObject({ route: 'ask_human', level: 'ASK', source: 'space-flow' });
    expect(decision.reason).toMatch(/writes data from your personal sources .* into Launch room/);
    // A session that read nothing private writes without asking.
    const clean = await routeApprovalFor({ ...ctx, sessionId: editorSession }, { toolId: 'notes', action: 'write', toolName: 'write_note' }, { level: 'ALLOW' });
    expect(clean.route).toBe('execute');
    refreshConfigKey('agent.flowGuard', 'ask');
  });

  test('personal-only tools are refused in a space and not offered', async () => {
    const { routeApprovalFor } = await import('@/security/approval-route');
    const { withoutPersonalOnlyTools } = await import('@/security/space-tools');
    const ctx = await spaceContext(editorId, editorSession, 'editor');
    const hook = await routeApprovalFor(ctx, { toolId: 'scheduling', action: 'write', toolName: 'create_hook' }, { level: 'ALLOW' });
    expect(hook).toMatchObject({ route: 'deny' });
    expect(hook.reason).toMatch(/personal account/);
    const offered = withoutPersonalOnlyTools([...(await notesHandlers()).values()]).map((h) => h.name);
    expect(offered).toContain('notes__write_note');
    expect(offered).not.toContain('notes__sync_vault');
  });
});

// ── Children, globals, CLI and personal connections ───────────────────

describe('children and workers of a space turn', () => {
  test('a child worker loads neither personal memories nor the profile (spawnWorker run in the space)', async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const { ProfileRepository } = await import('@/db/repositories/profile-repository');
    const profile = vi.spyOn(ProfileRepository.prototype, 'findUserProfile');
    const search = vi.spyOn(ProfileRepository.prototype, 'search');
    // Stop at the spawn: everything a child's prompt loads is loaded before it.
    const spawn = vi.spyOn(getAgentManager(), 'spawn').mockRejectedValue(new Error('stop: prompt assembled'));
    const { getAgentService } = await import('./service');
    try {
      const run = async (ctx: AgentContext) => {
        const retrieved = fx.retrieve.length;
        await expect(getAgentService().spawnWorker('research', 'Who is my wife?', 'Find out about my wife', ctx, { model: 'test-model' }))
          .rejects.toThrow(/stop: prompt assembled/);
        return fx.retrieve.slice(retrieved);
      };
      const inSpace = await run(await spaceContext(editorId, editorSession, 'editor'));
      expect(inSpace.filter((r) => r.userId === editorId)).toEqual([]);
      expect(profile).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ space: expect.objectContaining({ workspaceId: spaceId }) }));
      // Control: the same child in the member's personal session loads both.
      const { buildAgentContext, resolveAgentScope } = await import('./context');
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const scope = await resolveAgentScope({ session: await sessionRepository.findById(editorPersonalSession), userId: editorId, trigger: 'user' });
      const personal = buildAgentContext({ sessionId: editorPersonalSession, userId: editorId, scope, topic: 'general', model: 'test-model', role: 'general', root: true, status: 'running' });
      expect((await run(personal)).some((r) => r.userId === editorId)).toBe(true);
      expect(profile).toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      profile.mockRestore();
      search.mockRestore();
    }
  });

  test("a worker's own model calls are accounted to the space (AgentWorker's usage context)", async () => {
    const sessionId = await spaceSession(editorId);
    const worker = await spaceWorker(editorId, sessionId);
    const { recordProviderUsage } = await import('@/models/providers/instrumented');
    scriptModel(worker, async () => {
      await recordProviderUsage({ model: 'worker-model', messages: [] }, 'test', { model: 'worker-model', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
      return completion('Done.');
    });
    // No usage context around the run: the worker's own must stamp the rows.
    expect(await worker.run('Summarise')).toBe('Done.');
    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw("SELECT workspace_id, funding, session_id FROM cost_log WHERE user_id = $1 AND model_name = 'worker-model'", [editorId]);
    expect(rows).toContainEqual({ workspace_id: spaceId, funding: 'own', session_id: sessionId });
  });

  test('global tools: update_skill is not offered in a space, and the executor refuses it there', async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const { buildSkillLoaderHandlers } = await import('@/tools/skill-loader');
    const { buildTestContainerHandlers } = await import('@/tools/test-container');
    for (const handler of [...buildSkillLoaderHandlers(), ...buildTestContainerHandlers()]) getAgentManager().registerGlobalTool(handler);
    const tools = (w: unknown) => [...(w as { toolExecutor: { getTools(): Map<string, unknown> } }).toolExecutor.getTools().keys()];
    const editor = await spaceWorker(editorId, editorSession);
    const commenter = await spaceWorker(commenterId, commenterSession);
    const personal = await spaceWorker(editorId, editorPersonalSession);
    try {
      expect(tools(personal)).toContain('update_skill');
      expect(tools(editor)).not.toContain('update_skill');
      expect(tools(editor)).toContain('get_skill');
      expect(tools(commenter)).not.toContain('update_skill');
      expect(tools(commenter)).toEqual(expect.arrayContaining(['list_skills', 'get_skill']));
      // Registered anyway (a path that skips the filter): the executor refuses it in a space.
      const { ToolExecutor } = await import('@/core/tool-executor');
      const exec = new ToolExecutor(await spaceContext(commenterId, commenterSession, 'commenter'), () => {});
      const update = vi.fn();
      exec.registerTool({ name: 'update_skill', description: '', parameters: { type: 'object' }, execute: update });
      const [result] = await exec.handleToolCalls([{ id: 'u1', name: 'update_skill', arguments: { skill_id: 'x', content: 'pwned' } }]);
      expect(String(result.content)).toMatch(/Permission denied: update_skill acts on your personal account/);
      expect(update).not.toHaveBeenCalled();
    } finally {
      for (const w of [editor, commenter, personal]) getAgentManager().stop(w.getContext().id);
    }
  });

  test('CLI models: an editor runs a CLI model marked for shared use; one with no space mode is refused', async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const { CLIAgentWorker } = await import('@/core/cli-agent-worker');
    const spawn = (model: string) => getAgentManager().spawn({
      sessionId: editorSession, userId: editorId, workspaceId: spaceId, space: { workspaceId: spaceId, role: 'editor', scope: null }, trigger: 'user', funding: 'own',
      model, topic: 'general',
    });
    const worker = await spawn('cli/claude');
    try {
      expect(worker).toBeInstanceOf(CLIAgentWorker);
      expect(worker.getContext()).toMatchObject({ workspaceId: spaceId, space: { workspaceId: spaceId, role: 'editor' } });
    } finally {
      getAgentManager().stop(worker.getContext().id);
    }
    await expect(spawn('cli/vibe')).rejects.toThrow(/cannot run in a shared space/);
  });
});

describe('personal connections and agent configuration in a space', () => {
  test('writes through personal connections are refused; their reads run and mark the session private', async () => {
    const { routeApprovalFor } = await import('@/security/approval-route');
    const { getFlowLabel } = await import('@/security/flow-guard');
    const sessionId = await spaceSession(editorId);
    const ctx = await spaceContext(editorId, sessionId, 'editor', { attended: true });
    const decide = (toolId: string, action: string, toolName?: string, args?: Record<string, unknown>) =>
      routeApprovalFor(ctx, { toolId, action, toolName, args }, { level: 'ALLOW' });
    // (The space's own connectors — GitHub, Atlassian, `connector_*` — are
    // not personal in a space: space-connectors.isolation.test.ts.)
    const writes: Array<[string, string, string, Record<string, unknown>?]> = [
      ['browser-ext', 'navigate', 'navigate'],
      ['browser-ext', 'cookies', 'cookies'],
      ['mcp', 'tracker.create_issue', 'tracker.create_issue'],
      ['gitlab', 'write', 'create_issue'],
      ['google-workspace', 'email_send', 'email_send'],
    ];
    for (const [toolId, action, toolName, args] of writes) {
      expect(await decide(toolId, action, toolName, args), `${toolId}.${action}`)
        .toMatchObject({ route: 'deny', reason: expect.stringMatching(/personal connection/) });
    }
    for (const [toolId, action] of [['mcp_admin', 'configure'], ['skill-distill', 'distill']] as const) {
      expect(await decide(toolId, action, action)).toMatchObject({ route: 'deny', reason: expect.stringMatching(/personal account/) });
    }
    // An unknown container (a plugin) does not write into a space.
    expect(await decide('acme_plugin', 'publish', 'publish')).toMatchObject({ route: 'deny', reason: expect.stringMatching(/not known to act only on the space/) });
    expect(getFlowLabel(sessionId).private).toBe(false);
    // A read through a personal connection runs, and the session now holds private data.
    expect(await decide('mcp', 'tracker.search_issues', 'tracker.search_issues')).toMatchObject({ route: 'execute' });
    expect(getFlowLabel(sessionId)).toMatchObject({ private: true, sources: { private: 'mcp:tracker.search_issues' } });
    for (const [toolId, action] of [['browser-ext', 'extract'], ['google-workspace', 'email_read'], ['acme_plugin', 'read']] as const) {
      const fresh = await spaceSession(editorId);
      expect(await routeApprovalFor({ ...ctx, sessionId: fresh }, { toolId, action, toolName: action }, { level: 'ALLOW' })).toMatchObject({ route: 'execute' });
      expect(getFlowLabel(fresh).private, `${toolId}.${action}`).toBe(true);
    }
    // A read of the space's own content does not.
    const clean = await spaceSession(editorId);
    expect(await routeApprovalFor({ ...ctx, sessionId: clean }, { toolId: 'notes', action: 'read', toolName: 'list_notes' }, { level: 'ALLOW' })).toMatchObject({ route: 'execute' });
    expect(getFlowLabel(clean).private).toBe(false);
  });

  test('what a space session is offered: no personal-only container, argument-dependent tools kept for their reads', async () => {
    const { withoutPersonalOnlyTools } = await import('@/security/space-tools');
    const h = (name: string, toolId: string | undefined, extra: Partial<import('@/core/agent-base').ToolHandler> = {}) =>
      ({ name, toolId, description: '', parameters: { type: 'object' }, execute: async () => null, ...extra });
    const offered = withoutPersonalOnlyTools([
      h('connector_list_tools', 'connector', { replaySafety: 'read_only' }), h('connector_call_tool', 'connector'),
      h('mcp_call_tool', 'mcp', { permissionAction: (a) => `${a.server_id}.${a.tool_name}` }), h('mcp_list_tools', 'mcp', { replaySafety: 'read_only' }),
      h('browser-ext__navigate', 'browser-ext', { permissionAction: 'navigate' }), h('browser-ext__extract', 'browser-ext', { permissionAction: 'extract' }),
      h('mcp_admin__register_mcp_server', 'mcp_admin', { permissionAction: 'configure' }), h('skill-distill__distill_skill', 'skill-distill', { permissionAction: 'distill' }),
      h('update_skill', undefined), h('spawn_child', undefined), h('acme_plugin__publish', 'acme_plugin'),
    ]).map((t) => t.name);
    expect(offered.sort()).toEqual(['browser-ext__extract', 'connector_call_tool', 'connector_list_tools', 'mcp_call_tool', 'mcp_list_tools', 'spawn_child']);
  });

  test("a coding agent's configuration is never written in a space: file tools and native CLI writes", async () => {
    const { FilesystemTool } = await import('@/tools/filesystem');
    const tool = new FilesystemTool();
    await tool.initialize();
    const fsTools = (tool as unknown as { tools: Map<string, import('@/core/agent-base').ToolHandler> }).tools;
    const ctx = await spaceContext(editorId, editorSession, 'editor');
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const root = WorkspaceFS.forSpace(spaceId).root;
    const { existsSync } = await import('node:fs');
    for (const path of ['.claude/settings.json', '.claude/settings.local.json', 'sub/.codex/config.toml', '.gemini/settings.json', '.agents/hooks.json', '.mcp.json', join(root, '.claude', 'hooks.json')]) {
      await expect(fsTools.get('write_file')!.execute({ path, content: '{"permissions":{"allow":["Bash"]}}' }, ctx), path)
        .rejects.toThrow(/coding agent's configuration/);
    }
    expect(existsSync(join(root, '.claude'))).toBe(false);
    await fsTools.get('write_file')!.execute({ path: 'plan.md', content: 'ok' }, ctx);
    await expect(fsTools.get('move_file')!.execute({ source: 'plan.md', destination: '.claude/commands/plan.md' }, ctx)).rejects.toThrow(/coding agent's configuration/);
    await expect(fsTools.get('create_directory')!.execute({ path: '.codex' }, ctx)).rejects.toThrow(/coding agent's configuration/);
    // Only a space's root refuses them.
    expect(WorkspaceFS.withRoot(root).isSpace).toBe(false);

    const { answerCliPermissionRequest } = await import('@/core/cli-permissions');
    const native = (file_path: string) => answerCliPermissionRequest(
      { type: 'control_request', request_id: 'w1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path, content: '{}' }, tool_use_id: 't' } },
      { ...ctx, attended: false }, () => {}) as Promise<{ response: { response: { behavior: string; message?: string } } }>;
    const refused = await native(join(root, '.claude', 'settings.json'));
    expect(refused.response.response).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/coding agent's configuration/) });
    expect((await native(join(root, 'notes.md'))).response.response.behavior).toBe('allow');
  });
});

// ── I6 on every path, from a real read, across a restart ──────────────

describe('I6 from a real read, on the tool-executor and CLI relay paths', () => {
  test('a personal MCP read marks the session; the next space write asks on every path; a restart keeps the label', async () => {
    const { refreshConfigKey } = await import('@/config');
    refreshConfigKey('agent.flowGuard', 'off');
    try {
      const sessionId = await spaceSession(editorId);
      const ctx = await spaceContext(editorId, sessionId, 'editor');
      const { ToolExecutor } = await import('@/core/tool-executor');
      const exec = new ToolExecutor(ctx, () => {});
      const remote = vi.fn(async (args: Record<string, unknown>) => ({ called: args.tool_name, issues: [{ key: 'PRIV-1', summary: 'salary review' }] }));
      exec.registerTool({
        name: 'mcp_call_tool', toolId: 'mcp', description: '', parameters: { type: 'object' }, execute: remote,
        permissionAction: (a) => `${a.server_id}.${a.tool_name}`,
      });
      exec.registerTool((await notesHandlers()).get('write_note')!);
      const { answerCliPermissionRequest } = await import('@/core/cli-permissions');
      const cli = (sid: string) => answerCliPermissionRequest(
        { type: 'control_request', request_id: 'w', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'summary.md', content: 'x' }, tool_use_id: 't' } },
        { ...ctx, sessionId: sid, attended: false }, () => {}) as Promise<{ response: { response: { behavior: string; message?: string } } }>;

      // Before any personal read: the CLI write goes ahead.
      expect((await cli(sessionId)).response.response.behavior).toBe('allow');
      // The personal server's write is refused; its read runs.
      const [write] = await exec.handleToolCalls([{ id: 'c1', name: 'mcp_call_tool', arguments: { server_id: 'tracker', tool_name: 'create_issue' } }]);
      expect(String(write.content)).toMatch(/writes through your personal connection/);
      const [read] = await exec.handleToolCalls([{ id: 'c2', name: 'mcp_call_tool', arguments: { server_id: 'tracker', tool_name: 'search_issues' } }]);
      expect(String(read.content)).toContain('PRIV-1');
      expect(remote).toHaveBeenCalledTimes(1);

      // Tool executor: the space write now needs a human, and this run cannot ask one.
      const [note] = await exec.handleToolCalls([{ id: 'c3', name: 'notes__write_note', arguments: { title: 'Jira summary' } }]);
      expect(String(note.content)).toMatch(/Approval required: notes\.write_note writes data from your personal sources \(mcp:tracker\.search_issues\) into Launch room/);
      // CLI relay: the native write is refused with the same reason.
      expect((await cli(sessionId)).response.response).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/writes data from your personal sources/) });

      // The label is stored on the session: a restart (labels forgotten) still asks.
      const { queryRaw } = await import('@/db/postgres');
      await vi.waitFor(async () => {
        const { rows } = await queryRaw('SELECT flow_label FROM sessions WHERE id = $1', [sessionId]);
        expect(rows[0].flow_label).toMatchObject({ private: 'mcp:tracker.search_issues' });
      });
      const { resetFlowLabels, getFlowLabel } = await import('@/security/flow-guard');
      resetFlowLabels();
      expect(getFlowLabel(sessionId).private).toBe(false);
      const { routeApprovalFor } = await import('@/security/approval-route');
      expect(await routeApprovalFor({ ...ctx, attended: true }, { toolId: 'notes', action: 'write', toolName: 'write_note' }, { level: 'ALLOW' }))
        .toMatchObject({ route: 'ask_human', source: 'space-flow' });
      expect((await cli(sessionId)).response.response.behavior).toBe('deny');
    } finally {
      refreshConfigKey('agent.flowGuard', 'ask');
    }
  });
});

// ── Pipelines, artifacts, unseen spaces ───────────────────────────────

describe('pipelines, artifact sources and an unseen space follow the space rules', () => {
  test("a stage's verify command runs in the space's files under the space role cap", async () => {
    const { runStageVerifyCommand } = await import('./pipeline-manager');
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const root = WorkspaceFS.forSpace(spaceId).root;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'built.txt'), 'ok');
    const editor = await spaceContext(editorId, editorSession, 'editor');
    expect(await runStageVerifyCommand('ls built.txt', { userId: editorId, sessionId: editorSession, workspaceId: spaceId, space: editor.space, role: 'coding', toolIds: ['shell'] }))
      .toMatch(/RESULT: exit 0/);
    // A commenter's pipeline never runs the command (the role cap holds here too).
    expect(await runStageVerifyCommand('ls built.txt', { userId: commenterId, sessionId: commenterSession, workspaceId: spaceId, space: { workspaceId: spaceId, role: 'commenter', scope: null }, role: 'coding', toolIds: ['shell'] }))
      .toMatch(/RESULT: FAILED[\s\S]*commenter/);
    // A context naming the space without its scope is refused, not run as personal.
    expect(await runStageVerifyCommand('ls built.txt', { userId: editorId, sessionId: editorSession, workspaceId: spaceId, space: null, role: 'coding', toolIds: ['shell'] }))
      .toMatch(/RESULT: FAILED[\s\S]*no space scope/);
  });

  test('a pipeline does not resume for a starter who can no longer write in the space', async () => {
    const { pipelineRepository } = await import('@/db/repositories/pipeline-repository');
    const pipeline = await pipelineRepository.create({ rootAgentId: randomUUID(), sessionId: commenterSession, userId: commenterId,
      title: 'Launch', type: 'general', status: 'paused', metadata: { trigger: 'user' } } as never);
    await pipelineRepository.saveCheckpoint({ pipelineId: pipeline.id, nodeKey: 'stage-1', state: { cursor: 'stage-1' } });
    const { getPipelineManager } = await import('./pipeline-manager');
    await expect(getPipelineManager().resume(pipeline.id)).rejects.toThrow(/commenter.*cannot resume a pipeline/);
  });

  test('a space artifact takes no data source that runs as a personal agent', async () => {
    const ctx = await spaceContext(editorId, editorSession, 'editor');
    const { reposFor } = await import('@/db/repositories/content');
    const artifact = await reposFor(ctx).artifacts.create({ slug: `launch-${rand(3)}`, createdByAgentId: ctx.id, title: 'Launch board', type: 'dashboard', visibility: 'workspace' });
    const { ArtifactsTool } = await import('@/tools/artifacts');
    const tool = new ArtifactsTool();
    await tool.initialize();
    const add = (tool as unknown as { tools: Map<string, import('@/core/agent-base').ToolHandler> }).tools.get('add_artifact_data_source')!;
    for (const kind of ['tool', 'mcp']) {
      expect(await add.execute({ artifact_id: artifact.id, name: `s-${kind}`, kind, config: { tool: 'websearch__search' } }, ctx))
        .toMatchObject({ error: expect.stringMatching(/runs as your personal agent/) });
    }
    // A row attached another way is refused at refresh.
    const { artifactsRepository } = await import('@/db/repositories/artifacts-repository');
    const source = await artifactsRepository.createSource({ artifactId: artifact.id, name: 'legacy', kind: 'tool', configJson: { tool: 'websearch__search' }, refreshSeconds: 300, principalId: editorId });
    const { refreshSource } = await import('@/core/artifacts/refresh');
    expect(await refreshSource(source.id)).toMatchObject({ ok: false, error: expect.stringMatching(/runs as your personal agent/) });
  });

  test('a space this process has not seen yet is still recognised (database fallback)', async () => {
    const { forgetWorkspaceRow, isKnownSharedWorkspace } = await import('@/security/workspace-fs');
    forgetWorkspaceRow(spaceId);
    expect(isKnownSharedWorkspace(spaceId)).toBe(false);
    const { routeApprovalFor } = await import('@/security/approval-route');
    const ctx = await spaceContext(editorId, editorSession, 'editor');
    expect(await routeApprovalFor({ ...ctx, space: null }, { toolId: 'notes', action: 'read', toolName: 'list_notes' }, { level: 'ALLOW' }))
      .toMatchObject({ route: 'deny', reason: expect.stringMatching(/no space scope/) });
    expect(isKnownSharedWorkspace(spaceId)).toBe(true);
    const { getAgentManager } = await import('@/core/agent-manager');
    forgetWorkspaceRow(spaceId);
    await expect(getAgentManager().spawn({ sessionId: editorSession, userId: editorId, workspaceId: spaceId, space: null, trigger: 'user', funding: 'own', model: 'test-model', topic: 'general' }))
      .rejects.toThrow(/needs its space scope/);
  });
});

// ── Approvals (D9) ────────────────────────────────────────────────────

describe('permission requests of a space', () => {
  test('carry the space, and an admin who is not a member can neither list nor answer them', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const ctx = await spaceContext(editorId, editorSession, 'editor');
    const id = await getPermissionManager().requestApproval(editorId, ctx.id, 'notes', 'write', {}, editorSession, 'write_note', undefined, ctx.workspaceId);
    const { queryRaw } = await import('@/db/postgres');
    expect((await queryRaw('SELECT workspace_id FROM permission_requests WHERE id = $1', [id])).rows[0].workspace_id).toBe(spaceId);

    const list = await call('admin', 'GET', '/api/admin/permission-requests');
    expect(list.status).toBe(200);
    expect((await list.json()).requests.map((r: { requestId: string }) => r.requestId)).not.toContain(id);
    const answer = await call('admin', 'POST', `/api/admin/permission-requests/${id}/resolve`, { approved: true, reason: 'unblock' });
    expect(answer.status).toBe(404);
    expect((await queryRaw('SELECT status FROM permission_requests WHERE id = $1', [id])).rows[0].status).toBe('pending');
  });
});

// ── Membership and archive (I5, D15) ──────────────────────────────────

describe('membership changes and archive', () => {
  test("a removed member's running agent stops and their next turn fails", async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const { removeMember } = await import('@/core/spaces/service');
    const memberId = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: memberId, username: `st-member-${rand(3)}` }]);
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    await acceptInvite({ userId: memberId }, (await createInvite({ userId: ownerId }, spaceId, { role: 'editor' })).token);
    const sessionId = await spaceSession(memberId);
    const { resolveAgentScope } = await import('./context');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const scope = await resolveAgentScope({ session: await sessionRepository.findById(sessionId), userId: memberId, trigger: 'user' });
    const worker = await getAgentManager().spawn({ sessionId, userId: memberId, ...scope, model: 'test-model', topic: 'general' });
    expect(worker.getContext().space).toMatchObject({ workspaceId: spaceId, role: 'editor' });

    await removeMember({ userId: ownerId }, spaceId, memberId);
    expect(worker.getStatus()).toBe('stopped');
    await expect(getAgentManager().spawn({ sessionId, userId: memberId, ...scope, model: 'test-model', topic: 'general' }))
      .rejects.toThrow(/no longer a member/);
    const { getAgentService } = await import('./service');
    const before = fx.turns.length;
    const result = await getAgentService().handleMessage(sessionId, memberId, 'still there?', 'webchat');
    expect(fx.turns).toHaveLength(before);
    expect(result.outcome).not.toBe('success');
  });

  test("a removed member's turn in flight stops, and its next child cannot spawn", async () => {
    const { getAgentManager } = await import('@/core/agent-manager');
    const { removeMember } = await import('@/core/spaces/service');
    const memberId = randomUUID();
    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([{ id: memberId, username: `st-inflight-${rand(3)}` }]);
    const { createInvite, acceptInvite } = await import('@/core/spaces/invites');
    await acceptInvite({ userId: memberId }, (await createInvite({ userId: ownerId }, spaceId, { role: 'editor' })).token);
    const sessionId = await spaceSession(memberId);
    const worker = await spaceWorker(memberId, sessionId);
    let started!: () => void;
    const inTool = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let childSpawn: Promise<unknown> | undefined;
    worker.registerTool({ name: 'long_step', description: '', parameters: { type: 'object' }, execute: async () => {
      started();
      await gate;
      // The turn reaches for a child after the removal.
      const { inheritScope } = await import('./context');
      childSpawn = getAgentManager().spawn({ sessionId, userId: memberId, ...inheritScope(worker.getContext()), model: 'test-model', topic: 'general' });
      childSpawn.catch(() => undefined);
      return 'done';
    } });
    let calls = 0;
    scriptModel(worker, async () => (calls++ === 0 ? completion('', [{ id: 'l1', name: 'long_step', arguments: {} }]) : completion('Finished.')));
    const run = worker.run('Do the long step');
    await inTool;
    expect(worker.getStatus()).toBe('running');
    await removeMember({ userId: ownerId }, spaceId, memberId);
    expect(worker.getStatus()).toBe('stopped');
    release();
    await run.catch(() => undefined);
    await vi.waitFor(() => expect(childSpawn).toBeDefined());
    await expect(childSpawn).rejects.toThrow(/no longer a member/);
    expect(worker.getStatus()).toBe('stopped');
  });

  test('an archived space runs no agent and decides no tool call', async () => {
    const { archiveSpace, unarchiveSpace } = await import('@/core/spaces/service');
    await archiveSpace({ userId: ownerId }, spaceId);
    try {
      const { getAgentService } = await import('./service');
      const before = fx.turns.length;
      const result = await getAgentService().handleMessage(editorSession, editorId, 'go', 'webchat');
      expect(fx.turns).toHaveLength(before);
      expect(result.response).toMatch(/archived/);
      const { routeApprovalFor } = await import('@/security/approval-route');
      const ctx = await spaceContext(editorId, editorSession, 'editor');
      expect(await routeApprovalFor(ctx, { toolId: 'notes', action: 'read', toolName: 'list_notes' }, { level: 'ALLOW' }))
        .toMatchObject({ route: 'deny', reason: 'this space is archived' });
      const res = await call('editor', 'POST', '/api/agents', { sessionId: editorSession, model: 'test-model' });
      expect(res.status).toBe(409);
    } finally {
      await unarchiveSpace({ userId: ownerId }, spaceId);
    }
  });
});
