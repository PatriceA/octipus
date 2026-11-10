/**
 * The host scopes `documents:write` and `agent:run` (docs/PLUGIN-PACKAGES.md#host-api),
 * end to end over HTTP through a package's egress proxy, as a package sends
 * them, with tokens minted as a call's would be.
 *
 * What must hold:
 * - `documents:write` creates a text document of the calling user, in the
 *   call's workspace (a space's role rules apply), recording the package and
 *   tool, at least at the level the call read; it updates only documents the
 *   same package created, within its maxProtection;
 * - `agent:run` starts the host's own worker as the user (unattended, its role's
 *   tools narrowed, its token budget set), answers a run id at once, and a
 *   later call reads its status and final text; only a write tool starts one;
 *   only the same package and user read it; a result above maxProtection is
 *   withheld; runs are bounded in flight, by the config, and stopped when the
 *   package's tokens are revoked; calls inside a run get no host token; its
 *   tokens count in the daily plugin allowance;
 * - every request is audited.
 *
 * Backed by ephemeral PGlite; the agent service is a stub (the worker itself is tested elsewhere).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { RunningServer } from '@/api/http';
import type { AgentContext } from '@/core/types';
import type { HostTokenGrant } from './host-api';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'silent';
process.env.WORKSPACE_PATH ??= mkdtempSync(join(tmpdir(), 'octipus-host-scopes-ws-'));

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', username: 'admin' };
const MEMBER = { id: '22222222-2222-4222-8222-222222222222', username: 'member' };

interface Spawned { role: string; task: string; parent: AgentContext; overrides: Record<string, any>; finish: (value: unknown) => void; fail: (err: Error) => void }
const fixture = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  stopped: [] as string[],
}));

vi.mock('@/core/agent', () => ({
  getAgentService: () => ({
    spawnWorker: (role: string, task: string, _input: string, parent: AgentContext, overrides: Record<string, any>) => new Promise((resolve, reject) => {
      const id = `worker-${fixture.spawned.length}`;
      overrides.onWorkerSpawned?.(id);
      fixture.spawned.push({ role, task, parent, overrides, finish: resolve, fail: reject });
    }),
  }),
}));
vi.mock('@/core/agent-manager', () => ({
  getAgentManager: () => ({
    stop: (id: string) => {
      fixture.stopped.push(id);
      fixture.spawned[Number(id.split('-')[1])]?.fail(new Error('stopped'));
      return true;
    },
  }),
}));

let server: RunningServer;
const proxies = new Map<string, import('@/security/egress-proxy').EgressProxy>();

/** A request to the host API through `plugin`'s egress proxy, as a package sends it. */
async function hostApi(method: string, path: string, token: string, plugin: string, body?: unknown): Promise<{ status: number; body: any }> {
  const { startEgressProxy } = await import('@/security/egress-proxy');
  let proxy = proxies.get(plugin);
  if (!proxy) {
    proxy = await startEgressProxy({ label: plugin, allowed: [], hostApi: { host: '127.0.0.1', port: server.port } });
    proxies.set(plugin, proxy);
  }
  const { request } = await import('node:http');
  const port = proxy.port;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, path: `http://octipus-host.internal/api/plugin-host${path}`, method,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let parsed: unknown = null; try { parsed = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** A token as a call of `tool` (with `effect`) of `plugin` would carry. */
async function token(plugin: string, scopes: HostTokenGrant['scopes'], over: Partial<HostTokenGrant> = {}): Promise<string> {
  const { mintHostToken } = await import('./host-api');
  return mintHostToken({
    plugin, userId: ADMIN.id, workspaceId: null, sessionId: `sess-${rand(4)}`, scopes, maxProtection: 1, tool: 'some_tool', effect: 'write', ...over,
  }, 30_000).token;
}

async function hostAudit(op: string): Promise<Array<{ action: string; details: Record<string, any> }>> {
  const { queryRaw } = await import('@/db/postgres');
  const { rows } = await queryRaw(`SELECT action, details FROM audit_log WHERE resource_type = 'plugin_host' ORDER BY created_at`);
  return rows
    .map((r: { action: string; details: unknown }) => ({ action: r.action, details: (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, any> }))
    .filter((r: { details: Record<string, any> }) => r.details.op === op);
}

const settle = () => new Promise((r) => setTimeout(r, 30));

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (done(v)) return v;
    await settle();
  }
  throw new Error('timed out');
}

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-host-scopes-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${ADMIN.id}', 'admin', true), ('${MEMBER.id}', 'member', false) ON CONFLICT DO NOTHING`);
  const { App, listen } = await import('@/api/http');
  const { pluginHostRoutes } = await import('@/api/routes/plugin-host');
  server = listen(new App({ prefix: '/api' }).use(pluginHostRoutes), { hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  for (const proxy of proxies.values()) await proxy.close();
  server?.stop(true);
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('documents:write', () => {
  const P = 'doc-plugin';

  test('creates a text document of the calling user, recording the package and tool, at the level the call read', async () => {
    const t = await token(P, ['documents:write'], { tool: 'save_report' });
    const made = await hostApi('POST', '/documents', t, P, { name: 'Report: a/b?', content: '# Findings\n\nMilk is white.', category: 'Research' });
    expect(made).toMatchObject({ status: 200, body: { name: 'Report a b.md', protectionLevel: 1 } });
    const { queryRaw } = await import('@/db/postgres');
    const [row] = (await queryRaw(`SELECT * FROM documents WHERE id = $1`, [made.body.id])).rows;
    expect(row).toMatchObject({ user_id: ADMIN.id, original_name: 'Report a b.md', mime_type: 'text/markdown', category: 'Research', status: 'completed', protection_level: 1, ocr_text: '# Findings\n\nMilk is white.' });
    const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    expect(metadata).toEqual({ source: 'plugin', sourceRef: { plugin: P, tool: 'save_report' } });
    expect(row.storage_path).toContain(`plugin-${P}`);
    expect(readFileSync(row.storage_path, 'utf8')).toBe('# Findings\n\nMilk is white.');
    expect((await hostAudit('documents.create')).at(-1)).toMatchObject({ action: 'tool_executed', details: { scope: 'documents:write', documentId: made.body.id, tool: 'save_report' } });

    // What the call read is in it: the document is at least at that level; asked, higher.
    const read2 = await token(P, ['documents:write'], { readLevel: 2, maxProtection: 3 });
    expect((await hostApi('POST', '/documents', read2, P, { name: 'r', content: 'x' })).body.protectionLevel).toBe(2);
    expect((await hostApi('POST', '/documents', t, P, { name: 'r', content: 'x', protectionLevel: 3, mimeType: 'text/plain' })).body).toMatchObject({ protectionLevel: 3, name: 'r.txt' });
  });

  test('a token without the scope, or a body over the caps, writes nothing', async () => {
    expect(await hostApi('POST', '/documents', await token(P, ['documents:read']), P, { name: 'n', content: 'x' })).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    expect((await hostApi('POST', '/documents', await token(P, ['documents:write']), P, { name: 'n', content: 'x'.repeat(500_001) })).status).toBe(422);
    expect((await hostApi('POST', '/documents', await token(P, ['documents:write']), P, { name: 'n', content: 'x', mimeType: 'text/html' })).status).toBe(422);
  });

  test('updates only a document the same package created, within its maxProtection; the level only rises', async () => {
    const t = await token(P, ['documents:write', 'documents:read']);
    const made = (await hostApi('POST', '/documents', t, P, { name: 'Draft', content: 'first' })).body;
    const updated = await hostApi('PUT', `/documents/${made.id}`, t, P, { content: 'second', name: 'Final' });
    expect(updated).toMatchObject({ status: 200, body: { id: made.id, name: 'Final.md', protectionLevel: 1, size: 6 } });
    const { queryRaw } = await import('@/db/postgres');
    const [row] = (await queryRaw(`SELECT original_name, ocr_text, storage_path, protection_level FROM documents WHERE id = $1`, [made.id])).rows;
    expect(row).toMatchObject({ original_name: 'Final.md', ocr_text: 'second', protection_level: 1 });
    expect(readFileSync(row.storage_path, 'utf8')).toBe('second');
    expect((await hostApi('GET', `/documents/${made.id}`, t, P)).body).toMatchObject({ text: 'second' });

    // Another package's document, an upload of the user's, another user's, one above maxProtection.
    expect(await hostApi('PUT', `/documents/${made.id}`, await token('other-doc-plugin', ['documents:write']), 'other-doc-plugin', { content: 'x' }))
      .toMatchObject({ status: 403, body: { code: 'not_created_by_plugin' } });
    const upload = (await queryRaw(`INSERT INTO documents (user_id, filename, original_name, mime_type, size, status, storage_path, protection_level, ocr_text)
      VALUES ($1, 'u.txt', 'u.txt', 'text/plain', 1, 'completed', '/nowhere', 1, 'mine') RETURNING id`, [ADMIN.id])).rows[0].id;
    expect(await hostApi('PUT', `/documents/${upload}`, t, P, { content: 'x' })).toMatchObject({ status: 403, body: { code: 'not_created_by_plugin' } });
    expect(await hostApi('PUT', `/documents/${made.id}`, await token(P, ['documents:write'], { userId: MEMBER.id }), P, { content: 'x' }))
      .toMatchObject({ status: 404, body: { code: 'not_found' } });
    const high = (await hostApi('POST', '/documents', t, P, { name: 'Secret', content: 's', protectionLevel: 2 })).body;
    expect(await hostApi('PUT', `/documents/${high.id}`, t, P, { content: 'x' })).toMatchObject({ status: 403, body: { code: 'protection_level' } });
    expect((await queryRaw(`SELECT ocr_text FROM documents WHERE id = $1`, [high.id])).rows[0].ocr_text).toBe('s');
    // A call that read level 2 raises the document it updates.
    const raised = await hostApi('PUT', `/documents/${made.id}`, await token(P, ['documents:write'], { readLevel: 2, maxProtection: 2 }), P, { content: 'third' });
    expect(raised.body.protectionLevel).toBe(2);
    expect((await hostAudit('documents.update')).map((a) => a.details.status)).toEqual([200, 403, 403, 404, 403, 200]);
  });

  test('in a space, the member\'s role decides: an editor writes there, a viewer cannot', async () => {
    const { createSpace } = await import('@/core/spaces/service');
    const space = await createSpace({ userId: ADMIN.id }, { name: `Docs ${rand(3)}` });
    const { queryRaw } = await import('@/db/postgres');
    await queryRaw(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`, [space.id, MEMBER.id]);
    const owner = await hostApi('POST', '/documents', await token(P, ['documents:write'], { workspaceId: space.id }), P, { name: 'Team notes', content: 'shared' });
    expect(owner.status).toBe(200);
    const [row] = (await queryRaw(`SELECT workspace_id, storage_path FROM documents WHERE id = $1`, [owner.body.id])).rows;
    expect(row.workspace_id).toBe(space.id);
    expect(existsSync(row.storage_path)).toBe(true);
    const viewer = await hostApi('POST', '/documents', await token(P, ['documents:write'], { userId: MEMBER.id, workspaceId: space.id }), P, { name: 'x', content: 'x' });
    expect(viewer.status).toBe(403);
  });
});

describe('agent:run', () => {
  test('starts the host\'s own worker as the user, answers at once, and a later call reads the result', async () => {
    const P = 'run-plugin';
    fixture.spawned.length = 0;
    const started = await hostApi('POST', '/agent/runs', await token(P, ['agent:run'], { tool: 'start_research' }), P, { prompt: 'Is milk white? Cite sources.', title: 'Milk' });
    expect(started).toMatchObject({ status: 202, body: { status: 'running', role: 'research' } });
    const id = started.body.id as string;
    await waitFor(async () => fixture.spawned.length, (n) => n === 1);
    const [w] = fixture.spawned;
    expect(w.role).toBe('research');
    expect(w.task).toBe('Is milk white? Cite sources.');
    expect(w.parent).toMatchObject({ userId: ADMIN.id, attended: false, trigger: 'user', role: 'research', root: false, funding: 'own' });
    const { PLUGIN_RUN_TOOL_IDS, DEFAULT_RUN_TOKENS } = await import('./host-agent');
    expect(w.overrides.toolIds.length).toBeGreaterThan(0);
    for (const tool of w.overrides.toolIds) expect(PLUGIN_RUN_TOOL_IDS).toContain(tool);
    expect(w.overrides.toolIds).not.toContain('filesystem');
    expect(w.overrides.toolIds).not.toContain('mcp');
    // The list is final: no test-container tools are appended to it.
    expect(w.overrides.exactTools).toBe(true);
    expect(w.overrides.maxTokenBudget).toBe(DEFAULT_RUN_TOKENS);
    // The run has a session of its own, owned by the user; calls inside it get no host token.
    const { queryRaw } = await import('@/db/postgres');
    const [session] = (await queryRaw(`SELECT user_id, channel_type, channel_id, kind FROM sessions WHERE id = $1`, [w.parent.sessionId])).rows;
    expect(session).toEqual({ user_id: ADMIN.id, channel_type: 'plugin-run', channel_id: P, kind: 'automation' });
    const { isPluginRunSession } = await import('./host-api');
    expect(isPluginRunSession(w.parent.sessionId)).toBe(true);
    const [job] = (await queryRaw(`SELECT kind, status, user_id, title, payload FROM background_jobs WHERE id = $1`, [id])).rows;
    expect(job).toMatchObject({ kind: 'agent', status: 'running', user_id: ADMIN.id, title: 'Milk' });
    expect(typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload).toEqual({ plugin: P, tool: 'start_research', role: 'research', sessionId: w.parent.sessionId });

    // A read tool reads the run.
    const read = await token(P, ['agent:run'], { effect: 'read', tool: 'research_status' });
    expect((await hostApi('GET', `/agent/runs/${id}`, read, P)).body).toMatchObject({ id, status: 'running', output: null, title: 'Milk', role: 'research' });
    w.overrides.onTokens(1234);
    w.finish('# Milk\n\nIt is white [1].\n\n1. https://example.com/milk');
    const done = await waitFor(() => hostApi('GET', `/agent/runs/${id}`, read, P), (r) => r.body.status !== 'running');
    expect(done.body).toMatchObject({ status: 'done', output: '# Milk\n\nIt is white [1].\n\n1. https://example.com/milk', tokens: 1234, error: null });
    expect(isPluginRunSession(w.parent.sessionId)).toBe(false);

    // Its model calls count in the daily plugin allowance.
    const { pluginTokensToday } = await import('./host-model');
    const before = await pluginTokensToday(ADMIN.id);
    await queryRaw(`INSERT INTO cost_log (user_id, session_id, model_name, input_tokens, output_tokens, total_cost) VALUES ($1, $2, 'm', 100, 20, 0)`, [ADMIN.id, w.parent.sessionId]);
    expect(await pluginTokensToday(ADMIN.id)).toBe(before + 120);

    expect((await hostAudit('agent.start')).at(-1)).toMatchObject({ action: 'tool_executed', details: { scope: 'agent:run', status: 202, runId: id, tool: 'start_research' } });
    expect((await hostAudit('agent.read')).at(-1)).toMatchObject({ action: 'tool_executed', details: { runId: id, tool: 'research_status' } });
  });

  test('only a write tool starts a run; only the same package and user read it', async () => {
    const P = 'run-plugin-b';
    expect(await hostApi('POST', '/agent/runs', await token(P, ['agent:run'], { effect: 'read' }), P, { prompt: 'x' })).toMatchObject({ status: 403, body: { code: 'read_tool' } });
    expect(await hostApi('POST', '/agent/runs', await token(P, ['documents:write']), P, { prompt: 'x' })).toMatchObject({ status: 403, body: { code: 'scope_missing' } });
    const id = (await hostApi('POST', '/agent/runs', await token(P, ['agent:run']), P, { prompt: 'x' })).body.id;
    expect((await hostApi('GET', `/agent/runs/${id}`, await token(P, ['agent:run']), P)).status).toBe(200);
    expect(await hostApi('GET', `/agent/runs/${id}`, await token('run-plugin-c', ['agent:run']), 'run-plugin-c')).toMatchObject({ status: 404, body: { code: 'not_found' } });
    expect((await hostApi('GET', `/agent/runs/${id}`, await token(P, ['agent:run'], { userId: MEMBER.id }), P)).status).toBe(404);
    expect((await hostApi('GET', '/agent/runs/not-a-run', await token(P, ['agent:run']), P)).status).toBe(404);
    fixture.spawned.at(-1)?.finish('ok');
  });

  test('a role must be one of the host\'s, never the root, with tools a run may hold', async () => {
    const P = 'run-plugin-roles';
    expect(await hostApi('POST', '/agent/runs', await token(P, ['agent:run']), P, { prompt: 'x', role: 'general' })).toMatchObject({ status: 400, body: { code: 'role' } });
    expect(await hostApi('POST', '/agent/runs', await token(P, ['agent:run']), P, { prompt: 'x', role: 'nope' })).toMatchObject({ status: 400, body: { code: 'role' } });
    // A role whose tools are all outside the run's set (design: browser, filesystem).
    expect(await hostApi('POST', '/agent/runs', await token(P, ['agent:run']), P, { prompt: 'x', role: 'design' })).toMatchObject({ status: 400, body: { code: 'role' } });
  });

  test('a result above the package\'s maxProtection is withheld; a failed run says why', async () => {
    const P = 'run-plugin-level';
    fixture.spawned.length = 0;
    const id = (await hostApi('POST', '/agent/runs', await token(P, ['agent:run']), P, { prompt: 'Read my private notes' })).body.id;
    await waitFor(async () => fixture.spawned.length, (n) => n === 1);
    const { raiseSessionLevel, sessionProtectionLevel } = await import('@/core/protection/session-level');
    raiseSessionLevel(fixture.spawned[0].parent.sessionId, 3);
    fixture.spawned[0].finish('Your salary is …');
    const callerSession = `sess-${rand(4)}`;
    const read = await token(P, ['agent:run'], { sessionId: callerSession });
    const done = await waitFor(() => hostApi('GET', `/agent/runs/${id}`, read, P), (r) => r.body.status !== 'running');
    expect(done.body).toMatchObject({ status: 'done', output: null, withheld: { protectionLevel: 3 } });
    expect(sessionProtectionLevel(callerSession)).toBe(1);
    // Allowed to see level 3, it gets the text, and the calling session learns its level.
    const wide = await hostApi('GET', `/agent/runs/${id}`, await token(P, ['agent:run'], { maxProtection: 3, sessionId: callerSession }), P);
    expect(wide.body.output).toBe('Your salary is …');
    expect(sessionProtectionLevel(callerSession)).toBe(3);

    const failed = (await hostApi('POST', '/agent/runs', await token(P, ['agent:run']), P, { prompt: 'x' })).body.id;
    await waitFor(async () => fixture.spawned.length, (n) => n === 2);
    fixture.spawned[1].finish({ error: 'No model configured. Please add one in the Models page.' });
    const out = await waitFor(() => hostApi('GET', `/agent/runs/${failed}`, read, P), (r) => r.body.status !== 'running');
    expect(out.body).toMatchObject({ status: 'error', output: null, error: 'No model configured. Please add one in the Models page.' });
  });

  test('bounded: runs in flight per package and user, starts per hour, the config; revoking the package stops its runs', async () => {
    const P = 'run-plugin-bounds';
    fixture.spawned.length = 0;
    fixture.stopped.length = 0;
    const start = async () => hostApi('POST', '/agent/runs', await token(P, ['agent:run']), P, { prompt: 'long' });
    const a = (await start()).body.id;
    const b = (await start()).body.id;
    expect(await start()).toMatchObject({ status: 429, body: { code: 'too_many_runs' } });
    // Another user is not held by this one's runs.
    expect((await hostApi('POST', '/agent/runs', await token(P, ['agent:run'], { userId: MEMBER.id }), P, { prompt: 'x' })).status).toBe(202);
    await waitFor(async () => fixture.spawned.length, (n) => n === 3);

    const { revokePluginTokens } = await import('./host-api');
    revokePluginTokens(P);
    expect(fixture.stopped).toHaveLength(3);
    const read = await token(P, ['agent:run']);
    for (const id of [a, b]) {
      const r = await waitFor(() => hostApi('GET', `/agent/runs/${id}`, read, P), (x) => x.body.status !== 'running');
      expect(r.body).toMatchObject({ status: 'error', error: expect.stringContaining('disabled, upgraded or removed') });
    }
    // The hour's burst: the third start of a fresh package goes, the fourth waits.
    const Q = 'run-plugin-rate';
    const startQ = async () => hostApi('POST', '/agent/runs', await token(Q, ['agent:run']), Q, { prompt: 'x' });
    expect((await startQ()).status).toBe(202);
    expect((await startQ()).status).toBe(202);
    await waitFor(async () => fixture.spawned.length, (n) => n === 5);
    for (const w of fixture.spawned.slice(3)) w.finish('ok');
    await settle();
    expect((await startQ()).status).toBe(202);
    await waitFor(async () => fixture.spawned.length, (n) => n === 6);
    fixture.spawned[5].finish('ok');
    await settle();
    expect(await startQ()).toMatchObject({ status: 429, body: { code: 'rate_limited' } });

    // 0 turns runs off.
    const { getConfig } = await import('@/config');
    const plugins = getConfig().plugins as { hostAgentRunTokens: number };
    const saved = plugins.hostAgentRunTokens;
    plugins.hostAgentRunTokens = 0;
    try {
      expect(await hostApi('POST', '/agent/runs', await token('run-plugin-off', ['agent:run']), 'run-plugin-off', { prompt: 'x' })).toMatchObject({ status: 403, body: { code: 'agent_off' } });
    } finally {
      plugins.hostAgentRunTokens = saved;
    }
  });

  test('not in a space', async () => {
    const { createSpace } = await import('@/core/spaces/service');
    const space = await createSpace({ userId: ADMIN.id }, { name: `Runs ${rand(3)}` });
    expect(await hostApi('POST', '/agent/runs', await token('run-plugin-space', ['agent:run'], { workspaceId: space.id }), 'run-plugin-space', { prompt: 'x' }))
      .toMatchObject({ status: 409, body: { code: 'space' } });
  });
});
