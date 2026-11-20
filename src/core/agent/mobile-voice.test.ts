import { beforeEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ direct: vi.fn(), root: vi.fn(), messages: [] as any[] }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }) }) }));
vi.mock('./model-selector', () => ({ ModelSelector: class { async selectForWorker() { return { model: 'voice-model' }; } } }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => id, turnWorkspaceId: async () => 'workspace' }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'workspace' }) }) }));
vi.mock('@/core/commands', () => ({ handleCommand: async () => null }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async (id: string) => ({ id, userId: 'user', title: 'Voice test', tokenCount: 0, context: {}, metadata: { showSources: false } }),
  incrementMessageCount: async () => {}, update: async () => {},
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (row: any) => { fixture.messages.push(row); return { id: 'm', ...row }; },
  createForGeneration: async (row: any) => ({ id: 'm', ...row }),
} }));
vi.mock('@/core/trajectories/recorder', () => ({ TrajectoryRecorder: class { setClassification() {} async finalize() {} } }));
vi.mock('@/core/memory', () => ({ retrieveForContext: async () => [], renderMemoriesBlock: () => '', updateMemoriesAfterTurn: async () => {} }));
vi.mock('@/core/cli-session-store', () => ({ acknowledgeProviderTurn: async () => {} }));
vi.mock('./session-compaction', () => ({ maybeCompactSession: async () => {} }));
vi.mock('./direct-response', () => ({ directResponse: (...args: any[]) => fixture.direct(...args) }));
vi.mock('./root-runner', () => ({ runRootAgent: (...args: any[]) => fixture.root(...args) }));
import { AgentService } from './service';

beforeEach(() => {
  fixture.messages = [];
  fixture.direct.mockReset().mockResolvedValue({ response: 'Soll ich die Notiz anlegen?' });
  fixture.root.mockReset().mockResolvedValue({ response: 'Die Notiz ist gespeichert.', agentId: 'agent', sources: [] });
});
test.each([
  'Who won the last time the Oscars for best picture',
  'Yes look it up online',
  'Who won the latest Best Picture Oscar?',
  'create a note about my meeting',
])('mobile voice reaches the real root loop, never the tool-less planner: %s', async message => {
  const service = new AgentService();
  // Even a stale web voice toggle must not divert native voice to planning.
  service.setVoiceMode('session', 'user', true);
  const reply = await service.handleMessage('session', 'user', message, 'mobile-voice');
  expect(fixture.direct).not.toHaveBeenCalled();
  expect(fixture.root).toHaveBeenCalledTimes(1);
  expect(fixture.root.mock.calls[0]).toContain(message);
  expect(fixture.root.mock.calls[0]).toContain('mobile-voice');
  expect(reply.agentId).toBe('agent');
});
test('legacy web voice planning still waits for confirmation', async () => {
  const service = new AgentService();
  service.setVoiceMode('session', 'user', true);
  await service.handleMessage('session', 'user', 'create a note about my meeting', 'webchat');
  expect(fixture.root).not.toHaveBeenCalled();
  await service.handleMessage('session', 'user', 'Ja, bitte!', 'webchat');
  expect(fixture.root).toHaveBeenCalledTimes(1);
});
test('ordinary mobile text still executes without requiring voice confirmation', async () => {
  const service = new AgentService();
  await service.handleMessage('session', 'user', 'create a note about my meeting', 'mobile');
  expect(fixture.direct).not.toHaveBeenCalled();
  expect(fixture.root).toHaveBeenCalledTimes(1);
});

// The 12th argument of runRootAgent (after the service and its deps) is the per-turn extras; `spoken` there adds the spoken-reply directive.
const spokenOf = (call: unknown[]) => (call[11] as { spoken?: boolean } | undefined)?.spoken === true;

test('a reply read aloud is asked for in spoken style: mobile voice, and a message sent as spoken — that turn only', async () => {
  const service = new AgentService();
  const first = await service.handleMessage('session', 'user', 'what time is it', 'mobile-voice');
  expect(spokenOf(fixture.root.mock.calls[0])).toBe(true);
  expect(first.spoken).toBe(true);

  // The flag rides on the message: this turn, nothing before or after it.
  const spoken = await service.handleMessage('session', 'user', 'what time is it', 'webchat', [], undefined, undefined, undefined, undefined, undefined, { spoken: true });
  expect(spokenOf(fixture.root.mock.calls[1])).toBe(true);
  expect(spoken.spoken).toBe(true);
  const typed = await service.handleMessage('session', 'user', 'and tomorrow?', 'webchat');
  expect(spokenOf(fixture.root.mock.calls[2])).toBe(false);
  expect(typed.spoken).toBeUndefined();
});

test('a typed message in a chat in web voice mode is answered in spoken style but not marked to be read aloud', async () => {
  const service = new AgentService();
  const extras = (call: unknown[]) => call[11] as { spoken?: boolean; readAloud?: boolean } | undefined;
  service.setVoiceMode('session', 'user', true);
  // The voice-mode gate proposes first; "go" runs it.
  await service.handleMessage('session', 'user', 'what is two plus two', 'webchat');
  const typed = fixture.root.mock.calls.at(-1);
  if (typed) {
    expect(extras(typed)?.readAloud).toBeUndefined();
  }
  service.setVoiceMode('session', 'user', false);
  const said = await service.handleMessage('session', 'user', 'what is two plus two', 'webchat', [], undefined, undefined, undefined, undefined, undefined, { spoken: true });
  expect(extras(fixture.root.mock.calls.at(-1)!)?.readAloud).toBe(true);
  expect(said.spoken).toBe(true);
});

test('a spoken "yes" that answers an approval leaves nothing behind for the next typed message', async () => {
  const service = new AgentService();
  const approvals = (service as unknown as { approvalManager: { getPendingApprovals: () => unknown[] } }).approvalManager;
  const pending = vi.spyOn(approvals, 'getPendingApprovals').mockReturnValueOnce([{ id: 'a1', sessionId: 'session' }]);
  await service.handleMessage('session', 'user', 'yes', 'webchat', [], undefined, undefined, undefined, undefined, undefined, { spoken: true });
  pending.mockRestore();
  await service.handleMessage('session', 'user', 'typed afterwards', 'webchat');
  expect(spokenOf(fixture.root.mock.calls.at(-1)!)).toBe(false);
});

// A worker identifier exists on failures too; callers must use the explicit outcome.
test.each(['success', 'failed', 'cancelled'] as const)('preserves the root turn outcome: %s', async outcome => {
  fixture.root.mockResolvedValueOnce({ response: 'Root result', agentId: 'agent', sources: [], outcome });
  const result = await new AgentService().handleMessage('session', 'user', 'check the pipeline', 'monitor');
  expect(result.agentId).toBe('agent');
  expect(result.outcome).toBe(outcome);
});
