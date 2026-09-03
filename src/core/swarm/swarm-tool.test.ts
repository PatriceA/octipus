import { describe, expect, test } from 'vitest';
import { applyRoleFit, validateSpawnChildArgs, formatChildResult, createSpawnChildTool, buildSpawnRoleCatalog, buildDelegationGuidance, parsePlan, MAX_PLAN_STEPS, SPAWN_CHILD_ROLES } from './swarm-tool';
import { LEVEL_DEFAULT, type AgentNode, type ChildResult } from './types';
import { SwarmSpawner } from './spawner';

// ── buildSpawnRoleCatalog (depth-1 subagent discoverability) ─────────

describe('buildSpawnRoleCatalog', () => {
  test('lists every spawnable role with a non-empty blurb', () => {
    const catalog = buildSpawnRoleCatalog();
    const lines = catalog.split('\n');
    // One line per spawnable role, none left as an undefined blurb.
    expect(lines.length).toBe(SPAWN_CHILD_ROLES.length);
    for (const role of SPAWN_CHILD_ROLES) {
      const line = lines.find((l) => l.startsWith(`- ${role} — `));
      expect(line).toBeDefined();
      expect(line).not.toContain('undefined');
      expect((line as string).length).toBeGreaterThan(`- ${role} — `.length);
    }
  });
});

describe('buildDelegationGuidance', () => {
  test('carries the policy + mechanics + role catalog for depth-1 agents', () => {
    const g = buildDelegationGuidance();
    expect(g).toContain('DELEGATION POLICY');
    expect(g).toContain('HOW SPAWNING WORKS');
    // Includes the spawnable-role catalog so the agent knows what it can spawn.
    expect(g).toContain(buildSpawnRoleCatalog());
  });

  test('says a missing tool is a reason to spawn, not a reason to decline', () => {
    // Measured on the live bench: a root agent holding only `profiles`
    // answered a knowledge-base question with "Octipus has no vector store
    // configured and no knowledge-base search tool mounted" — a claim about the
    // PRODUCT drawn from its own toolset, with a `research` specialist one
    // spawn away that has exactly that tool.
    const g = buildDelegationGuidance();
    expect(g).toMatch(/tool you do NOT hold/i);
    expect(g).toMatch(/never tell the user a capability is missing/i);
  });
});

// ── applyRoleFit (Phase 2.6 deterministic role-fit) ──────────────────

describe('applyRoleFit', () => {
  // The rewrite is a SMALL-root agent workaround, so every case below passes
  // `true`. Its behaviour for a capable root agent is the separate block
  // underneath, and it is the opposite: the model's own choice stands.
  test('rewrites an advisory role to coding when the task classifies coding-like', () => {
    const fit = applyRoleFit('architecture', 'implement the feature and fix the bug in the backend code', true);
    expect(fit.role).toBe('coding');
    expect(fit.rewrittenFrom).toBe('architecture');
  });

  test('rewrites review → coding for a hands-on coding task', () => {
    const fit = applyRoleFit('review', 'refactor the module and add a unit test for the new function', true);
    expect(fit.role).toBe('coding');
    expect(fit.rewrittenFrom).toBe('review');
  });

  test('leaves an advisory role untouched for a genuine advisory task', () => {
    const fit = applyRoleFit('architecture', 'design the system architecture and write an architecture decision record', true);
    expect(fit.role).toBe('architecture');
    expect(fit.rewrittenFrom).toBeUndefined();
  });

  test('never touches a non-advisory role', () => {
    const fit = applyRoleFit('coding', 'implement and fix the bug', true);
    expect(fit.role).toBe('coding');
    expect(fit.rewrittenFrom).toBeUndefined();
  });
});

describe('applyRoleFit — a capable rootAgent keeps its own choice', () => {
  // The exact task text that IS rewritten for a small root agent above. A
  // capable model read the whole request before picking `architecture`;
  // replacing that with a keyword table's read of the brief alone is the
  // inversion this gate exists to stop.
  const codingLike = 'implement the feature and fix the bug in the backend code';

  test('no rewrite when the rootAgent is not small', () => {
    const fit = applyRoleFit('architecture', codingLike, false);
    expect(fit.role).toBe('architecture');
    expect(fit.rewrittenFrom).toBeUndefined();
  });

  test('an unspecified caller is treated as capable, not as small', () => {
    const fit = applyRoleFit('architecture', codingLike);
    expect(fit.role).toBe('architecture');
    expect(fit.rewrittenFrom).toBeUndefined();
  });
});

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

  test('renders the deterministic receipt so the parent can audit ground truth', () => {
    const r: ChildResult = {
      nodeId: 'n-r',
      kind: 'agent',
      status: 'ok',
      output: 'I edited the files and ran the tests',
      usedTokens: 10,
      durationMs: 20,
      spawnedChildren: [],
      receipt: {
        schemaVersion: 1,
        nodeId: 'n-r',
        kind: 'agent',
        status: 'ok',
        sideEffects: {
          toolCalls: 5, filesChanged: 0, commandsRun: 0, approvalsRequired: 0,
          approvalsDenied: 0, autoApproved: 0, permissionDenials: 2, toolErrors: 1,
          byName: { read_file: 5 },
        },
        tokens: { used: 10, cap: 1000 },
        durationMs: 20,
        unavailable: [],
        notCertified: [],
      },
    };
    const s = formatChildResult(r);
    // Child claims it edited files, but the receipt says filesChanged=0 — the
    // parent can now catch the discrepancy without re-reading the transcript.
    expect(s).toContain('<receipt');
    expect(s).toContain('filesChanged="0"');
    expect(s).toContain('toolErrors="1"');
    expect(s).toContain('denials="2"');
  });

  test('omits the receipt block when there is no receipt (no worker ran)', () => {
    const r: ChildResult = {
      nodeId: 'n-nr', kind: 'agent', status: 'denied', output: '',
      usedTokens: 0, durationMs: 0, spawnedChildren: [],
    };
    expect(formatChildResult(r)).not.toContain('<receipt');
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

  test('surfaces a failed scorer outcome in a <scorers> block', () => {
    const r: ChildResult = {
      nodeId: 'n3',
      kind: 'agent',
      status: 'contract_failed',
      output: 'partial',
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
      scorerOutcome: {
        passed: false,
        ran: 1,
        failures: [{ scorer: 'contains(output)', reason: 'output does not contain "DONE"' }],
      },
    };
    const s = formatChildResult(r);
    expect(s).toContain('status="contract_failed"');
    expect(s).toContain('<scorers passed="false">');
    expect(s).toContain('contains(output): output does not contain "DONE"');
  });

  test('omits the <scorers> block when scorers passed', () => {
    const r: ChildResult = {
      nodeId: 'n4',
      kind: 'agent',
      status: 'ok',
      output: 'DONE',
      usedTokens: 0,
      durationMs: 0,
      spawnedChildren: [],
      scorerOutcome: { passed: true, ran: 1, failures: [] },
    };
    expect(formatChildResult(r)).not.toContain('<scorers');
  });
});

describe('validateSpawnChildArgs — scorers', () => {
  const base = {
    topic: 'qa',
    subtopic: 'verify',
    taskBrief: 'Produce a report.',
    expectedOutput: { shape: 'markdown' },
  };

  test('parses valid scorers onto params', () => {
    const r = validateSpawnChildArgs({
      ...base,
      scorers: [{ kind: 'non_empty' }, { kind: 'file_exists', path: 'report.md' }],
    });
    expect('params' in r).toBe(true);
    if ('params' in r) {
      expect(r.params.scorers).toHaveLength(2);
      expect(r.params.scorers?.[0]).toEqual({ kind: 'non_empty' });
    }
  });

  test('omits scorers entirely when none are provided', () => {
    const r = validateSpawnChildArgs(base);
    expect('params' in r).toBe(true);
    if ('params' in r) expect(r.params.scorers).toBeUndefined();
  });

  test('rejects a malformed scorer spec loudly', () => {
    const r = validateSpawnChildArgs({ ...base, scorers: [{ kind: 'regex' }] });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toContain('invalid scorers');
  });
});

// ── parent awaits result, result converted to tool-result string ─────

describe('createSpawnChildTool', () => {
  function makeParent(): AgentNode {
    return {
      id: 'parent-1',
      rootSessionId: '00000000-0000-0000-0000-000000000000',
      parentNodeId: null,
      kind: 'root',
      depth: 0,
      role: 'general',
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
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    expect(typeof result).toBe('string');
    expect(String(result)).toContain('spawn_child:');
  });

  // Reachability, not behaviour. The role-fit rewrite is a LITE-root agent
  // workaround, and it can only fire if the resolved tier actually arrives at
  // the spawner. A first attempt gated it on the ROUTER threshold, which made
  // it dead code in every path that reaches `spawnChild` at all — router mode
  // never gets here, it short-circuits into `runRouterTurn`.
  async function spawnAndCaptureInternal(opts?: { lite?: boolean; weakModel?: boolean }) {
    let internal: Record<string, unknown> | undefined;
    const spawner = {
      spawnChild: async (
        _p: AgentNode,
        _params: Record<string, unknown>,
        _ctx: unknown,
        received?: Record<string, unknown>,
      ) => {
        internal = received;
        return {
          nodeId: 'c', kind: 'agent', status: 'ok', output: 'x',
          usedTokens: 0, durationMs: 0, spawnedChildren: [],
        } as ChildResult;
      },
    } as unknown as SwarmSpawner;
    await createSpawnChildTool(makeParent(), spawner, undefined, opts).execute(
      { topic: 'security', subtopic: 'oauth', taskBrief: 'Review the flow.', expectedOutput: { shape: 'summary' } },
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
    );
    return internal;
  }

  test('a lite rootAgent reaches the spawner as lite', async () => {
    expect((await spawnAndCaptureInternal({ lite: true }))?.rootIsLite).toBe(true);
  });

  test('a full rootAgent reaches the spawner as not-lite', async () => {
    expect((await spawnAndCaptureInternal())?.rootIsLite).toBe(false);
  });

  // A stage worker or a depth-1 agent on a small local model is equally unable
  // to hold the role choice, but keeps its full spawn schema — so it sets
  // `weakModel` alone. Gating on `lite` left the rewrite live at exactly one
  // call site out of three.
  test('a weak-model spawner reaches the spawner as lite without taking the lite schema', async () => {
    expect((await spawnAndCaptureInternal({ weakModel: true }))?.rootIsLite).toBe(true);
  });

  test('weakModel:false is not overridden by anything', async () => {
    expect((await spawnAndCaptureInternal({ weakModel: false }))?.rootIsLite).toBe(false);
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
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
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

  test('detach mode: accepted at depth 0 (rootAgent can detach-spawn agents — phase 1 freedom)', async () => {
    const parent = makeParent(); // depth 0 (rootAgent)
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
      // Mirrors LEVEL_DEFAULT[0].maxPendingDetached after the root agent
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
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
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
      { id: 'ctx', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'u', model: '', topic: '', role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} },
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

// ── plan (Phase 1: explicit planner→executor plan) ───────────────────

describe('parsePlan', () => {
  test('treats missing/null as no plan (lenient — providers drop nested params)', () => {
    expect(parsePlan(undefined)).toEqual({});
    expect(parsePlan(null)).toEqual({});
  });

  test('parses a well-formed plan and trims fields', () => {
    const r = parsePlan([
      { action: '  find callers  ', tool: ' grep ', expect: ' a list ' },
      { action: 'summarize' },
    ]);
    expect(r).toEqual({
      plan: [
        { action: 'find callers', tool: 'grep', expect: 'a list' },
        { action: 'summarize', tool: undefined, expect: undefined },
      ],
    });
  });

  test('empty array yields no plan (undefined), not an empty plan', () => {
    expect(parsePlan([])).toEqual({ plan: undefined });
  });

  test('rejects a non-array plan', () => {
    expect(parsePlan('do a thing')).toEqual({ error: expect.stringContaining('array') });
  });

  test('rejects a step missing action (loud, so the LLM fixes it)', () => {
    const r = parsePlan([{ tool: 'grep' }]);
    expect('error' in r && r.error).toContain('plan[0].action');
  });

  test('rejects a runaway plan over the step cap', () => {
    const runaway = Array.from({ length: MAX_PLAN_STEPS + 1 }, () => ({ action: 'step' }));
    expect('error' in parsePlan(runaway)).toBe(true);
    const atCap = Array.from({ length: MAX_PLAN_STEPS }, () => ({ action: 'step' }));
    expect('plan' in parsePlan(atCap)).toBe(true);
  });
});

describe('validateSpawnChildArgs plan handling', () => {
  const valid = {
    topic: 'coding',
    subtopic: 'refactor',
    taskBrief: 'Do the thing.',
    expectedOutput: { shape: 'summary' },
  };

  test('round-trips a plan into params', () => {
    const r = validateSpawnChildArgs({
      ...valid,
      plan: [{ action: 'read file', tool: 'read' }, { action: 'edit file', tool: 'edit' }],
    });
    expect('params' in r).toBe(true);
    if ('params' in r) {
      expect(r.params.plan).toEqual([
        { action: 'read file', tool: 'read', expect: undefined },
        { action: 'edit file', tool: 'edit', expect: undefined },
      ]);
    }
  });

  test('leaves plan undefined when omitted', () => {
    const r = validateSpawnChildArgs(valid);
    expect('params' in r && r.params.plan).toBeUndefined();
  });

  test('rejects a malformed plan loud', () => {
    const r = validateSpawnChildArgs({ ...valid, plan: [{ tool: 'grep' }] });
    expect('error' in r && r.error).toContain('invalid plan');
  });
});
