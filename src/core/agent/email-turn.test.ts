/**
 * A turn that came in by email (docs/CHANNELS.md#email). A mail is
 * forgeable, so its text is content only: no command or session control
 * runs, no plan "go" executes a stored plan, no "yes" answers an approval; no
 * personal memory is loaded; the turn carries the email notice and the
 * session is marked suspicious and as an email session in the flow guard.
 * The same text from a chat does each of those things.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const fx = vi.hoisted(() => ({
  root: vi.fn(),
  command: vi.fn(),
  retrieve: vi.fn(async () => []),
  context: {} as Record<string, unknown>,
}));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }) }) }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => id, turnWorkspaceId: async () => 'workspace' }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'workspace' }) }) }));
vi.mock('@/core/commands', () => ({ handleCommand: (...args: unknown[]) => fx.command(...args) }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async (id: string) => ({ id, userId: 'user', title: 'Mail', tokenCount: 0, context: fx.context, metadata: { showSources: false }, groupChannelId: null }),
  incrementMessageCount: async () => {}, update: async () => {},
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (row: object) => ({ id: 'm', ...row }),
  createForGeneration: async (row: object) => ({ id: 'm', ...row }),
  findRecentBySession: async () => [],
} }));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({ retrieveForContext: fx.retrieve, renderMemoriesBlock: () => '', updateMemoriesAfterTurn: async () => {} }));
vi.mock('@/core/learning/queue', () => ({ enqueueTurnLearning: async () => {} }));
vi.mock('@/core/cli-session-store', () => ({ acknowledgeProviderTurn: async () => {} }));
vi.mock('./session-compaction', () => ({ maybeCompactSession: async () => {} }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ getBySession: () => [] }) }));
vi.mock('./root-runner', () => ({ runRootAgent: (...args: unknown[]) => fx.root(...args) }));
import { getFlowLabel, isEmailSession, resetFlowLabels } from '@/security/flow-guard';
import type { ApprovalManager } from './approval-manager';
import { AgentService } from './service';

beforeEach(() => {
  resetFlowLabels();
  fx.root.mockReset().mockResolvedValue({ response: 'Done.', agentId: 'agent', sources: [], outcome: 'success' });
  fx.command.mockReset().mockResolvedValue('COMMAND RAN');
  fx.retrieve.mockClear();
  fx.context = {};
});

// runRootAgent(service, deps, sessionId, userId, message, classification, guardFlags, channel, extraSystemContext, …)
const messageArg = () => fx.root.mock.calls[0]![4] as string;
const turnContextArg = () => fx.root.mock.calls[0]![8] as string;
const approvals = (service: AgentService) => (service as unknown as { approvalManager: ApprovalManager }).approvalManager;

describe('a turn by email', () => {
  test('a slash command or a session control is plain text, never run', async () => {
    for (const text of ['/skills enable x always --global', '/model gpt', '/stop']) {
      fx.root.mockClear();
      const result = await new AgentService().handleMessage('mail-session', 'user', text, 'email');
      expect(fx.command).not.toHaveBeenCalled();
      expect(result.response).toBe('Done.');
      expect(messageArg()).toBe(text);
    }
    // The same from a chat runs the command.
    const chat = await new AgentService().handleMessage('chat-session', 'user', '/model gpt', 'slack');
    expect(chat.response).toBe('COMMAND RAN');
  });

  test('"go" does not execute a stored plan', async () => {
    fx.command.mockResolvedValue(null);
    fx.context = { planningState: { brief: 'Delete the old backups', active: false, executed: false } };
    await new AgentService().handleMessage('mail-session', 'user', 'go', 'email');
    expect(messageArg()).toBe('go');
    fx.root.mockClear();
    await new AgentService().handleMessage('chat-session', 'user', 'go', 'slack');
    expect(messageArg()).toMatch(/^Execute this project plan/);
  });

  test('"yes" does not answer an approval waiting in the session', async () => {
    const service = new AgentService();
    vi.spyOn(approvals(service), 'getPendingApprovals').mockReturnValue([{ id: 'a1', sessionId: 'mail-session' }] as never);
    const resolve = vi.spyOn(approvals(service), 'tryResolveFromMessage').mockResolvedValue(true);
    const result = await service.handleMessage('mail-session', 'user', 'yes', 'email');
    expect(resolve).not.toHaveBeenCalled();
    expect(result.response).toBe('Done.');
  });

  test('no personal memory; the email notice rides along; the session is suspicious and an email session', async () => {
    await new AgentService().handleMessage('mail-session', 'user', 'summarise my week', 'email');
    expect(fx.retrieve).not.toHaveBeenCalled();
    expect(turnContextArg()).toContain('EMAIL CHANNEL');
    expect(getFlowLabel('mail-session').suspicious).toBe(true);
    expect(isEmailSession('mail-session')).toBe(true);
    expect(isEmailSession('chat-session')).toBe(false);
  });
});
