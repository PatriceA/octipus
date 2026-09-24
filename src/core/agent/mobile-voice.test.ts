import { beforeEach, expect, test, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ direct: vi.fn(), root: vi.fn(), messages: [] as any[] }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }) }) }));
vi.mock('./model-selector', () => ({ ModelSelector: class { async selectForWorker() { return { model: 'voice-model' }; } } }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => id }));
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
  service.setVoiceMode('session', true);
  const reply = await service.handleMessage('session', 'user', message, 'mobile-voice');
  expect(fixture.direct).not.toHaveBeenCalled();
  expect(fixture.root).toHaveBeenCalledTimes(1);
  expect(fixture.root.mock.calls[0]).toContain(message);
  expect(fixture.root.mock.calls[0]).toContain('mobile-voice');
  expect(reply.agentId).toBe('agent');
});
test('legacy web voice planning still waits for confirmation', async () => {
  const service = new AgentService();
  service.setVoiceMode('session', true);
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

// A worker identifier exists on failures too; callers must use the explicit outcome.
test.each(['success', 'failed', 'cancelled'] as const)('preserves the root turn outcome: %s', async outcome => {
  fixture.root.mockResolvedValueOnce({ response: 'Root result', agentId: 'agent', sources: [], outcome });
  const result = await new AgentService().handleMessage('session', 'user', 'check the pipeline', 'monitor');
  expect(result.agentId).toBe('agent');
  expect(result.outcome).toBe(outcome);
});
