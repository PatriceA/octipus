/**
 * The root turn's context hooks through `AgentService.handleMessage`: what
 * reaches the root agent (the block, the cross-turn groups, the Context
 * inspector's parts), whether a short typed message is searched with the
 * previous one, and that the turn's record is closed however the turn ends.
 *
 * Real wiring down to the hooks: `contextForAgentStart` runs; only the hooks
 * themselves (`runContextHooks`, `finishContextTurn`), the stored messages
 * and the root agent are stood in for.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const USER = '22222222-2222-2222-2222-222222222222';
const BLOCK = '\n\n<recalled-knowledge>\nEnterprise hosting: 99 euro a month.\n</recalled-knowledge>\n';
const fx = vi.hoisted(() => ({
  root: vi.fn(),
  hooks: vi.fn(),
  finish: vi.fn(),
  owner: vi.fn(),
  context: {} as Record<string, unknown>,
}));
vi.mock('@/core/context-hooks/run', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runContextHooks: (...args: unknown[]) => fx.hooks(...args),
  finishContextTurn: (...args: unknown[]) => fx.finish(...args),
}));
vi.mock('@/core/memory/owner-messages', () => ({
  loadRecentOwnerMessages: (...args: unknown[]) => fx.owner(...args),
  isTypedOwnerRow: () => false,
}));
vi.mock('@/plugins/packages/contributions/context', () => ({ runPluginContexts: async () => ({ text: '', labelledBlocks: [] }) }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }) }) }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => id, turnWorkspaceId: async () => 'workspace' }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'workspace' }) }) }));
vi.mock('@/core/commands', () => ({ handleCommand: async () => null }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async (id: string) => ({ id, userId: USER, title: 'Hooks test', tokenCount: 0, context: { ...fx.context }, metadata: { showSources: false } }),
  incrementMessageCount: async () => {}, update: async () => {},
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (row: object) => ({ id: 'm', ...row }),
  createForGeneration: async (row: object) => ({ id: 'm', ...row }),
  findRecentBySession: async () => [],
} }));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({ retrieveForContext: async () => [], renderMemoriesBlock: () => '', updateMemoriesAfterTurn: async () => {} }));
vi.mock('@/core/cli-session-store', () => ({ acknowledgeProviderTurn: async () => {} }));
vi.mock('@/core/learning/queue', () => ({ enqueueTurnLearning: async () => {} }));
vi.mock('./session-compaction', () => ({ maybeCompactSession: async () => {} }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ getBySession: () => [] }) }));
vi.mock('./root-runner', () => ({ runRootAgent: (...args: unknown[]) => fx.root(...args) }));
const { AgentService } = await import('./service');

const TURN = { id: 'turn-1', usageKey: 's', startUse: { knowledge: 0, notes: 0 }, citable: [] };
const outcome = () => ({
  text: BLOCK, blocks: [BLOCK], labelledBlocks: [{ label: 'Context hook: Recall', text: BLOCK }],
  repeatable: [{ head: '<recalled-knowledge>', parts: ['p1'], tail: '</recalled-knowledge>' }], turn: TURN,
});
type Extras = { repeatableContext?: unknown[]; turnContextParts?: Array<{ label: string; text: string }> };
const rootCall = () => {
  const args = fx.root.mock.calls[0] as unknown[];
  // (service, deps, sessionId, userId, message, classification, flags, channel, context, scope, directive, extras)
  return { message: args[4] as string, context: args[8] as string, extras: args[11] as Extras };
};

beforeEach(() => {
  fx.context = {};
  fx.root.mockReset().mockResolvedValue({ response: 'Enterprise hosting is 99 euro a month.', agentId: 'root-agent', sources: [], outcome: 'success' });
  fx.hooks.mockReset().mockImplementation(async () => outcome());
  fx.finish.mockReset();
  fx.owner.mockReset().mockResolvedValue([{ id: 'm1', text: 'What do we charge for hosting?' }]);
});

describe('a root turn', () => {
  test('the block reaches the root agent with its groups and inspector part; the record is finished with the answer', async () => {
    await new AgentService().handleMessage('sess-1', USER, 'What do we charge enterprise customers for hosting?', 'webchat');
    const { context, extras } = rootCall();
    expect(context).toContain(BLOCK);
    expect(extras.repeatableContext).toEqual(outcome().repeatable);
    expect(extras.turnContextParts).toContainEqual({ label: 'Context hook: Recall', text: BLOCK });
    expect(fx.hooks.mock.calls[0][0]).toMatchObject({ event: 'turn_start', userId: USER, role: 'general', channel: 'webchat' });
    expect(fx.finish).toHaveBeenCalledWith(TURN, { agentId: 'root-agent', response: 'Enterprise hosting is 99 euro a month.', outcome: 'success' });
  });

  test('a short typed follow-up is searched with the previous typed message', async () => {
    await new AgentService().handleMessage('sess-1', USER, 'and for enterprise?', 'webchat');
    const input = fx.hooks.mock.calls[0][0] as { previousMessage?: () => Promise<string | undefined> };
    expect(await input.previousMessage?.()).toBe('What do we charge for hosting?');
    expect(fx.owner).toHaveBeenCalledWith(USER, 'sess-1', 2);
  });

  test('a long message, or a scheduled turn, reads no previous message', async () => {
    await new AgentService().handleMessage('sess-1', USER, 'What do we charge enterprise customers for hosting?', 'webchat');
    await new AgentService().handleMessage('sess-1', USER, 'and for enterprise?', 'hook', [], undefined, undefined, undefined, 'schedule');
    for (const [input] of fx.hooks.mock.calls) expect(input).not.toHaveProperty('previousMessage');
  });

  test('a group thread gets no hooks', async () => {
    const service = new AgentService();
    // A session bound to a group channel is read by every member.
    const repo = (await import('@/db/repositories/session-repository')).sessionRepository as { findById: (id: string) => Promise<object> };
    const plain = repo.findById;
    repo.findById = async (id: string) => ({ ...(await plain(id)), groupChannelId: 'g1' });
    try {
      await service.handleMessage('sess-1', USER, 'What do we charge enterprise customers for hosting?', 'webchat');
    } finally {
      repo.findById = plain;
    }
    expect(fx.hooks).not.toHaveBeenCalled();
    expect(rootCall().context).not.toContain('recalled-knowledge');
  });

  test('a turn that fails still closes its record', async () => {
    fx.root.mockRejectedValueOnce(new Error('boom'));
    const result = await new AgentService().handleMessage('sess-1', USER, 'What do we charge enterprise customers for hosting?', 'webchat');
    expect(result.response).toMatch(/encountered an error/);
    expect(fx.finish).toHaveBeenCalledTimes(1);
    expect(fx.finish).toHaveBeenCalledWith(TURN, { outcome: 'failed' });
  });

  test('a turn whose conversation was cleared while it ran closes its record as cleared', async () => {
    // Cleared while the root agent ran: the session's generation moved on.
    fx.root.mockImplementationOnce(async () => {
      fx.context.conversationGeneration = 'g2';
      return { response: 'late', agentId: 'root-agent', sources: [], outcome: 'success' };
    });
    const result = await new AgentService().handleMessage('sess-1', USER, 'What do we charge enterprise customers for hosting?', 'webchat');
    expect(result.response).toMatch(/cleared/);
    expect(fx.finish).toHaveBeenCalledTimes(1);
    expect(fx.finish).toHaveBeenCalledWith(TURN, { agentId: 'root-agent', outcome: 'cleared' });
  });
});
