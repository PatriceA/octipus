import { beforeEach, expect, it, vi } from 'vitest';
import { ClassifiedError, FailoverReason, RecoveryAction } from '@/core/errors/classification';
import { QuotaExceededError } from '@/security/quota-error';
import { SpendBudgetExceededError } from '@/security/spend-budget-error';
import type { ChildResult } from './types';

const fixture = vi.hoisted(() => ({
  backup: 'backup', models: [] as string[], runs: [] as string[], error: null as unknown,
  failSpawn: false,
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({
  getBackupModelForTopic: async () => fixture.backup ? { modelId: fixture.backup } : null,
  getModel: async () => null, getModelByModelId: async () => null,
}) }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({
  spawn: async ({ model }: { model: string }) => {
    fixture.models.push(model);
    if (fixture.failSpawn) throw fixture.error;
    const id = `quota-child-${fixture.models.length}`;
    return {
      getContext: () => ({ id }),
      getBillableTokens: () => 10,
      getSideEffectCounters: () => null,
      run: async () => { fixture.runs.push(model); throw fixture.error; },
    };
  },
}) }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => null } }));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: { findById: async () => null } }));
vi.mock('./node-repository', () => ({ swarmNodeRepository: { create: async () => {}, updateStatus: async () => {} } }));
vi.mock('./ledger', () => ({ getSwarmLedger: () => ({ recordSpawn: async () => {}, recordTerminal: async () => {} }) }));

import { SwarmSpawner } from './spawner';
import { __resetCallGraphsForTests } from './call-graph';

beforeEach(() => {
  __resetCallGraphsForTests();
  fixture.models = []; fixture.runs = []; fixture.backup = 'backup'; fixture.failSpawn = false;
  fixture.error = new ClassifiedError({ reason: FailoverReason.QUOTA_EXHAUSTED,
    recovery: RecoveryAction.FALLBACK_PROVIDER, message: 'Quota exhausted for provider' });
});

async function run(): Promise<ChildResult> {
  const spawner = new SwarmSpawner({ publishEvent: () => {} } as never);
  return (spawner as unknown as { runChildWithRetry: (opts: unknown) => Promise<ChildResult> }).runChildWithRetry({
    parent: { id: 'parent', rootSessionId: 'quota-session', signal: new AbortController().signal },
    parentContext: { userId: 'user', sessionId: 'quota-session', metadata: {} },
    childDepth: 2, childKind: 'subagent', childRole: 'coding', childLane: 'build', childModel: 'primary',
    childTools: [], childMessage: 'Implement one change',
    budget: { tokens: { cap: 1000, used: 0 }, wallClockMs: { cap: 60_000, startedAt: Date.now() }, fanOut: { cap: 0, used: 0 }, depth: 2 },
    topicPath: 'coding/change', subtopic: 'change', briefHash: 'quota-brief',
    brief: { taskBrief: 'Implement one change', originalUserRequest: 'Implement one change' },
    reason: 'normal', worktree: null,
  });
}

it('skips primary retries, tries the configured backup once, and accounts for both attempts', async () => {
  const result = await run();
  expect(fixture.models).toEqual(['primary', 'backup']);
  expect(fixture.runs).toEqual(['primary', 'backup']);
  expect(result.status).toBe('provider_error');
  expect(result.usedTokens).toBe(10);
  expect(result.discardedTokens).toBe(10);
});

it.each(['', 'primary'])('does not retry quota exhaustion with backup binding %j', async backup => {
  fixture.backup = backup;
  expect((await run()).status).toBe('provider_error');
  expect(fixture.runs).toEqual(['primary']);
  expect(fixture.models).toEqual(['primary']);
});

it('retains the same-node retry for transient provider failures', async () => {
  fixture.error = new Error('provider overloaded');
  await run();
  expect(fixture.models).toEqual(['primary', 'backup']);
  expect(fixture.runs).toEqual(['primary', 'primary', 'backup', 'backup']);
});

it.each([false, true])('never retries or falls back for user quota failures (at spawn: %j)', async atSpawn => {
  fixture.failSpawn = atSpawn;
  fixture.error = new QuotaExceededError({ kind: 'tokensPerDay', current: 101, max: 100, userId: 'user' });
  expect((await run()).status).toBe('budget');
  expect(fixture.models).toEqual(['primary']);
});

it('never falls back around a user spending limit', async () => {
  fixture.error = new SpendBudgetExceededError({ budgetId: 'budget', userId: 'user', scopeKind: 'user',
    scopeRef: null, period: 'day', spentUsd: 11, limitUsd: 10 });
  expect((await run()).status).toBe('budget');
  expect(fixture.models).toEqual(['primary']);
});
