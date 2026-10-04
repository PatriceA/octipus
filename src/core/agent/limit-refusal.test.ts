/**
 * A turn refused by a spend budget or quota reaches chat as a clear message
 * naming the budget, the limit, the spend and the reset time, with the
 * structured reason on `metadata.limit` — not "I encountered an error" and
 * not "Task was stopped".
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { limitKindOf, limitRefusalOf, sharedRefusalText } from '@/core/errors/limit-refusal';
import { QuotaExceededError } from '@/security/quota-error';
import { SpendBudgetExceededError } from '@/security/spend-budget-error';

const fixture = vi.hoisted(() => ({ root: vi.fn(), persisted: [] as any[], created: [] as any[], context: {} as Record<string, unknown> }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }) }) }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => (id === 'new' ? 'resolved-session' : id), turnWorkspaceId: async () => 'workspace' }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'workspace' }) }) }));
vi.mock('@/core/commands', () => ({ handleCommand: async () => null }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async (id: string) => ({ id, userId: 'user', title: 'Budget test', tokenCount: 0, context: fixture.context, metadata: { showSources: false } }),
  incrementMessageCount: async () => {}, update: async () => {},
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (row: any) => { fixture.created.push(row); return { id: 'm', ...row }; },
  createForGeneration: async (row: any) => { fixture.persisted.push(row); return { id: 'm', ...row }; },
} }));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({ retrieveForContext: async () => [], renderMemoriesBlock: () => '', updateMemoriesAfterTurn: async () => {} }));
vi.mock('@/core/cli-session-store', () => ({ acknowledgeProviderTurn: async () => {} }));
vi.mock('./session-compaction', () => ({ maybeCompactSession: async () => {} }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ getBySession: () => [] }) }));
vi.mock('./root-runner', () => ({ runRootAgent: (...args: any[]) => fixture.root(...args) }));
import { AgentService } from './service';

const reason = {
  budgetId: 'b1', userId: 'user', scopeKind: 'role' as const, scopeRef: 'coder', period: 'day' as const,
  spentUsd: 12.345, limitUsd: 10, resetsAt: '2026-09-29T00:00:00.000Z',
};

beforeEach(() => {
  fixture.persisted = [];
  fixture.created = [];
  fixture.context = {};
  fixture.root.mockReset();
});

describe('limitRefusalOf', () => {
  test('spend budget: names the budget, limit, spend and reset time', () => {
    const r = limitRefusalOf(new SpendBudgetExceededError(reason))!;
    expect(r.text).toBe('Agents are paused: the daily spend budget for the "coder" role of $10.00/day is reached '
      + '($12.35 spent this day). It resets 2026-09-29 00:00 UTC. Ask an admin to raise the limit.');
    expect(r.refusal).toEqual({ code: 'SPEND_BUDGET_EXCEEDED', reason });
  });

  test('user scope reads as "your" budget', () => {
    const r = limitRefusalOf(new SpendBudgetExceededError({ ...reason, scopeKind: 'user', scopeRef: null, period: 'month' }))!;
    expect(r.text).toMatch(/^Agents are paused: your monthly spend budget of \$10\.00\/month is reached/);
  });

  test('quota: keeps the quota message and its reason', () => {
    const q = new QuotaExceededError({ kind: 'tokensPerDay', current: 11, max: 10, userId: 'user' });
    const r = limitRefusalOf(q)!;
    expect(r.text).toBe(q.message);
    expect(r.refusal).toEqual({ code: 'QUOTA_EXCEEDED', reason: q.reason });
  });

  test('matches by name too (errors rethrown across dynamic imports)', () => {
    const err = Object.assign(new Error('x'), { name: 'SpendBudgetExceededError', reason });
    expect(limitKindOf(err)).toBe('spend_budget');
    expect(limitRefusalOf(err)?.refusal.code).toBe('SPEND_BUDGET_EXCEEDED');
    expect(limitKindOf(new QuotaExceededError({ kind: 'tokensPerDay', current: 1, max: 1, userId: 'u' }))).toBe('quota');
  });

  test('anything else is not a limit', () => {
    expect(limitRefusalOf(new Error('boom'))).toBeNull();
    expect(limitKindOf('nope')).toBeNull();
  });

  test("a group channel's budget reads as the channel's", () => {
    const r = limitRefusalOf(new SpendBudgetExceededError({ ...reason, scopeKind: 'group_channel', scopeRef: 'g1', period: 'month' }))!;
    expect(r.text).toMatch(/^Agents are paused: this channel's monthly spend budget of \$10\.00\/month is reached/);
  });
});

describe('sharedRefusalText (a refusal posted in a group-channel thread)', () => {
  test("a member's own budget or quota is not posted with its figures", () => {
    const own = limitRefusalOf(new SpendBudgetExceededError(reason))!.refusal;
    const text = sharedRefusalText(own, 'Anna')!;
    expect(text).toContain('for Anna');
    expect(text).not.toMatch(/\$|coder/);
    const quota = limitRefusalOf(new QuotaExceededError({ kind: 'tokensPerDay', current: 11, max: 10, userId: 'user' }))!.refusal;
    expect(sharedRefusalText(quota, 'Anna')).not.toMatch(/11|10/);
  });

  test("the channel's own budget is posted as it is", () => {
    const channel = limitRefusalOf(new SpendBudgetExceededError({ ...reason, scopeKind: 'group_channel', scopeRef: 'g1' }))!.refusal;
    expect(sharedRefusalText(channel, 'Anna')).toBeNull();
  });
});

describe('AgentService.handleMessage', () => {
  test('a spend pause at spawn becomes the budget message with a structured reason', async () => {
    fixture.root.mockRejectedValueOnce(new SpendBudgetExceededError(reason));
    const result = await new AgentService().handleMessage('new', 'user', 'refactor the parser', 'webchat');
    expect(result.response).toMatch(/^Agents are paused: .*\$10\.00\/day .*\$12\.35 spent.*resets 2026-09-29 00:00 UTC/);
    expect(result.response).not.toMatch(/encountered an error|stopped/i);
    expect(result.outcome).toBe('failed');
    expect(result.metadata?.limit).toEqual({ code: 'SPEND_BUDGET_EXCEEDED', reason });
    // The resolved session, not the one the client sent.
    expect(result.sessionId).toBe('resolved-session');
    // No worker ran: the question and the refusal (with its reason) are stored.
    expect(fixture.created).toEqual([
      { sessionId: 'resolved-session', role: 'user', content: 'refactor the parser' },
      { sessionId: 'resolved-session', role: 'assistant', content: result.response, metadata: { limit: { code: 'SPEND_BUDGET_EXCEEDED', reason } } },
    ]);
  });

  test('a refusal mid-run is persisted and keeps its structured reason', async () => {
    const refusal = limitRefusalOf(new SpendBudgetExceededError(reason))!;
    fixture.root.mockResolvedValueOnce({ response: refusal.text, agentId: 'agent', sources: [], outcome: 'failed', limit: refusal.refusal });
    const result = await new AgentService().handleMessage('session', 'user', 'refactor the parser', 'webchat');
    expect(result.response).toBe(refusal.text);
    expect(result.metadata?.limit?.code).toBe('SPEND_BUDGET_EXCEEDED');
    expect(fixture.persisted).toEqual([expect.objectContaining({ content: refusal.text, metadata: { limit: refusal.refusal } })]);
  });

  describe('plan-execute path ("go")', () => {
    const plan = { planningState: { brief: 'Build the parser', active: false, executed: false } };

    test('a refusal at spawn does not save the "go" message twice', async () => {
      fixture.context = plan;
      fixture.root.mockRejectedValueOnce(new SpendBudgetExceededError(reason));
      const result = await new AgentService().handleMessage('session', 'user', 'go', 'webchat');
      expect(result.metadata?.limit?.code).toBe('SPEND_BUDGET_EXCEEDED');
      const userRows = fixture.created.filter((m) => m.role === 'user');
      expect(userRows).toEqual([{ sessionId: 'session', role: 'user', content: 'go' }]);
      expect(fixture.created.at(-1)).toMatchObject({ role: 'assistant', content: result.response, metadata: { limit: { code: 'SPEND_BUDGET_EXCEEDED' } } });
    });

    test('a mid-run refusal keeps metadata.limit on the saved answer and in the response', async () => {
      fixture.context = plan;
      const refusal = limitRefusalOf(new SpendBudgetExceededError(reason))!;
      fixture.root.mockResolvedValueOnce({ response: refusal.text, agentId: 'agent', sources: [], outcome: 'failed', limit: refusal.refusal });
      const result = await new AgentService().handleMessage('session', 'user', 'go', 'webchat');
      expect(result.response).toBe(refusal.text);
      expect(result.metadata?.limit).toEqual(refusal.refusal);
      expect(fixture.created.at(-1)).toEqual({ sessionId: 'session', role: 'assistant', content: refusal.text, metadata: { limit: refusal.refusal } });
      expect(fixture.created.filter((m) => m.role === 'user')).toHaveLength(1);
    });
  });

  test('other failures keep the generic path', async () => {
    fixture.root.mockRejectedValueOnce(new Error('boom'));
    const result = await new AgentService().handleMessage('session', 'user', 'refactor the parser', 'webchat');
    expect(result.response).toMatch(/encountered an error/);
    expect(result.metadata?.limit).toBeUndefined();
  });
});
