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

  test('defaults subtopic from the topic when omitted (lite-friendly)', () => {
    const r = validateSpawnChildArgs({ ...valid, subtopic: '' });
    expect('params' in r).toBe(true);
    if ('params' in r) {
      // topic 'security' is itself a role, so subtopic falls back to it.
      expect(r.params.subtopic).toBe('security');
    }
  });

  test('lite schema: role + taskBrief only, topic/subtopic synthesized', () => {
    const r = validateSpawnChildArgs({ role: 'coding', taskBrief: 'fix the null deref' });
    expect('params' in r).toBe(true);
    if ('params' in r) {
      expect(r.params.role).toBe('coding');
      expect(r.params.topic).toBe('coding');
      expect(r.params.subtopic).toBe('coding');
      expect(r.params.expectedOutput.shape).toBe('summary');
    }
  });

  test('lite schema: rejects when role is missing and topic cannot resolve', () => {
    const r = validateSpawnChildArgs({ taskBrief: 'do something' });
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

  test('defaults expectedOutput when the LLM omits it', () => {
    const { expectedOutput: _drop, ...noEO } = valid;
    const r = validateSpawnChildArgs(noEO);
    expect('params' in r).toBe(true);
    if ('params' in r) {
      expect(r.params.expectedOutput.shape).toBe('summary');
      expect(r.params.expectedOutput.maxTokens).toBe(2000);
    }
  });

  test('defaults expectedOutput when the LLM sends a non-object', () => {
    const r = validateSpawnChildArgs({ ...valid, expectedOutput: 'summary' });
    expect('params' in r).toBe(true);
    if ('params' in r) {
      expect(r.params.expectedOutput.shape).toBe('summary');
      expect(r.params.expectedOutput.maxTokens).toBe(2000);
    }
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

  // ── Detach-mode behaviour ────────────────────────────────────────────

  function makeAgentParent(): AgentNode {
    return {
      id: 'agent-1',
      rootSessionId: '00000000-0000-0000-0000-000000000000',
      parentNodeId: 'parent-0',
      kind: 'agent',
      depth: 1,
      role: 'research',
      topicPath: 'root/research',
      model: 'test-model',
      budget: {
        tokens: { cap: LEVEL_DEFAULT[1].tokens, used: 0 },
        wallClockMs: { cap: LEVEL_DEFAULT[1].wallMs, startedAt: Date.now() },
        fanOut: { cap: LEVEL_DEFAULT[1].fanOut, used: 0 },
        depth: 1,
      },
      allowedToolIds: new Set(['read_file', 'spawn_child', 'collect_children']),
      signal: new AbortController().signal,
    };
  }

  test('detach mode: records a pending entry and returns synthetic pending result', async () => {
    const parent = makeAgentParent();
    const seen: Array<{ id: string }> = [];
    let count = 0;
    const spawner = {
      spawnChild: async () => ({
        nodeId: 'subagent-real',
        kind: 'subagent' as const,
        status: 'ok' as const,
        output: 'done',
        usedTokens: 10,
        durationMs: 100,
        spawnedChildren: [],
      }),
    } as unknown as SwarmSpawner;
    const tool = createSpawnChildTool(parent, spawner, {
      registerPending: (pc) => { seen.push({ id: pc.childId }); count++; },
      pendingCount: () => count,
      maxPendingDetached: () => 3,
    });
    const out = await tool.execute(
      {
        topic: 'research',
        subtopic: 'page-1',
        taskBrief: 'Summarize source 1',
        expectedOutput: { shape: 'summary' },
        mode: 'detach',
      },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'research', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(seen).toHaveLength(1);
    expect(String(out)).toContain('status="pending"');
    expect(String(out)).toContain('mode="detach"');
  });

  test('detach mode: cap enforcement — 4th spawn rejected', async () => {
    const parent = makeAgentParent();
    let count = 3; // already at cap
    const spawner = {
      spawnChild: async () => { throw new Error('should not be called'); },
    } as unknown as SwarmSpawner;
    const tool = createSpawnChildTool(parent, spawner, {
      registerPending: () => { count++; },
      pendingCount: () => count,
      maxPendingDetached: () => 3,
    });
    const out = await tool.execute(
      {
        topic: 'research',
        subtopic: 'page-4',
        taskBrief: 'Summarize source 4',
        expectedOutput: { shape: 'summary' },
        mode: 'detach',
      },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'research', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(String(out)).toContain('already at max pending detached (3)');
  });

  test('detach mode: accepted at depth 0 (orchestrator can detach-spawn agents — phase 1 freedom)', async () => {
    const parent = makeParent(); // depth 0 (orchestrator)
    const seen: Array<{ id: string }> = [];
    let count = 0;
    const spawner = {
      spawnChild: async () => ({
        nodeId: 'agent-detached',
        kind: 'agent' as const,
        status: 'ok' as const,
        output: 'done',
        usedTokens: 10,
        durationMs: 100,
        spawnedChildren: [],
      }),
    } as unknown as SwarmSpawner;
    const tool = createSpawnChildTool(parent, spawner, {
      registerPending: (pc) => { seen.push({ id: pc.childId }); count++; },
      pendingCount: () => count,
      // Mirrors LEVEL_DEFAULT[0].maxPendingDetached after the orchestrator
      // freedom rework — 0 used to be the value here and blocked detach.
      maxPendingDetached: () => 6,
    });
    const out = await tool.execute(
      {
        topic: 'research',
        subtopic: 'page-1',
        taskBrief: 'brief',
        expectedOutput: { shape: 'summary' },
        mode: 'detach',
      },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'orchestrator', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(seen).toHaveLength(1);
    expect(String(out)).toContain('status="pending"');
    expect(String(out)).toContain('mode="detach"');
  });

  test('zero detach budget falls back to a blocking await (always-detach)', async () => {
    const parent = makeParent(); // depth 0
    let awaitCalled = false;
    const spawner = {
      spawnChild: async () => {
        awaitCalled = true;
        return {
          nodeId: 'n-await', kind: 'agent' as const, status: 'ok' as const,
          output: 'done', usedTokens: 5, durationMs: 10, spawnedChildren: [],
        };
      },
    } as unknown as SwarmSpawner;
    const tool = createSpawnChildTool(parent, spawner, {
      registerPending: () => { throw new Error('should not register a pending child'); },
      pendingCount: () => 0,
      // Deployment / depth with no detach budget: spawn_child awaits instead.
      maxPendingDetached: () => 0,
    });
    const out = await tool.execute(
      {
        topic: 'research',
        subtopic: 'page-1',
        taskBrief: 'brief',
        expectedOutput: { shape: 'summary' },
      },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'orchestrator', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(awaitCalled).toBe(true);
    expect(String(out)).toContain('nodeId="n-await"');
  });

  test('always-detach: spawns detach even without an explicit mode arg', async () => {
    const parent = makeAgentParent();
    let registered = false;
    const spawner = {
      spawnChild: async () => ({
        nodeId: 'sub', kind: 'subagent' as const, status: 'ok' as const,
        output: 'x', usedTokens: 1, durationMs: 1, spawnedChildren: [],
      }),
    } as unknown as SwarmSpawner;
    const tool = createSpawnChildTool(parent, spawner, {
      registerPending: () => { registered = true; },
      pendingCount: () => 0,
      maxPendingDetached: () => 3,
    });
    const out = await tool.execute(
      { topic: 'research', subtopic: 'p', taskBrief: 'b', expectedOutput: { shape: 'summary' } },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'research', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(registered).toBe(true);
    expect(String(out)).toContain('status="pending"');
  });

  test('detach mode without hooks falls back to await (no silent drop)', async () => {
    const parent = makeAgentParent();
    let awaitCalled = false;
    const spawner = {
      spawnChild: async () => {
        awaitCalled = true;
        return {
          nodeId: 'n1', kind: 'subagent' as const, status: 'ok' as const,
          output: 'ok', usedTokens: 5, durationMs: 10, spawnedChildren: [],
        };
      },
    } as unknown as SwarmSpawner;
    // No hooks passed — detach should downgrade to await.
    const tool = createSpawnChildTool(parent, spawner);
    const out = await tool.execute(
      {
        topic: 'research',
        subtopic: 'page-1',
        taskBrief: 'brief',
        expectedOutput: { shape: 'summary' },
        mode: 'detach',
      },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'research', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(awaitCalled).toBe(true);
    expect(String(out)).toContain('nodeId="n1"');
  });
});
