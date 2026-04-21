import { describe, test, expect } from 'bun:test';
import { validateSpawnChildArgs, formatChildResult, createSpawnChildTool } from './swarm-tool';
import { LEVEL_DEFAULT, type AgentNode, type ChildResult } from './types';
import { SwarmSpawner } from './spawner';

// ── validateSpawnChildArgs ───────────────────────────────────────────

describe('validateSpawnChildArgs', () => {
  const valid = {
    topic: 'security',
    subtopic: 'oauth',
    taskBrief: 'Review the PKCE flow.',
    expectedOutput: { shape: 'summary' },
  };

  test('accepts minimal valid args', () => {
    const r = validateSpawnChildArgs(valid);
    expect('params' in r).toBe(true);
    if ('params' in r) {
      expect(r.params.topic).toBe('security');
      expect(r.params.subtopic).toBe('oauth');
      expect(r.params.expectedOutput.shape).toBe('summary');
      // default maxTokens fill-in
      expect(r.params.expectedOutput.maxTokens).toBe(2000);
    }
  });

  test('rejects missing topic', () => {
    const r = validateSpawnChildArgs({ ...valid, topic: '' });
    expect('error' in r).toBe(true);
  });

  test('rejects missing subtopic', () => {
    const r = validateSpawnChildArgs({ ...valid, subtopic: '' });
    expect('error' in r).toBe(true);
  });

  test('rejects missing taskBrief', () => {
    const r = validateSpawnChildArgs({ ...valid, taskBrief: '   ' });
    expect('error' in r).toBe(true);
  });

  test('rejects taskBrief over 4000 chars', () => {
    const r = validateSpawnChildArgs({ ...valid, taskBrief: 'x'.repeat(4001) });
    expect('error' in r).toBe(true);
  });

  test('rejects unknown expectedOutput.shape', () => {
    const r = validateSpawnChildArgs({ ...valid, expectedOutput: { shape: 'bogus' } });
    expect('error' in r).toBe(true);
  });

  test('rejects invalid role (no silent fallback to general)', () => {
    // Both role AND topic fail to resolve to a valid AgentRole.
    const r = validateSpawnChildArgs({
      ...valid,
      topic: 'not-a-role-name',
      role: 'not_a_role',
    });
    expect('error' in r).toBe(true);
  });

  test('infers role from topic when role is missing and topic matches an AgentRole', () => {
    const r = validateSpawnChildArgs({ ...valid, topic: 'security', role: undefined });
    expect('params' in r).toBe(true);
    if ('params' in r) {
      expect(r.params.role).toBe('security');
    }
  });

  test('passes through valid role', () => {
    const r = validateSpawnChildArgs({ ...valid, role: 'security' });
    if ('params' in r) {
      expect(r.params.role).toBe('security');
    }
  });

  test('accepts explicit maxTokens override', () => {
    const r = validateSpawnChildArgs({
      ...valid,
      expectedOutput: { shape: 'markdown', maxTokens: 500 },
    });
    if ('params' in r) {
      expect(r.params.expectedOutput.maxTokens).toBe(500);
    }
  });
});

// ── formatChildResult ────────────────────────────────────────────────

describe('formatChildResult', () => {
  test('wraps output in ChildResult envelope with metadata', () => {
    const r: ChildResult = {
      nodeId: 'abc',
      kind: 'agent',
      status: 'ok',
      output: 'the answer',
      usedTokens: 123,
      durationMs: 4567,
      spawnedChildren: [],
    };
    const s = formatChildResult(r);
    expect(s).toContain('<ChildResult');
    expect(s).toContain('nodeId="abc"');
    expect(s).toContain('status="ok"');
    expect(s).toContain('tokens="123"');
    expect(s).toContain('durationMs="4567"');
    expect(s).toContain('<output>the answer</output>');
  });

  test('serializes non-string output as JSON', () => {
    const r: ChildResult = {
      nodeId: 'n1',
      kind: 'agent',
      status: 'ok',
      output: { foo: 'bar' },
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
    };
    const s = formatChildResult(r);
    expect(s).toContain('{"foo":"bar"}');
  });

  test('appends notes when present', () => {
    const r: ChildResult = {
      nodeId: 'n2',
      kind: 'agent',
      status: 'timeout',
      output: '',
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
      notes: 'child exceeded wall-clock',
    };
    expect(formatChildResult(r)).toContain('<notes>child exceeded wall-clock</notes>');
  });
});

// ── parent awaits result, result converted to tool-result string ─────

describe('createSpawnChildTool', () => {
  function makeParent(): AgentNode {
    return {
      id: 'parent-1',
      rootSessionId: '00000000-0000-0000-0000-000000000000',
      parentNodeId: null,
      kind: 'orchestrator',
      depth: 0,
      role: 'orchestrator',
      topicPath: 'root',
      model: 'test-model',
      budget: {
        tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 },
        wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() },
        fanOut: { cap: LEVEL_DEFAULT[0].fanOut, used: 0 },
        depth: 0,
      },
      allowedToolIds: new Set(['read_file']),
      signal: new AbortController().signal,
    };
  }

  test('invalid params return an error string (no spawn attempted)', async () => {
    const parent = makeParent();
    // Stub spawner — should never be invoked when validation fails.
    const spawner = {
      spawnChild: async () => {
        throw new Error('should not be called');
      },
    } as unknown as SwarmSpawner;
    const tool = createSpawnChildTool(parent, spawner);

    const result = await tool.execute(
      { topic: 'security', subtopic: 'x' /* missing taskBrief + expectedOutput */ },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'orchestrator', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(typeof result).toBe('string');
    expect(String(result)).toContain('spawn_child:');
  });

  test('passes validated params to spawner and marshals result via formatChildResult', async () => {
    const parent = makeParent();
    let received: Record<string, unknown> | null = null;
    const stubResult: ChildResult = {
      nodeId: 'child-1',
      kind: 'agent',
      status: 'ok',
      output: 'ok done',
      usedTokens: 42,
      durationMs: 99,
      spawnedChildren: [],
    };
    const spawner = {
      spawnChild: async (_p: AgentNode, params: Record<string, unknown>) => {
        received = params;
        return stubResult;
      },
    } as unknown as SwarmSpawner;

    const tool = createSpawnChildTool(parent, spawner);
    const out = await tool.execute(
      {
        topic: 'security',
        subtopic: 'oauth',
        taskBrief: 'Review the flow.',
        expectedOutput: { shape: 'summary' },
      },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'orchestrator', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(received).not.toBeNull();
    expect((received as any).topic).toBe('security');
    expect(String(out)).toContain('<ChildResult');
    expect(String(out)).toContain('nodeId="child-1"');
    expect(String(out)).toContain('status="ok"');
    expect(String(out)).toContain('<output>ok done</output>');
  });

  test('spawn_child is NOT final — allows multiple calls per turn', () => {
    const parent = makeParent();
    const tool = createSpawnChildTool(parent);
    expect(tool.final).toBe(false);
    expect(tool.name).toBe('spawn_child');
  });
});
