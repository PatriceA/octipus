/** Production artifact acceptance: isolated storage, real HTTP API, scripted model boundary. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

const artifact = resolve('dist/index.js');
const root = await mkdtemp(join(tmpdir(), 'octi-acceptance-'));
const workspace = join(root, 'workspace');
await mkdir(workspace);
// The packaged server ships alongside migrations; stage them in the isolated install.
await cp(resolve('src/db/migrations'), join(root, 'src/db/migrations'), { recursive: true });
await cp(resolve('personas'), join(root, 'personas'), { recursive: true });
let modelCalls = 0;
let token = '';
let base = '';
let backend: ChildProcess | undefined;
const metrics: Array<{ scenario: string; passed: boolean; durationMs: number; modelCalls: number }> = [];

interface ModelMessage { role: string; content?: string; tool_calls?: unknown[] }
const provider = createServer(async (req, res) => {
  try {
    let body = ''; for await (const part of req) body += part;
    if (req.url?.includes('/models')) { res.end(JSON.stringify({ data: [{ id: 'acceptance-fixture' }] })); return; }
    const input = JSON.parse(body || '{}') as { messages?: ModelMessage[]; stream?: boolean };
    modelCalls++;
    const messages = input.messages ?? [];
    const lastUser = messages.findLastIndex(m => m.role === 'user' && m.content?.includes('ACCEPTANCE_WRITE'));
    const marker = lastUser >= 0 ? messages[lastUser].content?.match(/ACCEPTANCE_WRITE (\S+)/)?.[1] : undefined;
    const executed = lastUser >= 0 && messages.slice(lastUser + 1).some(m => m.role === 'tool');
    const call = marker && !executed ? { id: `call_${modelCalls}`, type: 'function', function: {
      name: 'filesystem__write_file', arguments: JSON.stringify({ path: marker, content: 'acceptance: 42\n' }),
    } } : undefined;
    const message = { role: 'assistant', content: call ? null : 'The fixture response is 42.', ...(call ? { tool_calls: [call] } : {}) };
    const envelope = { id: `fixture-${modelCalls}`, object: 'chat.completion', created: 1, model: 'acceptance-fixture',
      choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } };
    if (input.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content: message.content };
      res.end(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(envelope)); }
  } catch { res.statusCode = 500; res.end('fixture provider failed'); }
});
await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
const address = provider.address(); assert(address && typeof address !== 'string');
const portProbe = createServer(); await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const portAddress = portProbe.address(); assert(portAddress && typeof portAddress !== 'string');
const port = portAddress.port; await new Promise<void>(resolve => portProbe.close(() => resolve()));
base = `http://127.0.0.1:${port}/api`;
const env = { ...process.env, DATA_DIR: join(root, 'data'), STORAGE_MODE: 'embedded',
  API_PORT: String(port), API_HOST: '127.0.0.1', WORKSPACE_PATH: workspace, DOCUMENTS_PATH: join(root, 'documents'),
  MASTER_KEY: randomBytes(32).toString('hex'), JWT_SECRET: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex'),
  BOOTSTRAP_PROVIDER: 'custom-openai', BOOTSTRAP_MODEL: 'acceptance-fixture', BOOTSTRAP_API_KEY: 'fixture-only',
  BOOTSTRAP_BASE_URL: `http://127.0.0.1:${address.port}/v1`, LOG_LEVEL: 'warn' };
async function boot() {
  backend = spawn(process.execPath, [artifact], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(root, 'backend.log'), { flags: 'a' });
  backend.stdout?.pipe(log); backend.stderr?.pipe(log);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error(`Backend exited ${backend.exitCode}; see ${root}/backend.log`);
    try { if ((await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* booting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Backend readiness timed out; see ${root}/backend.log`);
}
async function stop() {
  if (!backend || backend.exitCode !== null) return;
  const exited = once(backend, 'exit'); backend.kill('SIGKILL'); await exited;
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const data = await response.json() as T & { error?: string };
  assert(response.ok && !data.error, `${method} ${path}: ${response.status} ${data.error ?? ''}`);
  return data;
}
async function scenario(name: string, run: () => Promise<void>) {
  const started = Date.now(); const before = modelCalls; let passed = false;
  try { await run(); passed = true; console.log(`PASS ${name}`); }
  finally { metrics.push({ scenario: name, passed, durationMs: Date.now() - started, modelCalls: modelCalls - before }); }
}
try {
  await boot();
  const login = await fetch(`${base}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'acceptance', password: 'AcceptanceFixture123!' }) });
  const auth = await login.json() as { token?: string; error?: string };
  token = auth.token ?? login.headers.get('set-cookie')?.match(/session_token=([^;]+)/)?.[1] ?? '';
  assert(login.ok && token, `Fixture registration failed: ${auth.error}`);
  await api('/models/' + encodeURIComponent('custom-openai acceptance-fixture'), 'PATCH', {
    supportsTools: true, supportsStreaming: true, contextWindow: 128000,
    metadata: { customProvider: { auth: { type: 'bearer' }, pathOverride: '/chat/completions' } },
  });
  const me = await api<{ id: string }>('/auth/me');
  const userWorkspace = join(workspace, 'users', me.id, 'workspaces', 'default', 'files', 'acceptance-project');
  await mkdir(userWorkspace, { recursive: true });
  // A real project marker prevents intentional loose-file session redirection.
  execFileSync('git', ['init', '--quiet', userWorkspace]);
  const session = await api<{ id: string }>('/sessions', 'POST', { title: 'Acceptance', channelType: 'api' });
  await scenario('one-model chat through production backend', async () => {
    const before = modelCalls;
    const result = await api<{ response: string }>('/chat', 'POST', { sessionId: session.id, message: 'Compute 6 times 7.' });
    assert(modelCalls > before); assert.match(result.response, /42/);
  });
  await scenario('write tool has independent filesystem evidence', async () => {
    const target = join(userWorkspace, 'fixture.txt'); const untouched = join(userWorkspace, 'untouched.txt');
    await writeFile(untouched, 'unchanged');
    await writeFile(target, 'acceptance: 0\n');
    execFileSync('git', ['-C', userWorkspace, 'add', 'fixture.txt', 'untouched.txt']);
    await api('/tools/permissions', 'PUT', { toolId: 'filesystem', action: 'write', level: 'ALLOW' });
    const before = modelCalls;
    const result = await api('/chat', 'POST', { sessionId: session.id, message: `Write the requested fixture. ACCEPTANCE_WRITE ${target}`, projectPath: userWorkspace });
    await writeFile(join(root, 'write-result.json'), JSON.stringify(result));
    assert(modelCalls > before); assert.equal(await readFile(target, 'utf8'), 'acceptance: 42\n');
    assert.equal(await readFile(untouched, 'utf8'), 'unchanged');
    const diff = execFileSync('git', ['-C', userWorkspace, 'diff', '--', 'fixture.txt'], { encoding: 'utf8' });
    assert.match(diff, /-acceptance: 0/); assert.match(diff, /\+acceptance: 42/);
    execFileSync('git', ['-C', userWorkspace, 'diff', '--exit-code', '--', 'untouched.txt']);
    await writeFile(join(root, 'verified.diff'), diff);
  });
  await scenario('direct API refuses unattended ASK without writing', async () => {
    await api('/tools/permissions', 'PUT', { toolId: 'filesystem', action: 'write', level: 'ASK' });
    const target = join(userWorkspace, 'forbidden.txt');
    const response = await fetch(`${base}/tools/filesystem/tools/write_file/execute`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ args: { path: target, content: 'forbidden' } }) });
    assert.equal(response.status, 409); assert.equal((await response.json() as { code: string }).code, 'approval_required');
    await assert.rejects(readFile(target), { code: 'ENOENT' });
  });
  await scenario('session messages survive a process restart', async () => {
    const before = await api<{ messages: unknown[] }>(`/sessions/${session.id}/messages`);
    assert(before.messages.length > 0); await stop(); await boot();
    // Login sessions are process-local; durable conversation recovery requires reauthentication.
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'acceptance', password: 'AcceptanceFixture123!' }) });
    const auth = await login.json() as { token?: string };
    token = auth.token ?? login.headers.get('set-cookie')?.match(/session_token=([^;]+)/)?.[1] ?? '';
    assert(login.ok && token);
    const after = await api<{ messages: unknown[] }>(`/sessions/${session.id}/messages`);
    assert.deepEqual(after.messages, before.messages);
  });
} finally {
  await stop(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
  const report = { provider: 'scripted OpenAI-compatible boundary', model: 'acceptance-fixture',
    artifact, evidence: 'production backend, real HTTP and filesystem/database', metrics, liveModelQuality: 'unmeasured' };
  const reportPath = process.env.ACCEPTANCE_REPORT ?? join(root, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Acceptance report: ${reportPath}`);
}
