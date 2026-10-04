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
 *     (source-shape), and `routeApproval(` is called only by
 *     `routeApprovalFor`;
 *   - a member's private space session runs with the space scope; a viewer
 *     cannot run the agent (turn and `POST /api/agents`), a stranger gets 404;
 *   - the role cap holds on all six approval paths and for a CLI model;
 *   - personal memories are not loaded in a space turn (children included),
 *     and the requester's profile stays out;
 *   - I6: after a private read, a write into the space asks — the flow
 *     guard switched off — on the base-tool and MCP paths;
 *   - a removed member's running agent stops and their next turn fails; an
 *     archived space runs no agent;
 *   - cost rows of the turn carry the space and its funding, install-topic
 *     calls `install`;
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
}));

vi.mock('@/models/model-registry', () => ({
  getModelRegistry: () => ({
    getDefaultModel: async () => ({ modelId: 'test-model' }),
    getAllModels: async () => [],
    getModelForTopic: async () => null,
    getModelByModelId: async () => null,
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

describe('one place builds agent contexts, one function decides tool calls', () => {
  test('no AgentContext literal is hand-built outside context.ts', () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith(join('core', 'agent', 'context.ts')))
      .filter((f) => /:\s*(import\([^)]*\)\.)?AgentContext\s*=\s*\{/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders, 'build the context with buildAgentContext (src/core/agent/context.ts)').toEqual([]);
  });

  test('every agentManager.spawn passes a space scope', () => {
    const calls: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const src = readFileSync(f, 'utf8');
      for (let i = src.indexOf('agentManager.spawn({'); i >= 0; i = src.indexOf('agentManager.spawn({', i + 1)) {
        let depth = 0;
        let j = src.indexOf('(', i);
        for (; j < src.length; j++) {
          if ('([{'.includes(src[j])) depth++;
          else if (')]}'.includes(src[j]) && --depth === 0) break;
        }
        calls.push(`${relative(SRC, f)}: ${src.slice(i, j)}`);
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
    const { authorizeMcpDispatch } = await import('@/security/mcp-authorization');
    await expect(authorizeMcpDispatch(ctx, 'tracker.create_issue', {})).rejects.toBeInstanceOf(ApprovalBlockedError);

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
