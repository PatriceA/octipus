import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, test, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import type { Session } from '@/db/schema/sessions';
const mock = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), owner: vi.fn(), latest: vi.fn(), tool: vi.fn(), kill: vi.fn(), row: vi.fn(), servers: vi.fn(), museHome: vi.fn(), museDispose: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
vi.mock('@/utils/proc', () => ({ killProcessTree: mock.kill }));
vi.mock('@/models/providers/instrumented', () => ({ recordProviderUsage: vi.fn() }));
vi.mock('@/models/providers/cli-provider', () => ({ acquireCliSlot: async () => () => {}, execCli: mock.exec, windowsShellQuote: (s: string) => s, windowsShellQuoter: () => (s: string) => s }));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: { findById: mock.owner, findLatestRootForSession: mock.latest } }));
vi.mock('./cli-agent-factory', () => ({ getCLIToolConfig: mock.tool, resolveCliModelEntry: mock.row }));
vi.mock('./cli-adapters', () => ({ discoverCodexMcpServers: mock.servers, prepareMuseHome: mock.museHome, disposeMuseHome: mock.museDispose, museWorkspaceFor: () => '/muse-ws',
  mspLine: (id: number | undefined, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) }) + '\n' }));
vi.mock('./cli-executable', () => ({ configuredCliBinary: (binary: string) => binary }));
vi.mock('./cli-session-store', () => ({ isChildCliSessionKey: (key: string) => key.includes('::'), cliSessionKeyAdapter: (key: string) => key.split('@@')[0] }));
vi.mock('@/security/workspace-fs', () => ({ WorkspaceFS: { forSession: () => ({ root: '/session-workspace' }) }, sessionFsAccess: async () => ({ space: null }) }));
import { compactCliConversation, compactCodexThread, compactMuseSession, rootCliConversation } from './cli-compaction';
const record = { id: 'vendor-id', fingerprint: 'keep-this', generation: 'g', ownerAgentId: 'root', lastUsedAt: '2026-09-28' };
const session = () => ({ id: 'session', userId: 'user', context: { conversationGeneration: 'g', cliSessions: { 'Claude Code': { ...record } } } }) as unknown as Session;
beforeEach(() => {
  vi.clearAllMocks();
  mock.owner.mockResolvedValue({ sessionId: 'session', userId: 'user', model: 'claude-model' });
  mock.latest.mockResolvedValue({ id: 'root' });
  mock.tool.mockReturnValue({ name: 'Claude Code', binaryPath: 'claude', modelProvider: 'anthropic' });
  mock.row.mockResolvedValue({ metadata: {} });
  mock.servers.mockResolvedValue([]);
  mock.museHome.mockResolvedValue('/muse-home');
});
/** A fake `muse serve`: what Octipus writes to it, and a way to answer. */
function fakeServe() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined });
  mock.spawn.mockReturnValue(child);
  const sent: any[] = [];
  child.stdin.on('data', (bytes: Buffer) => sent.push(...bytes.toString().trim().split('\n').map(line => JSON.parse(line))));
  // serve exits once its input ends.
  child.stdin.on('finish', () => child.emit('close', 0, null));
  return { child, sent, emit: (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n') };
}
test('Claude compact resumes exact vendor ID and never mutates its record', async () => {
  const state = session();
  const before = JSON.stringify(state);
  mock.exec.mockResolvedValue(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: record.id }));
  expect(await compactCliConversation(state, 'keep tests', 'user')).toContain('same CLI session');
  const [, args, options] = mock.exec.mock.calls[0];
  expect(args).toContain('--resume');
  expect(args[args.indexOf('--resume') + 1]).toBe(record.id);
  expect(options.stdin).toBe('/compact keep tests');
  expect(args).not.toContain('--fork-session');
  expect(JSON.stringify(state)).toBe(before);
});
test('Claude compact runs on the model the conversation runs on', async () => {
  mock.exec.mockResolvedValue(JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: record.id }));
  mock.row.mockResolvedValue({ metadata: { cliAgent: { model: 'opus' } } });
  await compactCliConversation(session(), '', 'user');
  let [, args] = mock.exec.mock.calls[0];
  expect(args[args.indexOf('--model') + 1]).toBe('opus');
  // Unset on the row: the CLI's own default, as for the agent run.
  mock.row.mockResolvedValue({ metadata: {} });
  await compactCliConversation(session(), '', 'user');
  [, args] = mock.exec.mock.calls[1];
  expect(args).not.toContain('--model');
});
test('Muse Code resumes the exact session, compacts it, and waits for the compaction item, not the ack', async () => {
  const { sent, emit } = fakeServe();
  const running = compactMuseSession('muse', { cwd: '/project', env: {}, sessionId: 'sid' });
  let done = false;
  running.then(() => { done = true; });
  await vi.waitFor(() => expect(sent.map(m => m.method)).toEqual(['initialize', 'initialized', 'session/resume']));
  expect(sent[2].params).toMatchObject({ sessionId: 'sid', excludeItems: true });
  emit({ id: 1, result: {} });
  emit({ id: 2, result: { session: { sessionId: 'sid' } } });
  await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ id: 3, method: 'session/compact', params: { sessionId: 'sid' } }));
  emit({ id: 3, result: { status: 'accepted' } });
  // Trimmed from a live run (1.4.20): the compaction item, at its start and end.
  emit({ method: 'item/started', params: { sessionId: 'sid', item: { kind: 'compaction', status: 'inProgress', tokensBefore: 15384, trigger: 'manual' } } });
  await Promise.resolve();
  expect(done).toBe(false);
  emit({ method: 'item/completed', params: { sessionId: 'sid', item: { kind: 'compaction', outcome: 'compacted', status: 'completed', strategyId: 'summary-preserved-suffix/v1', tokensBefore: 15384, tokensAfter: 18988, trigger: 'manual' } } });
  expect(await running).toBeUndefined();
  expect(mock.spawn.mock.calls[0][1]).toEqual(['serve', '--disable-request-user-input', '-c', 'run.reminder_roster=[]']);
  expect(mock.kill).toHaveBeenCalled();
});
test('Muse Code: nothing to compact is a noop; no context limit says why; a failed compaction keeps the session', async () => {
  let serve = fakeServe();
  let running = compactMuseSession('muse', { cwd: '/p', env: {}, sessionId: 'sid' });
  serve.emit({ id: 2, result: {} });
  await vi.waitFor(() => expect(serve.sent.at(-1)?.method).toBe('session/compact'));
  serve.emit({ id: 3, result: { status: 'noop', reason: 'no_compactable_history' } });
  expect(await running).toBe('no_compactable_history');

  serve = fakeServe();
  running = compactMuseSession('muse', { cwd: '/p', env: {}, sessionId: 'sid' });
  serve.emit({ id: 2, result: {} });
  // Live, 1.4.20, a host without the model's context limit.
  serve.emit({ id: 3, jsonrpc: '2.0', error: { code: -32030, data: { kind: 'commandRejected', reason: 'compaction_unavailable', retryable: false }, message: 'session/compact command x rejected: compaction_unavailable' } });
  await expect(running).rejects.toThrow(/knows no context limit for its model.*model catalog/);

  serve = fakeServe();
  running = compactMuseSession('muse', { cwd: '/p', env: {}, sessionId: 'sid' });
  serve.emit({ id: 2, result: {} });
  serve.emit({ id: 3, result: { status: 'accepted' } });
  serve.emit({ method: 'item/completed', params: { sessionId: 'sid', item: { kind: 'compaction', outcome: 'failed', reason: 'summarizer_failed' } } });
  await expect(running).rejects.toThrow('Muse Code compaction failed (summarizer_failed); session retained.');
});
test('Muse Code /compact runs in a tool-less config home, refuses focus instructions, and keeps its session record', async () => {
  const state = session();
  state.context!.cliSessions = { 'Muse Code': { ...record } };
  mock.tool.mockReturnValue({ name: 'Muse Code', binaryPath: 'muse', modelProvider: 'meta' });
  await expect(compactCliConversation(state, 'keep tests', 'user')).rejects.toThrow('does not accept focus instructions');
  const { emit, sent } = fakeServe();
  const running = compactCliConversation(state, '', 'user');
  await vi.waitFor(() => expect(sent.length).toBe(3));
  expect(mock.museHome).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/muse-ws', tools: [] }));
  expect(mock.spawn.mock.calls[0][2].env.XDG_CONFIG_HOME).toBe('/muse-home');
  expect(sent[2].params.sessionId).toBe(record.id);
  emit({ id: 2, result: {} });
  await vi.waitFor(() => expect(sent.at(-1)?.method).toBe('session/compact'));
  emit({ id: 3, result: { status: 'accepted' } });
  emit({ method: 'item/completed', params: { sessionId: record.id, item: { kind: 'compaction', outcome: 'compacted' } } });
  expect(await running).toBe('Muse Code conversation compacted. Continuing with the same CLI session.');
  expect(mock.museDispose).toHaveBeenCalledWith('/muse-home', expect.anything());
  expect(state.context!.cliSessions!['Muse Code']).toEqual(record);
});
test('ordinary CLI text or success without compaction is not accepted', async () => {
  mock.exec.mockResolvedValue(JSON.stringify({ type: 'result', result: 'Done', session_id: record.id }));
  await expect(compactCliConversation(session(), '', 'user')).rejects.toThrow('did not confirm');
});
test("a conversation on another member's personal model is never compacted with their login", async () => {
  mock.row.mockResolvedValue({ name: 'u/creator/sub', ownerUserId: 'creator', provider: 'cli', metadata: {} });
  await expect(compactCliConversation(session(), '', 'member')).rejects.toThrow("another member's personal model");
  expect(mock.exec).not.toHaveBeenCalled();
});
test('child and cleared vendor conversations are not compacted', async () => {
  const state = session();
  state.context!.cliSessions = { 'Claude Code::task': record, 'Claude Code': { ...record, generation: 'old' } };
  expect(await rootCliConversation(state)).toBeUndefined();
});
test('ten newer Codex roots without a saved thread never fall back to old Claude', async () => {
  mock.latest.mockResolvedValue({ id: 'codex-root-10', model: 'cli/codex' });
  expect(await compactCliConversation(session(), '', 'user')).toBeNull();
  expect(mock.exec).not.toHaveBeenCalled();
  expect(mock.spawn).not.toHaveBeenCalled();
});
test('a cold run cannot compact an older thread of the same adapter', async () => {
  mock.latest.mockResolvedValue({ id: 'new-claude-root', model: 'cli/claude' });
  expect(await rootCliConversation(session())).toBeUndefined();
});
test('latest root ownership wins over stale provider timestamps', async () => {
  const state = session();
  state.context!.cliSessions!['Claude Code'].lastUsedAt = '2030-01-01T00:00:00Z';
  state.context!.cliSessions!['Codex CLI'] = { ...record, ownerAgentId: 'codex-root', id: 'codex-thread' };
  mock.latest.mockResolvedValue({ id: 'codex-root', model: 'cli/codex' });
  expect(await rootCliConversation(state)).toEqual(['Codex CLI', expect.objectContaining({ id: 'codex-thread' })]);
});
test('missing root history does not authorize an arbitrary saved provider', async () => {
  mock.latest.mockResolvedValue(null);
  expect(await rootCliConversation(session())).toBeUndefined();
});
test('records predating clear are excluded even with a matching generation', async () => {
  const state = session();
  state.context!.clearedAt = '2026-10-01T00:00:00Z';
  expect(await rootCliConversation(state)).toBeUndefined();
});
test('Codex waits for the matching completed compaction turn, not the RPC acknowledgement', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined });
  mock.spawn.mockReturnValue(child);
  const sent: any[] = [];
  child.stdin.on('data', (bytes: Buffer) => sent.push(JSON.parse(bytes.toString())));
  const running = compactCodexThread('codex', ['app-server'], { cwd: '/project', env: {}, threadId: 'thread' });
  let done = false;
  running.then(() => { done = true; });
  const emit = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n');
  emit({ id: 1, result: {} });
  emit({ id: 2, result: { thread: { id: 'thread' } } });
  emit({ id: 3, result: {} });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(sent.some(message => message.method === 'thread/compact/start')).toBe(true);
  expect(sent.some(message => message.method === 'turn/start' || message.method === 'thread/start')).toBe(false);
  emit({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'compact' } } });
  emit({ method: 'item/completed', params: { threadId: 'thread', turnId: 'compact', item: { type: 'contextCompaction' } } });
  emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'compact', status: 'completed' } } });
  await running;
  expect(mock.kill).toHaveBeenCalled();
});

test('Codex compaction disables configured MCP servers with a single TOML table override', async () => {
  const state = session();
  state.context!.cliSessions = { 'Codex CLI': { ...record } };
  mock.tool.mockReturnValue({ name: 'Codex CLI', binaryPath: 'codex', modelProvider: 'openai' });
  mock.servers.mockResolvedValue([{ name: 'octipus' }, { name: 'project.server' }, { name: 'quoted"server' }]);
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined });
  mock.spawn.mockReturnValue(child);
  const running = compactCliConversation(state, '', 'user');
  const failed = expect(running).rejects.toThrow('exit 1');
  await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalled());
  const [, args] = mock.spawn.mock.calls[0];
  expect(args).toHaveLength(3);
  expect(args.slice(0, 2)).toEqual(['app-server', '-c']);
  expect(parseToml(args[2])).toEqual({ mcp_servers: {
    octipus: { enabled: false }, 'project.server': { enabled: false }, 'quoted"server': { enabled: false },
  } });
  child.emit('close', 1, null);
  await failed;
  expect(state.context!.cliSessions['Codex CLI'].id).toBe(record.id);
});
