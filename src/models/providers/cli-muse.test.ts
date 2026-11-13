import { readFileSync, rmSync, statSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CLIArgumentBuilder, CLIOutputParser } from '@/core/cli-adapters';
import { museCliConfig, parseMuseJsonl } from './cli-provider';

// Trimmed from live `muse exec --json` runs (Muse Code 1.4.18, 2026-11-13).
// Envelope fields other than payload_type/payload are dropped; ids shortened.
const jsonl = (events: object[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const proposed = (taskId: string, taskKind: string) => ({ payload_type: 'task.lifecycle.proposed', payload: { event: { kind: 'proposed', task_id: taskId, task_kind: taskKind }, kind: 'task_lifecycle', task_id: taskId } });

const PONG = jsonl([
  { payload_type: 'run.model.configured', payload: { model_id: 'muse-spark-1.2', provider_id: 'meta', source: 'startup' } },
  proposed('r1', 'reminder.agent.skill-reminder'),
  proposed('m1', 'model.meta.response'),
  { payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: 'pong' } },
  { payload_type: 'run.usage', payload: { allowance: { weekly: { used_percent: 0 }, window: { used_percent: 1 } }, calls: 1, kind: 'run_usage', models: [{ cached_tokens: 0, calls: 1, input_tokens: 33031, model: 'muse-spark-1.2', output_tokens: 15, reasoning_tokens: 5 }] } },
  { payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', reason: null, terminal: 'completed', text: 'pong' } },
]);

const TOOLS = jsonl([
  proposed('m1', 'model.meta.response'),
  proposed('t-read', 'tool.read_file'),
  { payload_type: 'tool.result', payload: { call_id: 'call_1', correlation_facts: { outcome: 'success', tool_name: 'read_file' }, kind: 'tool_result', text: 'Read text file `/w/a.txt`.\n1|hello' } },
  proposed('r2', 'reminder.agent.skill-reminder'),
  { payload_type: 'task.lifecycle.rejected', payload: { event: { kind: 'rejected', reason: 'skip_if_running', task_id: 'r2' }, kind: 'task_lifecycle', task_id: 'r2' } },
  proposed('m2', 'model.meta.response'),
  proposed('t-write', 'tool.write_file'),
  { payload_type: 'tool.result', payload: { call_id: 'call_2', correlation_facts: { outcome: 'success', tool_name: 'write_file' }, edit_facts: { added: 1, path: '/w/b.txt', tool_name: 'write_file' }, kind: 'tool_result', text: 'wrote 6 bytes to /w/b.txt' } },
  proposed('m3', 'model.meta.response'),
  { payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: 'done' } },
  { payload_type: 'run.usage', payload: { calls: 3, kind: 'run_usage', models: [{ cached_tokens: 57826, calls: 3, input_tokens: 109119, model: 'muse-spark-1.2', output_tokens: 293, reasoning_tokens: 65 }] } },
  { payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', reason: null, terminal: 'completed', text: 'done' } },
]);

describe('museCliConfig', () => {
  it('registers cli/muse as a streamed agent-only adapter', () => {
    expect(museCliConfig.name).toBe('Muse Code');
    expect(museCliConfig.binaryPath).toBe('muse');
    expect(museCliConfig.modelPatterns).toEqual(['cli/muse']);
    expect(museCliConfig.bufferOutput).toBeUndefined();
    // No stdin prompt channel and no verified tool-less mode: never a one-shot completion.
    expect(museCliConfig.toolLessArgs).toBeUndefined();
    expect(museCliConfig.cliToolsStdin).toBeUndefined();
  });

  it('parses the answer and folds cached tokens into input', () => {
    const r = parseMuseJsonl(TOOLS, Date.now());
    expect(r.content).toBe('done');
    expect(r.usage).toMatchObject({ inputTokens: 109119, outputTokens: 293, totalTokens: 109412, cacheReadTokens: 57826, available: true });
    expect(parseMuseJsonl(PONG, Date.now()).content).toBe('pong');
  });

  it('fails a run that did not complete, or never ended', () => {
    const failed = jsonl([{ payload_type: 'run.terminal.failed', payload: { terminal: 'failed', reason: 'model did not reach a terminal state within 4 step(s)', text: 'partial' } }]);
    expect(() => parseMuseJsonl(failed, Date.now())).toThrow(/failed: model did not reach/);
    expect(() => parseMuseJsonl('', Date.now())).toThrow(/no terminal event/);
  });
});

describe('CLIOutputParser (Muse Code)', () => {
  const run = (stdout: string) => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const callbacks = { onTurn: vi.fn(), onToolCall: vi.fn(), onTokenUsage: vi.fn(), onRunError: vi.fn(), onCommentary: vi.fn() };
    const parser = new CLIOutputParser('a', 'cli/muse', (type, data) => events.push({ type, data: data as Record<string, unknown> }), callbacks, '/w');
    let text = '';
    for (const line of stdout.split('\n').filter(Boolean)) {
      const r = parser.parse(JSON.parse(line), 'Muse Code');
      if (r) text = r.replace ? r.text : text + r.text;
    }
    return { events, callbacks, text, parser };
  };

  it('emits paired tool rows, file changes, turns, usage and the final answer', () => {
    const { events, callbacks, text, parser } = run(TOOLS);
    const actions = events.filter(e => e.type === 'action').map(e => e.data);
    expect(actions.filter(a => a.type === 'cli_tool_use').map(a => [a.id, a.toolName])).toEqual([['t-read', 'read_file'], ['t-write', 'write_file']]);
    // Results carry the call id; they flip the row their start opened.
    expect(actions.filter(a => a.type === 'cli_tool_result').map(a => [a.id, a.isError])).toEqual([['t-read', false], ['t-write', false]]);
    expect(actions.find(a => a.type === 'file_change')).toMatchObject({ action: 'write', path: '/w/b.txt' });
    expect(callbacks.onTurn).toHaveBeenCalledTimes(3);
    expect(callbacks.onToolCall).toHaveBeenCalledTimes(2);
    expect(callbacks.onTokenUsage).toHaveBeenCalledWith({ input: 109119, output: 293, total: 109412, cacheRead: 57826 });
    expect(callbacks.onRunError).not.toHaveBeenCalled();
    expect(text).toBe('done');
    expect(parser.getSideEffectCounters()).toMatchObject({ toolCalls: 2, filesChanged: 1, toolErrors: 0 });
  });

  it('a new response replaces the previous one; text before a tool call is commentary', () => {
    const { text, callbacks } = run(jsonl([
      proposed('m1', 'model.meta.response'),
      { payload_type: 'run.output.delta', payload: { text: 'Checking ' } },
      { payload_type: 'run.output.delta', payload: { text: 'the file.' } },
      proposed('t1', 'tool.bash'),
      proposed('m2', 'model.meta.response'),
      { payload_type: 'run.output.delta', payload: { text: 'final' } },
    ]));
    expect(callbacks.onCommentary).toHaveBeenCalledWith('Checking the file.');
    expect(text).toBe('final');
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
  const connection = { url: 'http://127.0.0.1:43123', key: 'k', planMode: false, maxIterations: 7, conversationId: 'conv' };
  const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('runs headless JSONL with the prompt in a private file, native subagents off', () => {
    const { binary, args } = builder.build('Muse Code', 'do it', {}, [], 'SYSTEM');
    expect(binary).toBe('muse');
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '--no-session-log', '--disable-request-user-input']);
    expect(flagValue(args, '-c')).toBe('run.subagent_delegation_mode="off"');
    const promptFile = flagValue(args, '--prompt-file');
    expect(readFileSync(promptFile, 'utf8')).toBe('SYSTEM\n\n---\n\ndo it');
    if (process.platform !== 'win32') expect(statSync(promptFile).mode & 0o777).toBe(0o600);
    // No bridge: no trusted workspace, so no MCP server loads at all.
    expect(args).not.toContain('--trust-workspace');
    expect(args).not.toContain('do it');
  });

  it('registers the bridge under a per-run name with env references only', () => {
    const { args } = builder.build('Muse Code', 'task', { model: 'some-model' }, [], null, 100, 'a', connection);
    expect(args).toContain('--trust-workspace');
    expect(flagValue(args, '--max-model-steps')).toBe('7');
    expect(flagValue(args, '--model')).toBe('some-model');
    const server = args.find(a => a.startsWith('mcpServers.'))!;
    expect(server).toMatch(/^mcpServers\.octipus_run_[a-f0-9]{16}=/);
    const config = JSON.parse(server.slice(server.indexOf('=') + 1));
    expect(config.env).toEqual({ OCTIPUS_AGENT_URL: '${OCTIPUS_AGENT_URL}', OCTIPUS_AGENT_KEY: '${OCTIPUS_AGENT_KEY}' });
    expect(server).not.toContain('"k"');
  });

  it('maps permission levels to muse safety flags', () => {
    const args = (permissionMode?: string, planMode = false) => builder.build('Muse Code', 't', { permissionMode }, [], null, 100, 'a', { ...connection, planMode }).args;
    expect(args()).not.toContain('--disable-approval');
    expect(args('safe')).toEqual(expect.arrayContaining(['--disable-write', '--disable-shell']));
    expect(args('workspace', true)).toEqual(expect.arrayContaining(['--disable-write', '--disable-shell']));
    expect(args('full')).toEqual(expect.arrayContaining(['--disable-approval', '--disable-sandbox']));
    expect(() => args('bypassPermissions')).toThrow(/Unsupported Muse Code permission mode/);
  });

  it('refuses spaces and personal rows, and unscoped extraArgs on a managed run', () => {
    expect(() => builder.build('Muse Code', 't', {}, [], null, 100, 'a', { ...connection, space: true })).toThrow(/cannot run in a shared space/);
    expect(() => builder.build('Muse Code', 't', {}, [], null, 100, 'a', { ...connection, personal: true })).toThrow(/cannot run on a personal model/);
    expect(() => builder.build('Muse Code', 't', { extraArgs: ['--yolo'] }, [], null, 100, 'a', connection)).toThrow('Unsupported extraArgs');
    expect(builder.build('Muse Code', 't', { extraArgs: ['--reasoning-effort', 'low'] }, [], null, 100, 'a', connection).args).toContain('low');
  });
});
