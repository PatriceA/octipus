import { describe, expect, test } from 'bun:test';
import { ToolExecutor } from './tool-executor';
import type { ToolHandler } from './agent-base';
import type { AgentContext, ToolCall } from './types';

/**
 * Receipt side-effect counters. The executor is the single deterministic
 * choke point for every tool call, so it tallies side effects the swarm
 * spawner later reads via `getSideEffectCounters()` to build a receipt.
 *
 * These tests use `toolId: 'agent'` (meta-tool fast path) to skip permission
 * gating — file/command classification is purely name-based, so it works the
 * same on either path.
 */

function makeContext(): AgentContext {
  return {
    id: 'agent-test',
    sessionId: '00000000-0000-0000-0000-000000000000',
    userId: 'user-test',
    model: 'test',
    topic: '',
    role: 'orchestrator',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  };
}

function tool(name: string, execute: ToolHandler['execute']): ToolHandler {
  return { name, toolId: 'agent', description: name, parameters: {}, execute };
}

function freshExecutor(...tools: ToolHandler[]): ToolExecutor {
  const exec = new ToolExecutor(makeContext(), () => {});
  for (const t of tools) exec.registerTool(t);
  return exec;
}

const ok = async () => 'ok';

describe('ToolExecutor — side-effect counters', () => {
  test('starts at all-zero', () => {
    const c = freshExecutor().getSideEffectCounters();
    expect(c.toolCalls).toBe(0);
    expect(c.byName).toEqual({});
  });

  test('counts each executed call and tallies by name', async () => {
    const exec = freshExecutor(tool('echo', ok), tool('other', ok));
    await exec.handleToolCalls([
      { id: '1', name: 'echo', arguments: {} },
      { id: '2', name: 'echo', arguments: {} },
      { id: '3', name: 'other', arguments: {} },
    ]);
    const c = exec.getSideEffectCounters();
    expect(c.toolCalls).toBe(3);
    expect(c.byName).toEqual({ echo: 2, other: 1 });
  });

  test('classifies file-mutating tools as filesChanged', async () => {
    const exec = freshExecutor(
      tool('filesystem__write_file', async () => ({ success: true, path: '/x' })),
      tool('filesystem__delete_file', async () => ({ success: true, path: '/y' })),
      tool('filesystem__read_file', ok), // read is NOT a mutation
    );
    await exec.handleToolCalls([
      { id: '1', name: 'filesystem__write_file', arguments: {} },
      { id: '2', name: 'filesystem__delete_file', arguments: {} },
      { id: '3', name: 'filesystem__read_file', arguments: {} },
    ]);
    const c = exec.getSideEffectCounters();
    expect(c.filesChanged).toBe(2);
    expect(c.commandsRun).toBe(0);
    expect(c.toolCalls).toBe(3);
  });

  test('classifies shell__run and shell__run_background as commandsRun', async () => {
    const exec = freshExecutor(tool('shell__run', ok), tool('shell__run_background', ok));
    await exec.handleToolCalls([
      { id: '1', name: 'shell__run', arguments: {} },
      { id: '2', name: 'shell__run_background', arguments: {} },
    ]);
    const c = exec.getSideEffectCounters();
    expect(c.commandsRun).toBe(2);
    expect(c.filesChanged).toBe(0);
  });

  test('toolCalls is derived as the exact sum of byName', async () => {
    const exec = freshExecutor(tool('a', ok), tool('b', ok));
    await exec.handleToolCalls([
      { id: '1', name: 'a', arguments: {} },
      { id: '2', name: 'a', arguments: {} },
      { id: '3', name: 'b', arguments: {} },
    ]);
    const c = exec.getSideEffectCounters();
    const sum = Object.values(c.byName).reduce((x, y) => x + y, 0);
    expect(c.toolCalls).toBe(sum);
    expect(c.toolCalls).toBe(3);
  });

  test('counts non-cancellation tool errors, and does not count them as executed', async () => {
    const exec = freshExecutor(tool('boom', async () => { throw new Error('kaboom'); }));
    await exec.handleToolCalls([{ id: '1', name: 'boom', arguments: {} }]);
    const c = exec.getSideEffectCounters();
    expect(c.toolErrors).toBe(1);
    // A throw means execute did not complete — not counted in toolCalls.
    expect(c.toolCalls).toBe(0);
    expect(c.byName).toEqual({});
  });

  test('unknown tools are not counted at all', async () => {
    const exec = freshExecutor(tool('known', ok));
    await exec.handleToolCalls([{ id: '1', name: 'does_not_exist', arguments: {} }]);
    const c = exec.getSideEffectCounters();
    expect(c.toolCalls).toBe(0);
    expect(c.toolErrors).toBe(0);
  });

  test('getSideEffectCounters returns an immutable snapshot', async () => {
    const exec = freshExecutor(tool('echo', ok));
    await exec.handleToolCalls([{ id: '1', name: 'echo', arguments: {} }]);
    const snap = exec.getSideEffectCounters();
    snap.toolCalls = 999;
    snap.byName.echo = 999;
    const fresh = exec.getSideEffectCounters();
    expect(fresh.toolCalls).toBe(1);
    expect(fresh.byName.echo).toBe(1);
  });

  test('counters accumulate across multiple handleToolCalls batches', async () => {
    const exec = freshExecutor(tool('echo', ok));
    await exec.handleToolCalls([{ id: '1', name: 'echo', arguments: {} }]);
    await exec.handleToolCalls([{ id: '2', name: 'echo', arguments: {} }]);
    expect(exec.getSideEffectCounters().toolCalls).toBe(2);
  });
});
