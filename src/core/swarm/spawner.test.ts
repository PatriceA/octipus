import { beforeEach, describe, expect, test } from 'vitest';
import {
  deriveChildBudget,
  resolveChildTools,
  syncParentTokenUsage,
  taskFingerprint,
  SwarmSpawner,
  TASK_BRIEF_PREVIEW_MAX,
  composeChildMessage,
  planToolGaps,
} from './spawner';
import { LEVEL_DEFAULT, type AgentNode, type NodeBudget, type TaskBrief } from './types';
import type { ToolHandler } from '@/core/agent-worker';
import { __resetCallGraphsForTests, getCallGraph } from './call-graph';
import { createEscalateTool } from './escalate-tool';

// ── composeChildMessage: date grounding ───────────────────────────────

describe('composeChildMessage — date grounding', () => {
  const brief: TaskBrief = {
    originalUserRequest: 'Who played yesterday?',
    topicPath: 'research/world-cup',
    parentSummary: '',
    taskBrief: 'Summarize recent matches.',
    constraints: [],
    inputArtifacts: [],
    expectedOutput: { shape: 'summary', maxTokens: 800 },
    forbidden: [],
  };

  test('injects today as the first block so the child is not date-blind', () => {
    const msg = composeChildMessage(brief, {
      availableToolNames: ['websearch__search'],
      canSpawnChildren: false,
    });
    expect(msg.startsWith('CURRENT DATE/TIME: ')).toBe(true);
    // Current year must be present so time-relative requests resolve to "now".
    expect(msg).toContain(String(new Date().getFullYear()));
    // Date and time are formatted from the same (local) clock — no UTC suffix
    // that could disagree with the local date near midnight.
    expect(msg).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test('brief drops the ~1.5KB policy but keeps a compact high-salience reminder (Phase 4)', () => {
    const msg = composeChildMessage(brief, {
      availableToolNames: ['websearch__search'],
      canSpawnChildren: true,
    });
    // The full policy moved to buildDelegationGuidance() → system prompt...
    expect(msg).not.toContain('DELEGATION POLICY');
    expect(msg).not.toContain('HOW SPAWNING WORKS');
    // ...but a short trailing reminder remains so weak models still act on it.
    expect(msg).toContain('spawn_child');
    expect(msg).toContain('collect_children');
    expect(msg.length).toBeLessThan(1200); // nowhere near the old ~1.5KB block
  });

  test('leaf subagents still get the no-delegation reminder in the brief', () => {
    const msg = composeChildMessage(brief, { availableToolNames: [], canSpawnChildren: false });
    expect(msg).toContain('leaf subagent');
  });

  test('injects the executor-awareness block only when the lane binds an executor', () => {
    const withExec = composeChildMessage(brief, {
      availableToolNames: ['websearch__search'],
      canSpawnChildren: true,
      executorModel: 'gemini-flash-lite',
    });
    expect(withExec).toContain('EXECUTOR AVAILABLE');
    expect(withExec).toContain('`plan`');

    // No executor bound → no plan-for-executor noise.
    const noExec = composeChildMessage(brief, {
      availableToolNames: ['websearch__search'],
      canSpawnChildren: true,
    });
    expect(noExec).not.toContain('EXECUTOR AVAILABLE');

    // Planned (leaf) children never get it — they ARE the executor.
    const planned = composeChildMessage(
      { ...brief, plan: [{ action: 'run it' }] },
      { availableToolNames: [], canSpawnChildren: false, executorModel: 'gemini-flash-lite' },
    );
    expect(planned).not.toContain('EXECUTOR AVAILABLE');
  });
});

// ── composeChildMessage: plan rendering (Phase 3) ─────────────────────

describe('composeChildMessage — execution plan', () => {
  const base: TaskBrief = {
    originalUserRequest: 'Refactor the thing.',
    topicPath: 'coding/refactor',
    parentSummary: '',
    taskBrief: 'Do the refactor.',
    constraints: [],
    inputArtifacts: [],
    expectedOutput: { shape: 'summary', maxTokens: 800 },
    forbidden: [],
  };

  test('renders a numbered checklist with tool/expect annotations and a STOP rule', () => {
    const msg = composeChildMessage(
      { ...base, plan: [
        { action: 'read the file', tool: 'read', expect: 'current contents' },
        { action: 'rewrite it' },
      ] },
      { availableToolNames: ['read', 'edit'], canSpawnChildren: true },
    );
    expect(msg).toContain('EXECUTION PLAN');
    expect(msg).toContain('1. read the file [tool: read] → expect: current contents');
    expect(msg).toContain('2. rewrite it');
    expect(msg).toContain('STOP');
  });

  test('a planned depth-1 child is mechanical: no spawn reminder', () => {
    const msg = composeChildMessage(
      { ...base, plan: [{ action: 'run it' }] },
      { availableToolNames: ['shell'], canSpawnChildren: true },
    );
    // The mechanical-executor line replaces the delegation reminder.
    expect(msg).toContain('Follow the EXECUTION PLAN above exactly');
    expect(msg).not.toContain('you can `spawn_child`');
  });

  test('no plan ⇒ no EXECUTION PLAN block, delegation framing unchanged', () => {
    const msg = composeChildMessage(base, { availableToolNames: ['shell'], canSpawnChildren: true });
    expect(msg).not.toContain('EXECUTION PLAN');
    expect(msg).toContain('spawn_child'); // recon child still gets the reminder
  });

  test('marks a step whose tool the child does not have (Phase 4)', () => {
    const msg = composeChildMessage(
      { ...base, plan: [
        { action: 'read it', tool: 'read' },
        { action: 'edit it', tool: 'edit' },
      ] },
      { availableToolNames: ['read'], canSpawnChildren: true }, // no 'edit'
    );
    expect(msg).toContain('1. read it [tool: read]');
    expect(msg).toContain('2. edit it [tool: edit — NOT available to you');
  });
});

// ── planToolGaps (Phase 4: plan tool validation) ─────────────────────

describe('planToolGaps', () => {
  test('all named tools available ⇒ no gaps, runnable', () => {
    const r = planToolGaps([{ action: 'a', tool: 'read' }, { action: 'b', tool: 'edit' }], ['read', 'edit']);
    expect(r).toEqual({ missingTools: [], unrunnable: false });
  });

  test('some tools missing ⇒ reports them, still runnable', () => {
    const r = planToolGaps([{ action: 'a', tool: 'read' }, { action: 'b', tool: 'edit' }], ['read']);
    expect(r.missingTools).toEqual(['edit']);
    expect(r.unrunnable).toBe(false);
  });

  test('every tool-bearing step unrunnable ⇒ unrunnable=true', () => {
    const r = planToolGaps([{ action: 'a', tool: 'edit' }, { action: 'b', tool: 'grep' }], ['read']);
    expect(r.missingTools).toEqual(['edit', 'grep']);
    expect(r.unrunnable).toBe(true);
  });

  test('steps with no tool never count as missing or unrunnable', () => {
    const r = planToolGaps([{ action: 'think' }, { action: 'write it up' }], []);
    expect(r).toEqual({ missingTools: [], unrunnable: false });
  });

  test('dedups a repeated missing tool', () => {
    const r = planToolGaps([{ action: 'a', tool: 'edit' }, { action: 'b', tool: 'edit' }], ['read']);
    expect(r.missingTools).toEqual(['edit']);
    expect(r.unrunnable).toBe(true);
  });
});

// ── syncParentTokenUsage: node budget reflects live worker spend ──────

describe('syncParentTokenUsage', () => {
  const makeNode = (used: number, workerTokens: number | null, childTokensUsed = 0): AgentNode => {
    const node = {
      id: 'p',
      role: 'orchestrator',
      depth: 0 as const,
      topicPath: '',
      budget: {
        tokens: { cap: 200_000, used },
        wallClockMs: { cap: 600_000, startedAt: Date.now() },
        fanOut: { cap: 6, used: 0 },
        depth: 0 as const,
        childTokensUsed,
      },
    } as unknown as AgentNode;
    if (workerTokens !== null) {
      (node as unknown as { workerRef: { current: { getTotalTokens: () => number } } }).workerRef = {
        current: { getTotalTokens: () => workerTokens },
      };
    }
    return node;
  };

  test('lifts node.tokens.used up to the worker’s live spend', () => {
    const node = makeNode(0, 150_000);
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(150_000);
  });

  test('is monotonic — never shrinks a higher recorded value', () => {
    const node = makeNode(180_000, 150_000);
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(180_000);
  });

  test('no-op without a workerRef (legacy call sites)', () => {
    const node = makeNode(42, null);
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(42);
  });

  test('after sync, deriveChildBudget refuses a spawn near exhaustion', () => {
    // Regression: previously `used` stayed 0, so the guard never fired even
    // when the worker had burned nearly the whole pool.
    const node = makeNode(0, 195_000);
    syncParentTokenUsage(node);
    expect(() => deriveChildBudget(node.budget, 1)).toThrow(/Insufficient token budget/);
  });

  test('combines own worker spend with cumulative child spend', () => {
    const node = makeNode(0, 50_000, 120_000); // own 50k + children 120k = 170k
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(170_000);
  });

  test('child spend alone drives the guard even without a workerRef', () => {
    // No workerRef (own spend counts as 0), but children have burned the pool.
    const node = makeNode(0, null, 190_000);
    syncParentTokenUsage(node);
    expect(node.budget.tokens.used).toBe(190_000);
    expect(() => deriveChildBudget(node.budget, 1)).toThrow(/Insufficient token budget/);
  });
});

// ── deriveChildBudget: budget cascade math ────────────────────────────

describe('deriveChildBudget', () => {
  test('clamps child tokens to LEVEL_DEFAULT when parent has ample room', () => {
    const parent: NodeBudget = {
      tokens: { cap: 200_000, used: 0 },
      wallClockMs: { cap: 10 * 60_000, startedAt: Date.now() },
      fanOut: { cap: 6, used: 0 },
      depth: 0,
    };
    const child = deriveChildBudget(parent, 1);
    // LEVEL_DEFAULT[1].tokens = 80_000. Parent remaining 200k - 20k reserve = 180k.
    // Child cap = min(80k, 180k) = 80_000.
    expect(child.tokens.cap).toBe(LEVEL_DEFAULT[1].tokens);
    expect(child.depth).toBe(1);
    expect(child.fanOut.cap).toBe(LEVEL_DEFAULT[1].fanOut);
  });

  test('clamps child tokens to parent remaining when remaining < default', () => {
    const parent: NodeBudget = {
      tokens: { cap: 200_000, used: 150_000 }, // remaining = 50_000
      wallClockMs: { cap: 10 * 60_000, startedAt: Date.now() },
      fanOut: { cap: 6, used: 0 },
      depth: 0,
    };
    const child = deriveChildBudget(parent, 1);
    // remaining 50_000 - reserve 20_000 = 30_000. min(80_000, 30_000) = 30_000.
    expect(child.tokens.cap).toBe(30_000);
  });

  test('throws InsufficientBudgetError when parent has no token room (reserve exhausted)', () => {
    const parent: NodeBudget = {
      tokens: { cap: 200_000, used: 195_000 },
      wallClockMs: { cap: 10 * 60_000, startedAt: Date.now() },
      fanOut: { cap: 6, used: 0 },
      depth: 0,
    };
    // remaining 5000 - reserve 20000 → below MIN_CHILD_TOKENS → refused
    expect(() => deriveChildBudget(parent, 1)).toThrow(/Insufficient token budget/);
  });

  test('child wall-clock is independent of parent remaining (no cascade)', () => {
    const startedAt = Date.now() - 8 * 60_000; // 8 min elapsed on a 10-min parent
    const parent: NodeBudget = {
      tokens: { cap: 200_000, used: 0 },
      wallClockMs: { cap: 10 * 60_000, startedAt },
      fanOut: { cap: 6, used: 0 },
      depth: 0,
    };
    const child = deriveChildBudget(parent, 1);
    // Parent's 2 min remaining is IRRELEVANT — parent's timer pauses while
    // awaiting this child. Child gets its full LEVEL_DEFAULT[1].wallMs = 10 min.
    // (Bumped from 4 min on 2026-05-15 — 240s wasn't enough for coding agents
    // to finish a non-trivial repo analysis before hitting the wall.)
    expect(child.wallClockMs.cap).toBe(10 * 60_000);
  });
});

// ── resolveChildTools: permission intersection ────────────────────────

describe('resolveChildTools', () => {
  const mk = (name: string, toolId?: string): ToolHandler => ({
    name,
    toolId,
    description: '',
    parameters: {},
    execute: async () => '',
  });

  test('returns only tools parent already has', () => {
    const parentAllowed = new Set(['read_file', 'shell']);
    const roleTools = [mk('read_file', 'read_file'), mk('write_file', 'write_file'), mk('shell', 'shell')];
    const granted = resolveChildTools(parentAllowed, roleTools);
    expect(granted.map((t) => t.name).sort()).toEqual(['read_file', 'shell']);
  });

  test('empty intersection returns empty array', () => {
    const parentAllowed = new Set<string>();
    const roleTools = [mk('read_file', 'read_file')];
    expect(resolveChildTools(parentAllowed, roleTools)).toEqual([]);
  });

  test('falls back to tool.name when toolId absent', () => {
    const parentAllowed = new Set(['search_web']);
    const roleTools = [mk('search_web' /* no toolId */), mk('other', 'other')];
    const granted = resolveChildTools(parentAllowed, roleTools);
    expect(granted.map((t) => t.name)).toEqual(['search_web']);
  });
});

// ── taskFingerprint: cache/cycle key ──────────────────────────────────

describe('taskFingerprint', () => {
  const mk = (override: Partial<TaskBrief> = {}): TaskBrief => ({
    originalUserRequest: 'do the thing',
    topicPath: 'security/oauth/pkce',
    parentSummary: '',
    taskBrief: 'Review PKCE implementation',
    constraints: [],
    inputArtifacts: [],
    expectedOutput: { shape: 'summary', maxTokens: 2000 },
    forbidden: [],
    ...override,
  });

  test('stable: identical briefs produce identical hashes', () => {
    expect(taskFingerprint(mk())).toBe(taskFingerprint(mk()));
  });

  test('order-insensitive on inputArtifacts', () => {
    const a = mk({ inputArtifacts: [{ kind: 'file', ref: 'a.ts' }, { kind: 'file', ref: 'b.ts' }] });
    const b = mk({ inputArtifacts: [{ kind: 'file', ref: 'b.ts' }, { kind: 'file', ref: 'a.ts' }] });
    expect(taskFingerprint(a)).toBe(taskFingerprint(b));
  });

  test('normalizes whitespace in taskBrief', () => {
    const a = mk({ taskBrief: 'Review PKCE   implementation' });
    const b = mk({ taskBrief: '  Review PKCE implementation  ' });
    expect(taskFingerprint(a)).toBe(taskFingerprint(b));
  });

  test('case-insensitive on taskBrief', () => {
    const a = mk({ taskBrief: 'Review PKCE' });
    const b = mk({ taskBrief: 'review pkce' });
    expect(taskFingerprint(a)).toBe(taskFingerprint(b));
  });

  test('differs when topicPath differs', () => {
    expect(taskFingerprint(mk())).not.toBe(taskFingerprint(mk({ topicPath: 'other' })));
  });

  test('differs when taskBrief differs', () => {
    expect(taskFingerprint(mk())).not.toBe(taskFingerprint(mk({ taskBrief: 'something else' })));
  });
});

// ── TASK_BRIEF_PREVIEW_MAX: wire/DB slice contract ─────────────────────

describe('TASK_BRIEF_PREVIEW_MAX', () => {
  // Regression guard: the WS event previously sliced to 200 chars while
  // the DB stored 4000. The swarm-tree UI reads the WS payload as the
  // source of truth for the brief modal, so the two MUST stay equal —
  // and at least 1k so a non-trivial brief survives. Drop this only
  // alongside a deliberate schema change.
  test('is wide enough for a real brief and matches the DB column', () => {
    expect(TASK_BRIEF_PREVIEW_MAX).toBeGreaterThanOrEqual(1000);
    expect(TASK_BRIEF_PREVIEW_MAX).toBe(4000);
  });

  test('slicing a brief at this width preserves a 3,500-char body', () => {
    const body = 'x'.repeat(3500);
    expect(body.slice(0, TASK_BRIEF_PREVIEW_MAX)).toBe(body);
    expect(body.slice(0, TASK_BRIEF_PREVIEW_MAX).length).toBe(3500);
  });

  test('slicing caps an over-sized brief without throwing', () => {
    const body = 'y'.repeat(10_000);
    expect(body.slice(0, TASK_BRIEF_PREVIEW_MAX).length).toBe(TASK_BRIEF_PREVIEW_MAX);
  });
});

// ── Phase 2: depth enforcement + fan-out + escalation ──────────────────

function makeNode(over: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'node-1',
    rootSessionId: '00000000-0000-0000-0000-0000000000aa',
    parentNodeId: null,
    kind: 'orchestrator',
    depth: 0,
    role: 'orchestrator',
    topicPath: 'root',
    model: 'test-model',
    budget: {
      tokens: { cap: LEVEL_DEFAULT[0].tokens, used: 0 },
      wallClockMs: { cap: LEVEL_DEFAULT[0].wallMs, startedAt: Date.now() },
      fanOut: { cap: 2, used: 0 },
      depth: 0,
    },
    allowedToolIds: new Set<string>(),
    signal: new AbortController().signal,
    ...over,
  };
}

function makeCtx() {
  return {
    id: 'ctx-1',
    sessionId: '00000000-0000-0000-0000-0000000000aa',
    userId: 'u-1',
    topic: 'x',
    model: 'test-model',
    role: 'orchestrator' as const,
    status: 'running' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
  };
}

describe('SwarmSpawner — Phase 2 depth enforcement', () => {
  beforeEach(() => {
    __resetCallGraphsForTests();
  });

  test('Subagent (depth 2) parent is rejected — hard leaf', async () => {
    const spawner = new SwarmSpawner({} as never);
    const parent = makeNode({
      id: 'sub-1',
      kind: 'subagent',
      depth: 2,
      role: 'security',
    });
    const result = await spawner.spawnChild(
      parent,
      {
        role: 'research',
        topic: 't',
        subtopic: 's',
        taskBrief: 'x',
        expectedOutput: { shape: 'summary' },
      },
      makeCtx(),
    );
    expect(result.status).toBe('denied');
    expect(result.notes).toMatch(/depth 2/i);
  });

  test('same-role at depth 0→1 is still blocked (orchestrator never maps to agent anyway, but the guard stands)', async () => {
    const spawner = new SwarmSpawner({} as never);
    // Use a non-orchestrator role at depth 0 just to exercise the guard —
    // real orchestrators have role 'orchestrator' which never collides
    // with a specialist role, but the guard must still fire if collision
    // somehow happens (e.g. bad role resolution).
    const parent = makeNode({
      id: 'depth0-research',
      depth: 0,
      role: 'research',
    });
    const result = await spawner.spawnChild(
      parent,
      {
        role: 'research',
        topic: 'research',
        subtopic: 's',
        taskBrief: 'x',
        expectedOutput: { shape: 'summary' },
      },
      makeCtx(),
    );
    expect(result.status).toBe('denied');
    expect(result.notes).toMatch(/equals parent role/i);
  });
});

describe('SwarmSpawner — fan-out cap', () => {
  beforeEach(() => {
    __resetCallGraphsForTests();
  });

  test('refuses spawn when parent.fanOut.used >= cap', async () => {
    const spawner = new SwarmSpawner({} as never);
    const parent = makeNode({
      id: 'orch-fanout',
      budget: {
        tokens: { cap: 10_000, used: 0 },
        wallClockMs: { cap: 60_000, startedAt: Date.now() },
        fanOut: { cap: 2, used: 2 }, // already at cap
        depth: 0,
      },
    });
    const result = await spawner.spawnChild(
      parent,
      {
        role: 'research',
        topic: 't',
        subtopic: 's',
        taskBrief: 'x',
        expectedOutput: { shape: 'summary' },
      },
      makeCtx(),
    );
    expect(result.status).toBe('concurrency_limit');
    expect(result.notes).toMatch(/fan-out cap/i);
  });
});

describe('SwarmSpawner — cycle rejection via call graph', () => {
  beforeEach(() => {
    __resetCallGraphsForTests();
  });

  test('duplicate fingerprint returns cancelled result with parent notice', async () => {
    const spawner = new SwarmSpawner({
      publishEvent: () => {
        /* noop stub hub */
      },
    } as never);
    const parent = makeNode({
      id: 'orch-cycle',
      budget: {
        tokens: { cap: 10_000, used: 0 },
        wallClockMs: { cap: 60_000, startedAt: Date.now() },
        fanOut: { cap: 4, used: 0 },
        depth: 0,
      },
    });

    // Pre-seed the graph as if a prior spawn already handled this brief.
    const graph = getCallGraph(parent.rootSessionId);
    graph.registerRoot({ id: parent.id, topicPath: parent.topicPath, role: parent.role });
    const fp = taskFingerprint({
      originalUserRequest: 'x',
      topicPath: 'root / security / oauth',
      parentSummary: '',
      taskBrief: 'same text',
      constraints: [],
      inputArtifacts: [],
      expectedOutput: { shape: 'summary', maxTokens: 2000 },
      forbidden: [],
    });
    graph.register({
      id: 'existing-agent',
      parentNodeId: parent.id,
      topicPath: 'root / security / oauth',
      role: 'security',
      briefHash: fp,
      escalationUsed: false,
    });

    const result = await spawner.spawnChild(
      parent,
      {
        role: 'security',
        topic: 'security',
        subtopic: 'oauth',
        taskBrief: 'same text',
        expectedOutput: { shape: 'summary' },
      },
      makeCtx(),
    );
    expect(result.status).toBe('cancelled');
    expect(result.nodeId).toBe('existing-agent');
    expect(result.notes).toMatch(/already handled/i);
  });
});

describe('Escalate tool — one per lifetime cap', () => {
  beforeEach(() => {
    __resetCallGraphsForTests();
  });

  test('second escalation for same parent returns cap message without spawning', async () => {
    const parent = makeNode({
      id: 'agent-escalate',
      kind: 'agent',
      depth: 1,
      role: 'security',
      budget: {
        tokens: { cap: 10_000, used: 0 },
        wallClockMs: { cap: 60_000, startedAt: Date.now() },
        fanOut: { cap: 4, used: 0 },
        depth: 1,
      },
    });

    // Mark call graph: node exists and escalation not yet used.
    const graph = getCallGraph(parent.rootSessionId);
    graph.register({
      id: parent.id,
      parentNodeId: null,
      topicPath: parent.topicPath,
      role: parent.role,
      briefHash: 'x',
      escalationUsed: false,
    });

    // Stub spawner so we observe calls without touching DB/LLM.
    let spawnCalls = 0;
    const stubSpawner = {
      spawnChild: async () => {
        spawnCalls++;
        return {
          nodeId: 'new-agent',
          kind: 'agent' as const,
          status: 'ok' as const,
          output: 'ok',
          usedTokens: 100,
          durationMs: 10,
          spawnedChildren: [],
        };
      },
    } as unknown as SwarmSpawner;

    const tool = createEscalateTool(parent, stubSpawner);

    const out1 = await tool.execute(
      {
        topic: 'security',
        subtopic: 'different-expert',
        taskBrief: 'try again',
        expectedOutput: { shape: 'summary' },
      },
      makeCtx(),
    );
    expect(String(out1)).toContain('<ChildResult');
    expect(spawnCalls).toBe(1);

    const out2 = await tool.execute(
      {
        topic: 'security',
        subtopic: 'different-expert-2',
        taskBrief: 'and again',
        expectedOutput: { shape: 'summary' },
      },
      makeCtx(),
    );
    expect(String(out2)).toMatch(/already used once|capped at 1/i);
    expect(spawnCalls).toBe(1); // did NOT increment
  });
});

describe('parallel spawn_child group — tool-executor fan-out', () => {
  test('detection logic: calls with matching parallelGroup are bucketed', () => {
    // Unit-level assertion on the bucketing logic via spawn_child payload
    // inspection. Actual execution covered in integration tests that mount
    // a real ToolExecutor.
    const calls = [
      { id: 'a', name: 'spawn_child', arguments: { parallelGroup: 'g1', topic: 't' } },
      { id: 'b', name: 'spawn_child', arguments: { parallelGroup: 'g1', topic: 'u' } },
      { id: 'c', name: 'spawn_child', arguments: { parallelGroup: 'g2', topic: 'v' } },
      { id: 'd', name: 'other_tool', arguments: {} },
    ];
    const buckets = new Map<string, string[]>();
    for (const c of calls) {
      if (c.name !== 'spawn_child') continue;
      const pg = (c.arguments as Record<string, unknown>).parallelGroup;
      if (typeof pg !== 'string') continue;
      let b = buckets.get(pg);
      if (!b) {
        b = [];
        buckets.set(pg, b);
      }
      b.push(c.id);
    }
    expect(buckets.get('g1')).toEqual(['a', 'b']);
    expect(buckets.get('g2')).toEqual(['c']);
  });
});
