import { describe, expect, it } from 'vitest';
import {
  CLIOutputParser,
  type CLIParserCallbacks,
  detectFileChangeFromCommand,
  detectToolFromCommand,
  resolveClaudePermissionMode,
  resolveCodexSandboxMode,
} from './cli-adapters';

/** Collect every emitted event + callback invocation for assertions. */
function makeParser(cwd = '/work') {
  const events: Array<{ type: string; data: any }> = [];
  const turns: number[] = [];
  const toolCalls: number[] = [];
  const tokenReports: Array<{ input: number; output: number; total: number }> = [];
  const turnCounts: number[] = [];
  const runErrors: string[] = [];
  const cbs: CLIParserCallbacks = {
    onTurn: () => turns.push(1),
    onToolCall: () => toolCalls.push(1),
    onTokenUsage: (t) => tokenReports.push(t),
    onTurnCount: (n) => turnCounts.push(n),
    onRunError: (r) => runErrors.push(r),
  };
  const parser = new CLIOutputParser('agent-1', 'cli/codex', (type, data) => events.push({ type, data }), cbs, cwd);
  const feed = (event: Record<string, unknown>, tool: string) => parser.parse(event, tool);
  const actions = (subtype: string) => events.filter((e) => e.type === 'action' && e.data?.type === subtype).map((e) => e.data);
  return { parser, events, feed, actions, turns, toolCalls, tokenReports, turnCounts, runErrors };
}

// ── Codex fixture replay ────────────────────────────────────────────────────

describe('CLIOutputParser — codex JSONL fixture', () => {
  const CODEX_EVENTS: Record<string, unknown>[] = [
    { type: 'thread.started', thread_id: 'th-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "zsh -lc 'git status -sb'", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "zsh -lc 'git status -sb'", aggregated_output: 'On branch main', exit_code: 0, status: 'completed' } },
    { type: 'item.started', item: { id: 'i2', type: 'command_execution', command: "bash -c 'cat > notes.md'", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: "bash -c 'cat > notes.md'", aggregated_output: '', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'i3', type: 'file_change', changes: [{ path: 'src/app.ts', kind: 'update' }, { path: 'src/new.ts', kind: 'add' }], status: 'completed' } },
    { type: 'item.started', item: { id: 'i4', type: 'mcp_tool_call', server: 'octipus', tool: 'search', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i4', type: 'mcp_tool_call', server: 'octipus', tool: 'search', result: 'found 3', status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 } },
    { type: 'item.completed', item: { id: 'i9', type: 'agent_message', text: 'All done.' } },
  ];

  const run = () => {
    const h = makeParser('/work');
    let text = '';
    for (const ev of CODEX_EVENTS) {
      const r = h.feed(ev, 'Codex CLI');
      if (r?.replace) text = r.text;
    }
    return { ...h, text };
  };

  it('titles the zsh-wrapped command from the inner command, not "zsh"', () => {
    const starts = run().actions('cli_tool_use');
    const git = starts.find((s) => s.id === 'i1');
    expect(git.toolName).toBe('git');
    expect(git.title).toBe('git status -sb');
  });

  it('carries codex item.id on start and result, pairing them', () => {
    const h = run();
    const starts = h.actions('cli_tool_use');
    const results = h.actions('cli_tool_result');
    expect(starts.map((s) => s.id)).toContain('i1');
    const res = results.find((r) => r.id === 'i1');
    expect(res).toBeDefined();
    // result carries the REAL tool name, not a hardcoded 'shell'.
    expect(res.toolName).toBe('git');
    expect(res.output).toBe('On branch main');
    expect(res.isError).toBe(false);
  });

  it('emits file_change from structured file_change items + shell redirect, resolved absolute', () => {
    const changes = run().actions('file_change');
    const paths = changes.map((c) => c.path);
    // structured apply_patch (2) + the `cat > notes.md` shell redirect (1)
    expect(paths).toContain('/work/src/app.ts');
    expect(paths).toContain('/work/src/new.ts');
    expect(paths).toContain('/work/notes.md');
    // every path is absolute
    expect(changes.every((c) => c.path.startsWith('/'))).toBe(true);
    const appChange = changes.find((c) => c.path === '/work/src/app.ts');
    expect(appChange.action).toBe('edit');
    const newChange = changes.find((c) => c.path === '/work/src/new.ts');
    expect(newChange.action).toBe('write');
  });

  it('maps mcp_tool_call to server.tool name on both start and result', () => {
    const h = run();
    const mcpStart = h.actions('cli_tool_use').find((s) => s.id === 'i4');
    const mcpResult = h.actions('cli_tool_result').find((r) => r.id === 'i4');
    expect(mcpStart.toolName).toBe('octipus.search');
    expect(mcpResult.toolName).toBe('octipus.search');
  });

  it('reports per-turn token usage totalling input+output', () => {
    const h = run();
    expect(h.tokenReports.length).toBe(1);
    expect(h.tokenReports[0].total).toBe(150);
    expect(h.tokenReports[0].input).toBe(120); // 100 + 20 cached
    expect(h.tokenReports[0].output).toBe(50);
  });

  it('counts a turn per turn.started, not per tool call', () => {
    const h = run();
    expect(h.turns.length).toBe(1);
    expect(h.toolCalls.length).toBeGreaterThanOrEqual(3);
    expect(h.text).toBe('All done.');
  });

  it('surfaces codex turn.failed / error as a run error', () => {
    const h = makeParser();
    h.feed({ type: 'turn.failed', error: { message: 'model overloaded' } }, 'Codex CLI');
    expect(h.runErrors).toContain('model overloaded');
    h.feed({ type: 'error', message: 'sandbox denied write' }, 'Codex CLI');
    expect(h.runErrors).toContain('sandbox denied write');
  });
});

// ── Claude stream-json fixture replay ───────────────────────────────────────

describe('CLIOutputParser — claude stream-json fixture', () => {
  const CLAUDE_EVENTS: Record<string, unknown>[] = [
    { type: 'system', subtype: 'init', session_id: 's-1' },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } }], usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'total 0', is_error: false }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'error: file busy', is_error: true }] } },
    { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 8, result: 'Reached turn limit', usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 30 } },
  ];

  const run = () => {
    const h = makeParser('/repo');
    let text = '';
    for (const ev of CLAUDE_EVENTS) {
      const r = h.feed(ev, 'Claude Code');
      if (r?.replace) text = r.text;
    }
    return { ...h, text };
  };

  it('pairs tool_use with the type:"user" tool_result by id, carrying is_error', () => {
    const h = run();
    const start = h.actions('cli_tool_use').find((s) => s.id === 'tu1');
    const result = h.actions('cli_tool_result').find((r) => r.id === 'tu1');
    expect(start.toolName).toBe('Bash');
    expect(result.toolName).toBe('Bash'); // resolved from the start row, not "tool"
    expect(result.output).toBe('total 0');
    expect(result.isError).toBe(false);
    const errResult = h.actions('cli_tool_result').find((r) => r.id === 'tu2');
    expect(errResult.isError).toBe(true);
  });

  it('emits a file_change with a unified diff for Edit', () => {
    const change = run().actions('file_change').find((c) => c.path === '/repo/a.ts');
    expect(change).toBeDefined();
    expect(change.action).toBe('edit');
    expect(change.diff).toBeDefined();
    expect(change.diff.added).toBe(1);
    expect(change.diff.removed).toBe(1);
    expect(change.diff.patch).toContain('+const a = 2');
  });

  it('counts a turn per assistant message and honours final num_turns', () => {
    const h = run();
    expect(h.turns.length).toBe(2); // two assistant messages
    expect(h.turnCounts).toContain(8);
  });

  it('reports error_max_turns as a run error, never success', () => {
    const h = run();
    expect(h.runErrors.length).toBe(1);
    expect(h.runErrors[0]).toContain('max-turns');
    // result event still surfaces its text for display
    expect(h.text).toBe('Reached turn limit');
    // and the terminal thought is 'failed', not 'completed'
    const finalThought = h.events.filter((e) => e.type === 'thought').at(-1);
    expect(finalThought?.data.status).toBe('failed');
  });

  it('sums token usage without double-counting the final result reconciliation', () => {
    const h = run();
    const total = h.tokenReports.reduce((s, t) => s + t.total, 0);
    // m1 message usage (15) + final result total (200+80+30=310) reconciled to
    // the max seen; per-message 15 already counted, so final delta = 295.
    expect(total).toBe(310);
  });
});

// ── detectToolFromCommand / detectFileChangeFromCommand ─────────────────────

describe('detectToolFromCommand', () => {
  it('unwraps zsh -lc and titles from the inner command', () => {
    expect(detectToolFromCommand("zsh -lc 'git status'")).toBe('git');
    expect(detectToolFromCommand('/bin/bash -c "npm test"')).toBe('npm');
  });

  it('does not treat 2>/dev/null (stderr) as write_file', () => {
    expect(detectToolFromCommand('grep foo bar.txt 2>/dev/null')).toBe('search');
    expect(detectToolFromCommand('cmd >&2')).not.toBe('write_file');
    expect(detectToolFromCommand('echo a -> b')).not.toBe('write_file');
  });

  it('detects a real stdout redirect as write_file / append_file', () => {
    expect(detectToolFromCommand('echo hi > out.txt')).toBe('write_file');
    expect(detectToolFromCommand('echo hi >> out.txt')).toBe('append_file');
  });
});

describe('detectFileChangeFromCommand', () => {
  it('handles rm -rf flags without capturing the flag as the path', () => {
    expect(detectFileChangeFromCommand('rm -rf build/')).toEqual({ action: 'delete', path: 'build/' });
    expect(detectFileChangeFromCommand('rm -r -f dist')).toEqual({ action: 'delete', path: 'dist' });
  });

  it('tolerates quoted paths with spaces', () => {
    expect(detectFileChangeFromCommand('cat > "my file.md"')).toEqual({ action: 'write', path: 'my file.md' });
    expect(detectFileChangeFromCommand("rm -rf 'old dir'")).toEqual({ action: 'delete', path: 'old dir' });
  });

  it('ignores stderr redirects', () => {
    expect(detectFileChangeFromCommand('build 2>/dev/null')).toBeNull();
  });

  it('detects sed -i in-place edits on the final file arg', () => {
    expect(detectFileChangeFromCommand("sed -i 's/a/b/' config.yaml")).toEqual({ action: 'edit', path: 'config.yaml' });
  });
});

// ── permissionMode translation (C14) ────────────────────────────────────────

describe('permissionMode translation', () => {
  it('maps shared levels per adapter', () => {
    expect(resolveClaudePermissionMode('full')).toBe('bypassPermissions');
    expect(resolveClaudePermissionMode('workspace')).toBe('acceptEdits');
    expect(resolveCodexSandboxMode('full')).toBe('danger-full-access');
    expect(resolveCodexSandboxMode('workspace')).toBe('workspace-write');
  });

  it('passes through native values of the same adapter', () => {
    expect(resolveClaudePermissionMode('bypassPermissions')).toBe('bypassPermissions');
    expect(resolveCodexSandboxMode('read-only')).toBe('read-only');
  });

  it('rejects a foreign adapter native value loudly', () => {
    // codex value on the claude adapter → throw, not an invalid-arg spawn.
    expect(() => resolveClaudePermissionMode('workspace-write')).toThrow();
    expect(() => resolveCodexSandboxMode('bypassPermissions')).toThrow();
  });
});

// ── Side-effect counters (Phase B of the pipeline evidence gate) ────────────
// A CLI writes files in its OWN process, so the parsed stream is the only
// ground truth octipus has. See docs/plans/pipeline-evidence-gate.md.

describe('CLIOutputParser — side-effect counters', () => {
  /** One Claude assistant message carrying the given tool_use blocks. */
  const assistantWith = (blocks: Array<{ name: string; input: Record<string, unknown> }>) => ({
    type: 'assistant',
    message: {
      id: `m-${blocks.map((b) => b.name).join('-')}`,
      content: blocks.map((b, i) => ({ type: 'tool_use', id: `t${i}`, name: b.name, input: b.input })),
    },
  });

  it('counts a claude run that writes one file', () => {
    const { parser, feed } = makeParser();
    feed(assistantWith([{ name: 'Write', input: { file_path: 'calc/percent.ts', content: 'export const x = 1;' } }]), 'Claude Code');

    const c = parser.getSideEffectCounters();
    expect(c?.filesChanged).toBe(1);
    expect(c?.toolCalls).toBe(1);
    expect(c?.byName.Write).toBe(1);
  });

  it('reports 0 files changed for a read-only claude run', () => {
    const { parser, feed } = makeParser();
    feed(assistantWith([
      { name: 'Read', input: { file_path: 'README.md' } },
      { name: 'Bash', input: { command: 'ls -la' } },
    ]), 'Claude Code');

    const c = parser.getSideEffectCounters();
    expect(c).not.toBeNull();
    expect(c?.filesChanged).toBe(0);
    expect(c?.toolCalls).toBe(2);
    expect(c?.commandsRun).toBe(1);
  });

  it('counts codex file_change items and command executions', () => {
    const { parser, feed } = makeParser();
    feed({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "zsh -lc 'git status'", status: 'in_progress' } }, 'Codex CLI');
    feed({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }], status: 'completed' } }, 'Codex CLI');

    expect(parser.getSideEffectCounters()?.filesChanged).toBe(2);
  });

  it('counts an errored tool result', () => {
    const { parser, feed } = makeParser();
    feed(assistantWith([{ name: 'Edit', input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' } }]), 'Claude Code');
    feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't0', content: 'nope', is_error: true }] } }, 'Claude Code');

    expect(parser.getSideEffectCounters()?.toolErrors).toBe(1);
  });

  it('returns null — unknown, NOT zero — when the stream was never recognized', () => {
    // A buffered-output CLI (agy) emits no parseable events. All-zero counters
    // would read as "wrote nothing" and wrongly fail work that succeeded.
    const { parser, feed } = makeParser();
    feed({ type: 'whatever' }, 'Antigravity');
    expect(parser.getSideEffectCounters()).toBeNull();
  });
});
