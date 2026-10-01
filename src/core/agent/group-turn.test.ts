/**
 * A turn in a group-channel thread (session.groupChannelId set): the reply is
 * read by every member, so the requester's memories are neither loaded nor
 * extracted, no learning check is queued, and the flow guard's shared-audience
 * rule is armed from the stored session — whatever entry point the turn used.
 * The same turn in a 1:1 session does all three normally.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  root: vi.fn(),
  retrieve: vi.fn(async () => []),
  update: vi.fn(async () => {}),
  enqueue: vi.fn(async () => {}),
  context: {} as Record<string, unknown>,
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }) }) }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => id }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'workspace' }) }) }));
vi.mock('@/core/commands', () => ({ handleCommand: async () => null }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async (id: string) => ({
    id, userId: 'user', title: 'Thread', tokenCount: 0, context: fx.context, metadata: { showSources: false },
    groupChannelId: id === 'group-session' ? 'g1' : null,
  }),
  incrementMessageCount: async () => {}, update: async () => {},
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (row: object) => ({ id: 'm', ...row }),
  createForGeneration: async (row: object) => ({ id: 'm', ...row }),
  findRecentBySession: async () => [],
} }));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({ retrieveForContext: fx.retrieve, renderMemoriesBlock: () => '', updateMemoriesAfterTurn: fx.update }));
vi.mock('@/core/learning/queue', () => ({ enqueueTurnLearning: fx.enqueue }));
vi.mock('@/core/cli-session-store', () => ({ acknowledgeProviderTurn: async () => {} }));
vi.mock('./session-compaction', () => ({ maybeCompactSession: async () => {} }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ getBySession: () => [] }) }));
vi.mock('./root-runner', () => ({ runRootAgent: (...args: unknown[]) => fx.root(...args) }));
import { isSharedAudience, resetFlowLabels } from '@/security/flow-guard';
import type { ApprovalManager } from './approval-manager';
import { AgentService } from './service';

beforeEach(() => {
  resetFlowLabels();
  for (const f of [fx.root, fx.retrieve, fx.update, fx.enqueue]) f.mockClear();
  fx.context = {};
  fx.root.mockResolvedValue({ response: 'Friday works.', agentId: 'agent', sources: [], outcome: 'success' });
});

const settle = () => new Promise((r) => setTimeout(r, 20));
/** The service's private approval manager, for spying. */
const approvals = (service: AgentService) => (service as unknown as { approvalManager: ApprovalManager }).approvalManager;

describe('group-channel turns', () => {
  test('no memories in or out, no learning job, shared-audience rule armed', async () => {
    const result = await new AgentService().handleMessage('group-session', 'user', 'summarise the release plan', 'slack');
    await settle();
    expect(result.response).toBe('Friday works.');
    expect(fx.retrieve).not.toHaveBeenCalled();
    expect(fx.update).not.toHaveBeenCalled();
    expect(fx.enqueue).not.toHaveBeenCalled();
    expect(isSharedAudience('group-session')).toBe(true);
  });

  test('the same turn in a 1:1 session uses memories and queues learning as before', async () => {
    await new AgentService().handleMessage('dm-session', 'user', 'summarise the release plan', 'slack');
    await settle();
    expect(fx.retrieve).toHaveBeenCalled();
    expect(fx.update).toHaveBeenCalled();
    expect(fx.enqueue).toHaveBeenCalled();
    expect(isSharedAudience('dm-session')).toBe(false);
  });

  // runRootAgent(service, deps, sessionId, userId, message, classification, guardFlags, channel, extraSystemContext, …)
  const messageArg = (i = 0) => fx.root.mock.calls[i]![4] as string;
  const turnContextArg = (i = 0) => fx.root.mock.calls[i]![8] as string;

  test('the message stays as typed; the framing and transcript ride as turn context', async () => {
    const group = { requester: 'Anna Schmidt', context: '--- GROUP CHANNEL CONTEXT T ---\nmember "Bob": ship Friday?\n--- END GROUP CHANNEL CONTEXT T ---' };
    await new AgentService().handleMessage('group-session', 'user', 'what do you think?', 'slack', [], undefined, undefined, group);
    expect(messageArg()).toBe('what do you think?');
    expect(turnContextArg()).toContain('the user message below is from member "Anna Schmidt"');
    expect(turnContextArg()).toContain('member "Bob": ship Friday?');
  });

  test('a monitor or wake-up in a group thread still carries the shared-audience notice', async () => {
    await new AgentService().handleMessage('group-session', 'user', 'The CI run finished.', 'slack');
    expect(messageArg()).toBe('The CI run finished.');
    expect(turnContextArg()).toContain('Everyone in the channel will see your reply');
  });

  test('a 1:1 session gets no group framing', async () => {
    await new AgentService().handleMessage('dm-session', 'user', 'hello there friend, summarise my week', 'slack');
    expect(turnContextArg()).not.toContain('shared group channel');
  });

  test('in a group thread only a bare yes/no answers a pending approval', async () => {
    const service = new AgentService();
    const manager = approvals(service);
    vi.spyOn(manager, 'getPendingApprovals').mockReturnValue([{ id: 'a1', sessionId: 'group-session' }] as never);
    const resolve = vi.spyOn(manager, 'tryResolveFromMessage').mockResolvedValue(true);
    const group = { requester: 'Anna', context: '' };

    const talk = await service.handleMessage('group-session', 'user', 'no, let me check with Dana first', 'slack', [], undefined, undefined, group);
    expect(resolve).not.toHaveBeenCalled();
    expect(talk.response).toBe('Friday works.'); // an ordinary turn

    const answer = await service.handleMessage('group-session', 'user', 'Approved!', 'slack', [], undefined, undefined, group);
    // passed on as the canonical word, so every bare form is understood
    expect(resolve).toHaveBeenCalledWith('yes', 'user');
    expect(answer.response).toBe('Got it, continuing...');
  });

  test('the rule holds for any entry point into a group session (web chat, hooks), not just the channel', async () => {
    const service = new AgentService();
    const manager = approvals(service);
    vi.spyOn(manager, 'getPendingApprovals').mockReturnValue([{ id: 'a1', sessionId: 'group-session' }] as never);
    const resolve = vi.spyOn(manager, 'tryResolveFromMessage').mockResolvedValue(true);
    await service.handleMessage('group-session', 'user', 'no, let me check with Dana first', 'webchat');
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a group-thread reply cannot answer an approval waiting in another session', async () => {
    const service = new AgentService();
    const manager = approvals(service);
    vi.spyOn(manager, 'getPendingApprovals').mockReturnValue([{ id: 'a1', sessionId: 'dm-session' }] as never);
    const resolve = vi.spyOn(manager, 'tryResolveFromMessage').mockResolvedValue(true);
    await service.handleMessage('group-session', 'user', 'yes', 'slack', [], undefined, undefined, { requester: 'Anna', context: '' });
    expect(resolve).not.toHaveBeenCalled();
  });

  test('plan "go" in a group thread still executes the plan (the framing does not hide it)', async () => {
    fx.context = { planningState: { brief: 'Ship the release notes', active: false, executed: false } };
    await new AgentService().handleMessage('group-session', 'user', 'go', 'slack', [], undefined, undefined, { requester: 'Anna', context: 'CTX' });
    expect(messageArg()).toMatch(/^Execute this project plan/);
    expect(turnContextArg()).toContain('Everyone in the channel will see your reply');
  });
});
