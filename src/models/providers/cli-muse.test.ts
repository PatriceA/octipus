import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@/config';
import { CLIArgumentBuilder, CLIOutputParser, disposeMuseHome, museAllowance, museSessionLogExists, museWorkspaceFor, prepareMuseHome } from '@/core/cli-adapters';
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
  });
});

describe('CLIOutputParser (Muse Code)', () => {
  const run = (stdout: string) => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const callbacks = { onTurn: vi.fn(), onToolCall: vi.fn(), onTokenUsage: vi.fn(), onRunError: vi.fn(), onCommentary: vi.fn(),
      onSessionInit: vi.fn(), onVendorReply: vi.fn(), onAllowance: vi.fn(), isBridgedTool: (name: string) => name.startsWith('mcp__octipus__') };
    const parser = new CLIOutputParser('a', 'cli/muse', (type, data) => events.push({ type, data: data as Record<string, unknown> }), callbacks, '/w');
    let text = '';
    for (const line of stdout.split('\n').filter(Boolean)) {
      const r = parser.parse(JSON.parse(line), 'Muse Code');
      if (r) text = r.replace ? r.text : text + r.text;
    }
    return { events, callbacks, text, parser };
  };

  it('emits paired bridge tool rows, turns, usage, allowance, session and reply signals, and the answer', () => {
    const { events, callbacks, text } = run(TOOLS);
    const actions = events.filter(e => e.type === 'action').map(e => e.data);
    expect(actions.filter(a => a.type === 'cli_tool_use').map(a => [a.id, a.toolName])).toEqual([['t-secret', 'mcp__octipus__secret_word'], ['t-write', 'mcp__octipus__write_file']]);
    expect(actions.filter(a => a.type === 'cli_tool_result').map(a => [a.id, a.isError])).toEqual([['t-secret', false], ['t-write', true]]);
    expect(actions.some(a => a.type === 'file_change')).toBe(false);
    expect(callbacks.onTurn).toHaveBeenCalledTimes(3);
    expect(callbacks.onToolCall).toHaveBeenCalledTimes(2);
    expect(callbacks.onSessionInit).toHaveBeenCalledTimes(1);
    expect(callbacks.onVendorReply).toHaveBeenCalledTimes(1);
    expect(callbacks.onAllowance).toHaveBeenCalledWith({ usedPercent: 22, resetsAt: new Date(1794599619000) });
    expect(callbacks.onTokenUsage).toHaveBeenCalledWith({ input: 61685, output: 654, total: 62339, cacheRead: 40808 });
    expect(callbacks.onRunError).not.toHaveBeenCalled();
    expect(text).toBe('done');
  });

  it('a new response replaces the previous one; text before a tool call is commentary', () => {
    const { text, callbacks } = run(jsonl([
      proposed('m1', 'model.meta.response'),
      { payload_type: 'run.output.delta', payload: { text: 'Checking ' } },
      { payload_type: 'run.output.delta', payload: { text: 'the file.' } },
      proposed('t1', 'tool.mcp__octipus__read_file'),
      proposed('m2', 'model.meta.response'),
      { payload_type: 'run.output.delta', payload: { text: 'final' } },
    ]));
    expect(callbacks.onCommentary).toHaveBeenCalledWith('Checking the file.');
    expect(text).toBe('final');
  });

  it('closes a guessed native tool once, through its rejection (live: "unknown tool `muse.bash`")', () => {
    const { events } = run(jsonl([
      proposed('m1', 'model.meta.response'),
      proposed('t1', 'tool.muse.bash'),
      { payload_type: 'task.lifecycle.rejected', payload: { event: { kind: 'rejected', reason: 'unknown_tool', task_id: 't1' } } },
      { payload_type: 'tool.result', payload: { call_id: 'call_1', kind: 'tool_result', text: 'tool unavailable: unknown tool `muse.bash`. Session tool ids: (none)' } },
    ]));
    const results = events.filter(e => e.type === 'action' && e.data.type === 'cli_tool_result').map(e => e.data);
    expect(results).toEqual([expect.objectContaining({ id: 't1', toolName: 'muse.bash', isError: true })]);
  });

  it('reports a failed terminal as a run error', () => {
    const { callbacks } = run(jsonl([{ payload_type: 'run.terminal.failed', payload: { terminal: 'failed', reason: 'step limit', text: '' } }]));
    expect(callbacks.onRunError).toHaveBeenCalledWith('Muse Code run failed: step limit');
  });
});

describe('CLIArgumentBuilder (Muse Code)', () => {
  // Each build writes a prompt file the worker would remove after the run.
  const promptFiles: string[] = [];
  const builder = { build: (...a: Parameters<CLIArgumentBuilder['build']>) => {
    const out = new CLIArgumentBuilder().build(...a);
    promptFiles.push(out.args[out.args.indexOf('--prompt-file') + 1]);
    return out;
  } };
  afterAll(() => { for (const file of promptFiles) rmSync(file, { force: true }); });
  const muse = { home: '/tmp/octipus-cli/muse-home-x', workspace: '/tmp/octipus-cli/muse-ws/abc' };
  const connection = { url: 'http://127.0.0.1:43123', key: 'k', planMode: false, maxIterations: 7, conversationId: 'conv', workingDirectory: '/w', muse };
  const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('runs headless in the run config home and empty workspace, prompt in a private file, nothing native', () => {
    const { binary, args, env } = builder.build('Muse Code', 'do it', { model: 'some-model' }, [], 'SYSTEM', 100, 'a', connection);
    expect(binary).toBe('muse');
    expect(env).toEqual({ XDG_CONFIG_HOME: muse.home });
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--disable-reminders', '--disable-request-user-input', '--no-foreign-personal-context', '--disable-approval', '--no-session-log']));
    expect(flagValue(args, '--approval-judge')).toBe('off');
    expect(flagValue(args, '--workspace')).toBe(muse.workspace);
    expect(flagValue(args, '--max-model-steps')).toBe('7');
    expect(flagValue(args, '--model')).toBe('some-model');
    // The tool surface lives in the config home (`prepareMuseHome`), never on argv.
    expect(args).not.toContain('--trust-workspace');
    expect(args).not.toContain('-c');
    const promptFile = flagValue(args, '--prompt-file');
    expect(readFileSync(promptFile, 'utf8')).toBe("SYSTEM\n\n---\n\nMuse Code's own workspace root is an empty placeholder. This run's files are in /w; reach them only through the Octipus tools.\n\n---\n\ndo it");
    if (process.platform !== 'win32') expect(statSync(promptFile).mode & 0o777).toBe(0o600);
    expect(args).not.toContain('do it');
  });

  it('continues a caller-minted session with the same id on every run', () => {
    const first = builder.build('Muse Code', 't', {}, [], null, 100, 'a', connection, { id: 'uuid-1', isFirstRun: true }).args;
    const later = builder.build('Muse Code', 't', {}, [], null, 100, 'a', connection, { id: 'uuid-1', isFirstRun: false }).args;
    for (const args of [first, later]) {
      expect(flagValue(args, '--session-id')).toBe('uuid-1');
      expect(args).not.toContain('--no-session-log');
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
    expect(builder.build('Muse Code', 't', { extraArgs: ['--reasoning-effort', 'low'] }, [], null, 100, 'a', connection).args).toContain('low');
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
    expect(existsSync(configHome)).toBe(false);
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
