import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@/config';
import { CLIArgumentBuilder, CLIOutputParser, disposeMuseHome, museAllowance, museProtocolStep, museSessionLogExists, museWorkspaceFor, prepareMuseHome } from '@/core/cli-adapters';
import { describeCliCapabilities } from '@/shared/cli-capabilities';
import { museCliConfig, parseMuseJsonl } from './cli-provider';

// Trimmed from live `muse exec --json` runs (Muse Code 1.4.18, 2026-11-13).
// Envelope fields other than payload_type/payload are dropped; ids shortened.
const jsonl = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const proposed = (taskId: string, taskKind: string) => ({ payload_type: 'task.lifecycle.proposed', payload: { event: { kind: 'proposed', task_id: taskId, task_kind: taskKind }, kind: 'task_lifecycle', task_id: taskId } });

const PONG = jsonl([
  { payload_type: 'run.model.configured', payload: { model_id: 'muse-spark-1.2', provider_id: 'meta', source: 'startup' } },
  proposed('m1', 'model.meta.response'),
  { payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: 'pong' } },
  { payload_type: 'run.usage', payload: { allowance: { weekly: { used_percent: 0 }, window: { used_percent: 1 } }, calls: 1, kind: 'run_usage', models: [{ cached_tokens: 0, calls: 1, input_tokens: 33031, model: 'muse-spark-1.2', output_tokens: 15, reasoning_tokens: 5 }] } },
  { payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', reason: null, terminal: 'completed', text: 'pong' } },
]);

// A bridged run (muse sees only `mcp__octipus__*` tools), live 2026-11-13.
const TOOLS = jsonl([
  { payload_type: 'run.lifecycle.started', payload: { kind: 'run_started', prompt: 'p' } },
  proposed('m1', 'model.meta.response'),
  proposed('t-secret', 'tool.mcp__octipus__secret_word'),
  { payload_type: 'tool.result', payload: { call_id: 'call_1', correlation_facts: { outcome: 'success', tool_name: 'mcp__octipus__secret_word' }, kind: 'tool_result', text: 'PLATYPUS-7' } },
  proposed('m2', 'model.meta.response'),
  proposed('t-write', 'tool.mcp__octipus__write_file'),
  { payload_type: 'tool.result', payload: { call_id: 'call_2', correlation_facts: { outcome: 'error', tool_name: 'mcp__octipus__write_file' }, kind: 'tool_result', text: 'denied' } },
  proposed('m3', 'model.meta.response'),
  { payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: 'done' } },
  { payload_type: 'run.usage', payload: { allowance: { as_of_ms: 1, source: 'stream', tier: null, weekly: { resets_at_ms: 1794787200000, used_percent: 7 }, window: { resets_at_ms: 1794599619000, used_percent: 22 } },
    calls: 3, kind: 'run_usage', models: [{ cached_tokens: 40808, calls: 3, input_tokens: 61685, model: 'muse-wonder-1.0', output_tokens: 654, reasoning_tokens: 421 }] } },
  { payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', reason: null, terminal: 'completed', text: 'done' } },
]);

describe('museCliConfig', () => {
  it('registers cli/muse as a streamed adapter with Octipus tools only and a file-prompt tool-less mode', () => {
    expect(museCliConfig.name).toBe('Muse Code');
    expect(museCliConfig.modelPatterns).toEqual(['cli/muse']);
    expect(museCliConfig.bufferOutput).toBeUndefined();
    expect(museCliConfig.toolBridge).toBe('mcp-only');
    // The CLI status panel looks the quota up under the kebab-cased name.
    expect(museCliConfig.quotaProvider).toBe('muse-code');
    expect(museCliConfig.promptVia).toBe('file');
    const args = museCliConfig.toolLessArgs!('/tmp/x/prompt.txt');
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--no-session-log', '--disable-reminders', '--no-foreign-personal-context']));
    expect(args.slice(-2)).toEqual(['--prompt-file', '/tmp/x/prompt.txt']);
    expect(() => museCliConfig.toolLessArgs!()).toThrow(/prompt file/);
    expect(museCliConfig.isQuotaError('This turn stopped because your usage limit was reached.')).toBe(true);
  });

  it('describes itself as Octipus-tools-only and says why spaces refuse it', () => {
    const text = describeCliCapabilities(museCliConfig);
    expect(text).toContain('Octipus tools only, via scoped MCP (no vendor-native tools)');
    expect(text).toContain('Not available in shared spaces or on personal models: it keeps one login');
  });

  it('parses the answer and folds cached tokens into input', () => {
    const r = parseMuseJsonl(TOOLS, Date.now());
    expect(r.content).toBe('done');
    expect(r.usage).toMatchObject({ inputTokens: 61685, outputTokens: 654, totalTokens: 62339, cacheReadTokens: 40808, available: true });
    expect(parseMuseJsonl(PONG, Date.now()).content).toBe('pong');
  });

  it('fails a run that did not complete, or never ended', () => {
    const failed = jsonl([{ payload_type: 'run.terminal.failed', payload: { terminal: 'failed', reason: 'model did not reach a terminal state within 4 step(s)', text: 'partial' } }]);
    expect(() => parseMuseJsonl(failed, Date.now())).toThrow(/failed: model did not reach/);
    expect(() => parseMuseJsonl('', Date.now())).toThrow(/no terminal event/);
  });
});

describe('museAllowance', () => {
  it('reports the fuller window and its reset; at a tie the later reset', () => {
    expect(museAllowance({ window: { used_percent: 22, resets_at_ms: 10 }, weekly: { used_percent: 7, resets_at_ms: 20 } })).toEqual({ usedPercent: 22, resetsAt: new Date(10) });
    expect(museAllowance({ window: { used_percent: 100, resets_at_ms: 10 }, weekly: { used_percent: 100, resets_at_ms: 20 } })).toEqual({ usedPercent: 100, resetsAt: new Date(20) });
    expect(museAllowance(null)).toBeNull();
    expect(museAllowance({ window: null })).toBeNull();
    // MSP `usage/changed` spells the same members camelCase.
    expect(museAllowance({ weekly: { resetsAtMs: 1794787200000, usedPercent: 16 }, window: { resetsAtMs: 1794691816000, usedPercent: 8, windowDurationMins: 300 } }))
      .toEqual({ usedPercent: 16, resetsAt: new Date(1794787200000) });
  });
});

// Trimmed from a live `muse serve` run with the Octipus bridge (Muse Code
// 1.4.20, 2026-11-14): read_file, write_file, then the answer. Envelope
// members the parser ignores (sourceRange, viewCursor, ids…) are dropped.
const msp = (method: string, params: object = {}) => ({ jsonrpc: '2.0', method, params });
const item = (method: string, fields: object) => msp(method, { item: fields });
const usage = (inputTokens: number, cachedTokens: number, outputTokens: number) => msp('session/tokenUsage', { usage: { cacheReadTokens: cachedTokens, cacheWriteTokens: 0, cachedTokens, inputTokens, outputTokens, reasoningTokens: 0 } });
const SERVE_RUN = [
  { id: 1, jsonrpc: '2.0', result: {} },
  { id: 2, jsonrpc: '2.0', result: { session: { kind: 'root', providerId: 'meta', status: 'idle', turnCount: 0 } } },
  { id: 3, jsonrpc: '2.0', result: { disposition: 'started', startedNewTurn: true, status: 'accepted' } },
  msp('turn/started'),
  item('item/completed', { itemId: 'u1', kind: 'userMessage', status: 'completed', text: 'Use read_file…' }),
  msp('turn/modelAttemptStarted'),
  usage(15585, 0, 182),
  item('item/started', { args: '{"path":"hello.txt"}', itemId: 't-read', kind: 'toolCall', status: 'inProgress', tool: 'mcp__octipus__read_file' }),
  item('item/completed', { args: '{"path":"hello.txt"}', itemId: 't-read', kind: 'toolCall', status: 'completed', tool: 'mcp__octipus__read_file', visibleOutput: 'kumquat-42\n' }),
  msp('turn/modelAttemptStarted'),
  usage(15815, 0, 102),
  item('item/started', { itemId: 't-write', kind: 'toolCall', status: 'inProgress', tool: 'mcp__octipus__write_file' }),
  item('item/completed', { itemId: 't-write', kind: 'toolCall', status: 'failed', tool: 'mcp__octipus__write_file', failureReason: 'denied' }),
  msp('turn/modelAttemptStarted'),
  item('item/started', { itemId: 'a1', kind: 'agentMessage', messagePhase: 'finalAnswer', status: 'inProgress', text: '' }),
  msp('item/delta', { delta: 'kumquat-42', field: 'text', itemId: 'a1' }),
  item('item/completed', { itemId: 'a1', kind: 'agentMessage', messagePhase: 'finalAnswer', status: 'completed', text: 'kumquat-42' }),
  usage(15952, 15729, 34),
  msp('session/contextUsage', { pressure: 'normal', usedTokens: 16222, windowTokens: 1007997 }),
  msp('usage/changed', { weekly: { resetsAtMs: 1794787200000, usedPercent: 16 }, window: { resetsAtMs: 1794691816000, usedPercent: 8, windowDurationMins: 300 } }),
  msp('turn/completed', { terminal: 'completed' }),
];

describe('CLIOutputParser (Muse Code, muse serve)', () => {
  const run = (messages: object[]) => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const callbacks = { onTurn: vi.fn(), onToolCall: vi.fn(), onTokenUsage: vi.fn(), onRunError: vi.fn(), onCommentary: vi.fn(),
      onSessionInit: vi.fn(), onVendorReply: vi.fn(), onAllowance: vi.fn(), isBridgedTool: (name: string) => name.startsWith('mcp__octipus__') };
    const parser = new CLIOutputParser('a', 'cli/muse', (type, data) => events.push({ type, data: data as Record<string, unknown> }), callbacks, '/w');
    let text = '';
    for (const message of messages) {
      const r = parser.parse(JSON.parse(JSON.stringify(message)), 'Muse Code');
      if (r) text = r.replace ? r.text : text + r.text;
    }
    return { events, callbacks, text };
  };

  it('emits paired bridge tool rows, turns, per-call usage, allowance, session and reply signals, and the answer', () => {
    const { events, callbacks, text } = run(SERVE_RUN);
    const actions = events.filter(e => e.type === 'action').map(e => e.data);
    expect(actions.filter(a => a.type === 'cli_tool_use').map(a => [a.id, a.toolName])).toEqual([['t-read', 'mcp__octipus__read_file'], ['t-write', 'mcp__octipus__write_file']]);
    expect(actions.filter(a => a.type === 'cli_tool_result').map(a => [a.id, a.output, a.isError])).toEqual([['t-read', 'kumquat-42\n', false], ['t-write', 'denied', true]]);
    expect(callbacks.onTurn).toHaveBeenCalledTimes(3);
    expect(callbacks.onToolCall).toHaveBeenCalledTimes(2);
    expect(callbacks.onSessionInit).toHaveBeenCalledTimes(1);
    expect(callbacks.onVendorReply).toHaveBeenCalledTimes(1);
    // One report per model call, as it lands: the budget kill can act mid-run.
    expect(callbacks.onTokenUsage.mock.calls.map(c => c[0])).toEqual([
      { input: 15585, output: 182, total: 15767, cacheRead: 0 },
      { input: 15815, output: 102, total: 15917, cacheRead: 0 },
      { input: 15952, output: 34, total: 15986, cacheRead: 15729 },
    ]);
    expect(callbacks.onAllowance).toHaveBeenCalledWith({ usedPercent: 16, resetsAt: new Date(1794787200000) });
    expect(callbacks.onRunError).not.toHaveBeenCalled();
    expect(text).toBe('kumquat-42');
  });

  it('reports usage before the turn ends, so a budget stop needs no terminal', () => {
    const { callbacks } = run(SERVE_RUN.slice(0, 7));
    expect(callbacks.onTokenUsage).toHaveBeenCalledWith({ input: 15585, output: 182, total: 15767, cacheRead: 0 });
  });

  it('a new message replaces the previous one; text before a tool call is commentary', () => {
    const { text, callbacks } = run([
      item('item/started', { itemId: 'c1', kind: 'agentMessage', text: '' }),
      msp('item/delta', { delta: 'Checking ', itemId: 'c1' }),
      msp('item/delta', { delta: 'the file.', itemId: 'c1' }),
      item('item/completed', { itemId: 'c1', kind: 'agentMessage', messagePhase: 'commentary', status: 'completed', text: 'Checking the file.' }),
      item('item/started', { itemId: 't1', kind: 'toolCall', status: 'inProgress', tool: 'mcp__octipus__read_file' }),
      item('item/started', { itemId: 'a2', kind: 'agentMessage', text: '' }),
      msp('item/delta', { delta: 'final', field: 'text', itemId: 'a2' }),
      // A tool's streamed output is not the answer.
      msp('item/delta', { delta: 'noise', field: 'output', itemId: 't1' }),
    ]);
    expect(callbacks.onCommentary).toHaveBeenCalledWith('Checking the file.');
    expect(text).toBe('final');
  });

  it('closes a call muse refused before it ran, with one row', () => {
    const { events } = run([item('item/completed', { itemId: 't9', kind: 'toolCall', status: 'rejected', tool: 'muse.bash', failureReason: 'unknown tool `muse.bash`' })]);
    const actions = events.filter(e => e.type === 'action').map(e => [e.data.type, e.data.id, e.data.isError ?? null]);
    expect(actions).toEqual([['cli_tool_use', 't9', null], ['cli_tool_result', 't9', true]]);
  });

  it('fails on a refused request, a server request, and a failed turn; a quota stop spends the allowance', () => {
    // Live 1.4.20: a resume of an id the host does not hold.
    expect(run([{ id: 2, jsonrpc: '2.0', error: { code: -32020, data: { kind: 'sessionNotFound', retryable: false, sessionId: 'x' }, message: 'session x not found' } }]).callbacks.onRunError)
      .toHaveBeenCalledWith('Muse Code refused the run (sessionNotFound): session x not found');
    expect(run([{ id: 7, jsonrpc: '2.0', method: 'approval/request', params: {} }]).callbacks.onRunError)
      .toHaveBeenCalledWith('Muse Code asked for approval/request, which an Octipus run does not answer');
    const quota = run([msp('turn/completed', { terminal: 'failed', error: { kind: 'modelError', message: 'usage limit reached', retryable: false, quota: { limitKind: 'window', resetsAtMs: 1794691816000 } } })]);
    expect(quota.callbacks.onAllowance).toHaveBeenCalledWith({ usedPercent: 100, resetsAt: new Date(1794691816000) });
    expect(quota.callbacks.onRunError).toHaveBeenCalledWith('Muse Code run failed: usage limit reached');
  });
});

describe('museProtocolStep', () => {
  it('sends the turn once the session is open and ends input when the turn is over or a request fails', () => {
    expect(museProtocolStep({ id: 1, result: {} }, 'TURN')).toEqual({});
    expect(museProtocolStep({ id: 2, result: { session: {} } }, 'TURN')).toEqual({ write: 'TURN' });
    expect(museProtocolStep({ id: 2, error: { message: 'x' } }, 'TURN')).toEqual({ end: true });
    expect(museProtocolStep({ method: 'item/started', params: {} }, 'TURN')).toEqual({});
    expect(museProtocolStep({ method: 'turn/completed', params: {} }, 'TURN')).toEqual({ end: true });
    expect(museProtocolStep({ id: 9, method: 'userInput/request', params: {} }, 'TURN')).toEqual({ end: true });
  });
});

describe('CLIArgumentBuilder (Muse Code)', () => {
  const builder = new CLIArgumentBuilder();
  const muse = { home: '/tmp/octipus-cli/muse-home-x', workspace: '/tmp/octipus-cli/muse-ws/abc' };
  const connection = { url: 'http://127.0.0.1:43123', key: 'k', planMode: false, maxIterations: 7, conversationId: 'conv', workingDirectory: '/w', muse };
  const lines = (text: string) => text.trim().split('\n').map(line => JSON.parse(line));
  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('serves MSP in the run config home: session in the empty workspace, prompt and images in the turn on stdin, nothing native', () => {
    const image = { path: '/w/a.png', mimeType: 'image/png', data: 'iVBORw0K' };
    const built = builder.build('Muse Code', 'do it', { model: 'some-model', extraArgs: ['--reasoning-effort', 'low'] }, [], 'SYSTEM', 100, 'a', { ...connection, images: [image] });
    expect(built.binary).toBe('muse');
    expect(built.env).toEqual({ XDG_CONFIG_HOME: muse.home });
    expect(built.args).toEqual(['serve', '--disable-request-user-input', '-c', 'run.reminder_roster=[]', '--no-session-log']);
    expect(built.keepStdinOpen).toBeUndefined();
    const [init, initialized, open] = lines(built.stdinPrompt!);
    expect(init).toMatchObject({ id: 1, method: 'initialize' });
    expect(initialized).toEqual({ jsonrpc: '2.0', method: 'initialized' });
    expect(open).toMatchObject({ id: 2, method: 'session/start', params: { workspaceRoots: [muse.workspace], approvalMode: 'allowAll', modelId: 'some-model' } });
    expect(open.params.sessionId).toMatch(UUID_V7);
    expect(open.params.commandId).toMatch(UUID_V7);
    const [turn] = lines(built.museTurn!);
    expect(turn).toMatchObject({ id: 3, method: 'turn/start', params: { sessionId: open.params.sessionId, reasoningEffort: 'low' } });
    expect(turn.params.input).toEqual([
      { type: 'text', text: "SYSTEM\n\n---\n\nMuse Code's own workspace root is an empty placeholder. This run's files are in /w; reach them only through the Octipus tools.\n\n---\n\ndo it" },
      { type: 'image', base64Data: 'iVBORw0K', mediaType: 'image/png' },
    ]);
    expect(JSON.stringify(built.args)).not.toContain('do it');
  });

  it('starts a caller-minted session under its id, then resumes it', () => {
    const id = '01a1dafb-eeb1-762b-ab48-acf1cc20eba4';
    const first = builder.build('Muse Code', 't', {}, [], null, 100, 'a', connection, { id, isFirstRun: true });
    const later = builder.build('Muse Code', 't', {}, [], null, 100, 'a', connection, { id, isFirstRun: false });
    expect(lines(first.stdinPrompt!)[2]).toMatchObject({ method: 'session/start', params: { sessionId: id } });
    expect(lines(later.stdinPrompt!)[2]).toMatchObject({ method: 'session/resume', params: { sessionId: id, excludeItems: true } });
    for (const built of [first, later]) {
      expect(built.args).not.toContain('--no-session-log');
      expect(lines(built.museTurn!)[0].params.sessionId).toBe(id);
    }
  });

  it('refuses without the bridge, with a permission mode, in spaces and on personal rows, and unscoped extraArgs', () => {
    expect(() => builder.build('Muse Code', 't', {}, [], null)).toThrow(/only with the Octipus tool bridge/);
    expect(() => builder.build('Muse Code', 't', {}, [], null, 100, 'a', { ...connection, muse: undefined })).toThrow(/only with the Octipus tool bridge/);
    expect(() => builder.build('Muse Code', 't', { permissionMode: 'full' }, [], null, 100, 'a', connection)).toThrow(/permission mode does not apply/);
    expect(() => builder.build('Muse Code', 't', {}, [], null, 100, 'a', { ...connection, space: true })).toThrow(/cannot run in a shared space: it keeps one login/);
    expect(() => builder.build('Muse Code', 't', {}, [], null, 100, 'a', { ...connection, personal: true })).toThrow(/cannot run on a personal model: it keeps one login/);
    expect(() => builder.build('Muse Code', 't', { extraArgs: ['--yolo'] }, [], null, 100, 'a', connection)).toThrow('Unsupported extraArgs');
    expect(() => builder.build('Muse Code', 't', { extraArgs: ['--disable-web-tools'] }, [], null, 100, 'a', connection)).toThrow('Unsupported extraArgs');
    expect(() => builder.build('Muse Code', 't', { extraArgs: ['--reasoning-effort', 'ultra-max'] }, [], null, 100, 'a', connection)).toThrow('Unsupported extraArgs');
  });
});

describe.skipIf(process.platform === 'win32')('prepareMuseHome / disposeMuseHome / museSessionLogExists', () => {
  const dirs: string[] = [];
  const config = getConfig().cliModels;
  const original = config.museCli.binaryPath;
  afterEach(() => {
    config.museCli.binaryPath = original;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

  /** A fake `muse` answering `skills list --json` from the settings it is pointed at. */
  function fakeMuse(skills: object[]) {
    const bin = join(temp('fake-muse-'), 'muse');
    writeFileSync(bin, `#!/bin/sh\n[ -f "$XDG_CONFIG_HOME/muse/settings.json" ] || exit 3\necho '${JSON.stringify({ diagnostics: [], skills })}'\n`);
    chmodSync(bin, 0o755);
    config.museCli.binaryPath = bin;
  }

  it('writes a config whose only tools are the bridge, links the login, trusts only the empty workspace', async () => {
    const home = temp('muse-user-');
    mkdirSync(join(home, '.config', 'muse'), { recursive: true });
    writeFileSync(join(home, '.config', 'muse', 'auth.json'), '{"never":"read"}', { mode: 0o600 });
    writeFileSync(join(home, '.config', 'muse', 'settings.json'), JSON.stringify({ schema_version: 1, model: 'muse-spark-1.2', mcpServers: { mine: { command: 'x' } }, hooks: { a: 1 } }));
    fakeMuse([
      { scope: 'bundled', path: 'bundled://muse-core/skills/git/SKILL.md', activation: 'on' },
      { scope: 'user', path: '$HOME/.agents/skills/archify/SKILL.md', activation: 'user-invocable-only' },
      { scope: 'plugin', path: 'plugin://herdr/skills/herdr/SKILL.md', activation: 'off' },
    ]);
    const workspace = museWorkspaceFor(temp('octi-ws-'));
    const configHome = await prepareMuseHome({ workspace, tools: ['read_file', 'call_discovered_tool'], env: { HOME: home, PATH: process.env.PATH } });
    const dir = join(configHome, 'muse');
    expect(lstatSync(join(dir, 'auth.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, 'auth.json'))).toBe(join(home, '.config', 'muse', 'auth.json'));
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(statSync(join(dir, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(settings).toMatchObject({
      model: 'muse-spark-1.2',
      run: { toolset: ['mcp__octipus__read_file', 'mcp__octipus__call_discovered_tool'], subagent_delegation_mode: 'off' },
      context: { foreign_personal_rules: false, foreign_personal_skills: false },
      local_session_messaging: { enabled: false },
      skills: { activation: { bundled: { 'bundled://muse-core/skills/git/SKILL.md': 'off' }, user: { '$HOME/.agents/skills/archify/SKILL.md': 'off' } } },
    });
    // The user's own servers and hooks never come along; the bridge server takes its secrets from the environment.
    expect(Object.keys(settings.mcpServers)).toEqual(['octipus']);
    expect(settings.hooks).toBeUndefined();
    expect(settings.mcpServers.octipus).toMatchObject({ required: true, env: { OCTIPUS_AGENT_URL: '${OCTIPUS_AGENT_URL}', OCTIPUS_AGENT_KEY: '${OCTIPUS_AGENT_KEY}' } });
    expect(JSON.parse(readFileSync(join(dir, 'trust.json'), 'utf8')).projects).toEqual({ [workspace]: { decision: 'trusted' } });

    disposeMuseHome(configHome, { HOME: home });
    expect(existsSync(configHome)).toBe(false);
    expect(readFileSync(join(home, '.config', 'muse', 'auth.json'), 'utf8')).toBe('{"never":"read"}');
  });

  it('a tool-less config has no server and trusts nothing; a login muse rewrote is moved back, not deleted', async () => {
    const home = temp('muse-user-');
    mkdirSync(join(home, '.config', 'muse'), { recursive: true });
    writeFileSync(join(home, '.config', 'muse', 'auth.json'), 'old', { mode: 0o600 });
    fakeMuse([]);
    const configHome = await prepareMuseHome({ workspace: temp('one-shot-'), tools: [], env: { HOME: home, PATH: process.env.PATH } });
    const settings = JSON.parse(readFileSync(join(configHome, 'muse', 'settings.json'), 'utf8'));
    expect(settings.run.toolset).toEqual([]);
    expect(settings.mcpServers).toBeUndefined();
    expect(existsSync(join(configHome, 'muse', 'trust.json'))).toBe(false);
    // A token refresh written by rename replaces the link with a file.
    rmSync(join(configHome, 'muse', 'auth.json'));
    writeFileSync(join(configHome, 'muse', 'auth.json'), 'refreshed', { mode: 0o600 });
    disposeMuseHome(configHome, { HOME: home });
    expect(readFileSync(join(home, '.config', 'muse', 'auth.json'), 'utf8')).toBe('refreshed');
    expect(statSync(join(home, '.config', 'muse', 'auth.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(configHome)).toBe(false);
  });

  it('never moves a login back over a newer one, an empty one never, and a failed move keeps the run dir', async () => {
    const home = temp('muse-user-');
    const realDir = join(home, '.config', 'muse');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'auth.json'), 'old', { mode: 0o600 });
    fakeMuse([]);
    const refresh = (configHome: string, text: string) => {
      rmSync(join(configHome, 'muse', 'auth.json'));
      writeFileSync(join(configHome, 'muse', 'auth.json'), text, { mode: 0o600 });
    };

    // The user's own muse (or another run) refreshed meanwhile: theirs wins.
    const a = await prepareMuseHome({ workspace: temp('ws-'), tools: [], env: { HOME: home, PATH: process.env.PATH } });
    refresh(a, 'from-run');
    writeFileSync(join(realDir, 'auth.json'), 'newer-elsewhere!');
    disposeMuseHome(a, { HOME: home });
    expect(readFileSync(join(realDir, 'auth.json'), 'utf8')).toBe('newer-elsewhere!');
    expect(existsSync(a)).toBe(false);

    // An empty file is never installed.
    const b = await prepareMuseHome({ workspace: temp('ws-'), tools: [], env: { HOME: home, PATH: process.env.PATH } });
    refresh(b, '');
    disposeMuseHome(b, { HOME: home });
    expect(readFileSync(join(realDir, 'auth.json'), 'utf8')).toBe('newer-elsewhere!');

    // The move-back fails (config dir not writable): the run dir, holding the only refreshed copy, stays.
    const c = await prepareMuseHome({ workspace: temp('ws-'), tools: [], env: { HOME: home, PATH: process.env.PATH } });
    refresh(c, 'only-copy');
    chmodSync(realDir, 0o500);
    try {
      disposeMuseHome(c, { HOME: home });
    } finally {
      chmodSync(realDir, 0o700);
    }
    expect(readFileSync(join(c, 'muse', 'auth.json'), 'utf8')).toBe('only-copy');
    dirs.push(c);
  });

  it('fails loud and leaves nothing behind when muse cannot list its skills', async () => {
    const bin = join(temp('fake-muse-'), 'muse');
    writeFileSync(bin, '#!/bin/sh\nexit 2\n');
    chmodSync(bin, 0o755);
    config.museCli.binaryPath = bin;
    const before = new Set(existsSync(join(tmpdir(), 'octipus-cli')) ? (await import('node:fs')).readdirSync(join(tmpdir(), 'octipus-cli')) : []);
    await expect(prepareMuseHome({ workspace: temp('ws-'), tools: ['x'], env: { HOME: temp('h-'), PATH: process.env.PATH } })).rejects.toThrow(/Cannot list Muse Code skills/);
    const after = (await import('node:fs')).readdirSync(join(tmpdir(), 'octipus-cli')).filter(name => name.startsWith('muse-home-') && !before.has(name));
    expect(after).toEqual([]);
  });

  it('finds a session log under the XDG data layout', () => {
    const data = temp('muse-data-');
    expect(museSessionLogExists('abc', { XDG_DATA_HOME: data })).toBe(false);
    // muse keeps lock files and view caches beside the date folders (found live).
    mkdirSync(join(data, 'muse', 'sessions', '.msp-view-g12'), { recursive: true });
    writeFileSync(join(data, 'muse', 'sessions', '.msp-maintenance-owner.lock'), '');
    mkdirSync(join(data, 'muse', 'sessions', '2026', '11', '13', 'abc'), { recursive: true });
    expect(museSessionLogExists('abc', { XDG_DATA_HOME: data })).toBe(false);
    writeFileSync(join(data, 'muse', 'sessions', '2026', '11', '13', 'abc', 'session.jsonl'), '');
    expect(museSessionLogExists('abc', { XDG_DATA_HOME: data })).toBe(true);
    const home = temp('muse-home-user-');
    mkdirSync(join(home, '.local', 'share', 'muse', 'sessions', '2026', '01', '02', 'def'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'muse', 'sessions', '2026', '01', '02', 'def', 'session.jsonl'), '');
    expect(museSessionLogExists('def', { HOME: home })).toBe(true);
  });
});
