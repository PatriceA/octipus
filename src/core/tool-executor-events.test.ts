import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { messageRepository } from '@/db/repositories/message-repository';
import { ToolExecutor, resolvedFileChangePath } from './tool-executor';
import type { ToolHandler } from './agent-base';
import type { AgentContext, ToolCall } from './types';

/**
 * Phase 5 — per-tool completion events. The executor used to emit
 * a single `observation` event at end-of-batch; now it also emits
 * a `tool_call_complete` action per tool so the UI can flip rows
 * from "running" to "done" as work progresses.
 *
 * Permission checks are skipped by using `toolId: 'agent'` (meta-tool
 * fast path — see tool-executor.ts:230).
 */

function makeContext(): AgentContext {
  return {
    id: 'agent-test',
    sessionId: '00000000-0000-0000-0000-000000000000',
    userId: 'user-test',
    model: 'test',
    topic: '',
    role: 'general',
    root: true,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  };
}

interface Emitted {
  type: string;
  data: Record<string, unknown>;
}

function setupExecutor(tool: ToolHandler): { exec: ToolExecutor; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const exec = new ToolExecutor(
    makeContext(),
    (type, data) => {
      emitted.push({ type, data: data as Record<string, unknown> });
    },
  );
  exec.registerTool(tool);
  return { exec, emitted };
}

// The executor persists every tool result to `messages` (it stopped skipping the
// root when the root started doing real work). These are pure unit tests with no
// database, so the repository write is stubbed at the accessor rather than
// module-mocked — `vi.mock` on a shared repo leaks across the suite.
beforeEach(() => {
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ToolExecutor — per-tool completion events', () => {
  test('emits tool_call_complete with status=ok on success', async () => {
    const tool: ToolHandler = {
      name: 'echo',
      toolId: 'agent',
      description: 'echo',
      parameters: {},
      execute: async (args) => `you said ${args.text}`,
    };
    const { exec, emitted } = setupExecutor(tool);
    const call: ToolCall = { id: 'call-1', name: 'echo', arguments: { text: 'hi' } };
    await exec.handleToolCalls([call]);

    const completes = emitted.filter((e) =>
      e.type === 'action' && e.data?.type === 'tool_call_complete',
    );
    expect(completes).toHaveLength(1);
    expect(completes[0].data.toolCallId).toBe('call-1');
    expect(completes[0].data.status).toBe('ok');
    expect(typeof completes[0].data.durationMs).toBe('number');
    expect(completes[0].data.resultPreview).toContain('you said hi');
  });

  test('emits tool_call_complete with status=error on throw', async () => {
    const tool: ToolHandler = {
      name: 'boom',
      toolId: 'agent',
      description: 'always fails',
      parameters: {},
      execute: async () => { throw new Error('kaboom'); },
    };
    const { exec, emitted } = setupExecutor(tool);
    const call: ToolCall = { id: 'call-2', name: 'boom', arguments: {} };
    await exec.handleToolCalls([call]);

    const completes = emitted.filter((e) =>
      e.type === 'action' && e.data?.type === 'tool_call_complete',
    );
    expect(completes).toHaveLength(1);
    expect(completes[0].data.toolCallId).toBe('call-2');
    expect(completes[0].data.status).toBe('error');
    expect(completes[0].data.error).toContain('kaboom');
  });

  test('still emits the batch-end observation event for back-compat', async () => {
    const tool: ToolHandler = {
      name: 'echo',
      toolId: 'agent',
      description: 'echo',
      parameters: {},
      execute: async () => 'ok',
    };
    const { exec, emitted } = setupExecutor(tool);
    await exec.handleToolCalls([{ id: 'c1', name: 'echo', arguments: {} }]);
    const observations = emitted.filter((e) => e.type === 'observation');
    expect(observations).toHaveLength(1);
  });

  test('resultPreview trims long output to 200 chars', async () => {
    const tool: ToolHandler = {
      name: 'huge',
      toolId: 'agent',
      description: '',
      parameters: {},
      execute: async () => 'x'.repeat(5000),
    };
    const { exec, emitted } = setupExecutor(tool);
    await exec.handleToolCalls([{ id: 'c1', name: 'huge', arguments: {} }]);
    const completes = emitted.filter((e) =>
      e.type === 'action' && e.data?.type === 'tool_call_complete',
    );
    expect(completes).toHaveLength(1);
    expect(typeof completes[0].data.resultPreview).toBe('string');
    expect((completes[0].data.resultPreview as string).length).toBeLessThanOrEqual(200);
  });

  test('handles object results in resultPreview as JSON', async () => {
    const tool: ToolHandler = {
      name: 'structured',
      toolId: 'agent',
      description: '',
      parameters: {},
      execute: async () => ({ files: ['a.ts', 'b.ts'], count: 2 }),
    };
    const { exec, emitted } = setupExecutor(tool);
    await exec.handleToolCalls([{ id: 'c1', name: 'structured', arguments: {} }]);
    const complete = emitted.find((e) =>
      e.type === 'action' && e.data?.type === 'tool_call_complete',
    );
    expect(complete).toBeDefined();
    expect(complete!.data.resultPreview).toContain('files');
    expect(complete!.data.resultPreview).toContain('a.ts');
  });
});

describe('ToolExecutor — near-miss tool name routing', () => {
  // Tools registered with prefixed names; the model sometimes emits the bare
  // sub-name or a typo. The executor recovers when the match is unambiguous.
  function fsTool(name: string): ToolHandler {
    return {
      name,
      toolId: 'agent', // skip permission gating in the unit test
      description: name,
      parameters: {},
      execute: async () => `ran ${name}`,
    };
  }

  function resultFor(exec: ToolExecutor, calls: ToolCall[]) {
    return exec.handleToolCalls(calls);
  }

  test('routes a bare sub-name to its unique prefixed tool', async () => {
    const { exec, emitted } = setupExecutor(fsTool('filesystem__read_file'));
    const msgs = await resultFor(exec, [{ id: 'c1', name: 'read_file', arguments: {} }]);
    // It executed (observation carries the result), not an Unknown-tool error.
    const joined = JSON.stringify(msgs);
    expect(joined).toContain('ran filesystem__read_file');
    expect(joined).not.toContain('Unknown tool');
    // And the completion event reports success.
    const complete = emitted.find(
      (e) => e.type === 'action' && e.data?.type === 'tool_call_complete',
    );
    expect(complete?.data.status).toBe('ok');
  });

  test('routes a single-char typo via fuzzy fallback', async () => {
    const { exec } = setupExecutor(fsTool('filesystem__list_directory'));
    const msgs = await resultFor(exec, [
      { id: 'c1', name: 'filesystem__list_directroy', arguments: {} },
    ]);
    expect(JSON.stringify(msgs)).toContain('ran filesystem__list_directory');
  });

  test('does NOT route when a bare sub-name is ambiguous across groups', async () => {
    const exec = new ToolExecutor(makeContext(), () => {});
    exec.registerTool(fsTool('filesystem__search'));
    exec.registerTool(fsTool('knowledge__search'));
    const msgs = await resultFor(exec, [{ id: 'c1', name: 'search', arguments: {} }]);
    const joined = JSON.stringify(msgs);
    expect(joined).toContain('Unknown tool: search');
    expect(joined).not.toContain('ran ');
  });

  test('normalizeToolCallNames mutates near-miss names and is idempotent', () => {
    const exec = new ToolExecutor(makeContext(), () => {});
    exec.registerTool(fsTool('filesystem__read_file'));
    const calls: ToolCall[] = [
      { id: 'c1', name: 'read_file', arguments: {} }, // bare → routed
      { id: 'c2', name: 'filesystem__read_file', arguments: {} }, // exact → untouched
      { id: 'c3', name: 'totally_unknown', arguments: {} }, // unresolvable → left as-is
    ];
    exec.normalizeToolCallNames(calls);
    expect(calls[0].name).toBe('filesystem__read_file');
    expect(calls[1].name).toBe('filesystem__read_file');
    expect(calls[2].name).toBe('totally_unknown');
    // Running again is a no-op.
    exec.normalizeToolCallNames(calls);
    expect(calls.map((c) => c.name)).toEqual([
      'filesystem__read_file',
      'filesystem__read_file',
      'totally_unknown',
    ]);
  });

  test('reports Unknown tool with no hint when nothing is close', async () => {
    const { exec } = setupExecutor(fsTool('filesystem__read_file'));
    const msgs = await resultFor(exec, [
      { id: 'c1', name: 'completely_unrelated_xyz', arguments: {} },
    ]);
    const joined = JSON.stringify(msgs);
    expect(joined).toContain('Unknown tool: completely_unrelated_xyz');
    expect(joined).not.toContain('Did you mean');
  });
});

describe('resolvedFileChangePath — file_change emits the path the tool wrote', () => {
  // write_file relocates `/workspace/todo.md` into the session output dir and
  // returns the canonical path. The file_change event must carry that resolved
  // path, not the requested argument path, or the UI links a file that does not
  // exist at the requested location ("File not found" on click).
  test('returns `path` for write/append/delete/create_directory results', () => {
    const relocated = '/workspace/sessions/2026-06-10-general-abc/todo.md';
    // write_file carries bytesWritten; append/delete/create_directory return
    // just { success, path } — both shapes must resolve to `path`.
    expect(resolvedFileChangePath({ success: true, path: relocated, bytesWritten: 40 })).toBe(relocated);
    expect(resolvedFileChangePath({ success: true, path: relocated })).toBe(relocated);
  });

  test('prefers `destination` for copy/move results', () => {
    expect(resolvedFileChangePath({ success: true, source: '/a/old.md', destination: '/a/new.md' }))
      .toBe('/a/new.md');
  });

  test('returns undefined so the caller can fall back when no path is present', () => {
    expect(resolvedFileChangePath({ success: true })).toBeUndefined();
    expect(resolvedFileChangePath(null)).toBeUndefined();
    expect(resolvedFileChangePath('not an object')).toBeUndefined();
    expect(resolvedFileChangePath({ path: '' })).toBeUndefined();
  });
});
