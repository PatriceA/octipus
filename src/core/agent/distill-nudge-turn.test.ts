/**
 * The distil offer at the end of a root turn, through `AgentService.handleMessage`:
 * what the turn reports about itself to the offer, and that only an attended
 * turn from a client that shows the offer gets one. The offer's own reads are
 * stood in for; its turn gate is the real one. The other stand-ins are those
 * of context-hooks-turn.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { nudgeTurnGate } from '@/core/learning/distill-nudge';
import type { DistillNudgeTurn } from '@/core/learning/distill-nudge-service';

const USER = '22222222-2222-2222-2222-222222222222';
const fx = vi.hoisted(() => ({
  root: vi.fn(),
  offers: [] as unknown[],
  offer: vi.fn(),
  context: {} as Record<string, unknown>,
  groupChannelId: undefined as string | undefined,
}));
vi.mock('@/core/learning/distill-nudge-service', () => ({
  offerDistillNudge: (turn: unknown) => { fx.offers.push(turn); return fx.offer(turn); },
}));
vi.mock('@/core/context-hooks/run', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runContextHooks: async () => ({ text: '', blocks: [], labelledBlocks: [], repeatable: [], turn: null }),
  finishContextTurn: async () => {},
}));
vi.mock('@/core/memory/owner-messages', () => ({
  loadRecentOwnerMessages: async () => [],
  isTypedOwnerRow: () => false,
}));
vi.mock('@/plugins/packages/contributions/context', () => ({ runPluginContexts: async () => ({ text: '', labelledBlocks: [] }) }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'test-model' }) }) }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => id, turnWorkspaceId: async () => 'workspace' }));
vi.mock('@/security/orgs', () => ({ getOrgWorkspaceManager: () => ({ ensureDefaultWorkspace: async () => ({ id: 'workspace' }) }) }));
vi.mock('@/core/commands', () => ({ handleCommand: async () => null }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async (id: string) => ({ id, userId: USER, title: 'Offer test', tokenCount: 0, context: { ...fx.context },
    metadata: { showSources: false }, ...(fx.groupChannelId ? { groupChannelId: fx.groupChannelId } : {}) }),
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

const offered = () => fx.offers as DistillNudgeTurn[];
/** The real turn gate's verdict on what the turn reported (null: it may be offered). */
const gate = () => nudgeTurnGate(offered()[0].facts, { enabled: true });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const SHOWS = { renders: ['inline_ui', 'skill_nudge'] };
const send = (channel: string, opts: { trigger?: 'schedule'; renders?: boolean } = {}) =>
  new AgentService().handleMessage('sess-1', USER, 'Cut the release', channel,
    [], undefined, undefined, undefined, opts.trigger, opts.renders === false ? undefined : SHOWS);

beforeEach(() => {
  fx.context = {};
  fx.groupChannelId = undefined;
  fx.offers.length = 0;
  fx.offer.mockReset().mockResolvedValue(null);
  fx.root.mockReset().mockResolvedValue({ response: 'Released.', agentId: 'root-agent', sources: [], outcome: 'success' });
});

describe('the distil offer of a root turn', () => {
  test('a web chat turn that can show it reports itself and passes the gate', async () => {
    await send('webchat');
    await flush();
    expect(offered()).toHaveLength(1);
    expect(offered()[0]).toMatchObject({ sessionId: 'sess-1', userId: USER, rootAgentId: 'root-agent', answerMessageId: 'm',
      runId: expect.stringMatching(/^run_/),
      facts: { trigger: 'user', channel: 'webchat', clientRendersNudge: true, spoken: false, oneShot: false, shared: false, outcome: 'success' } });
    expect(gate()).toBeNull();
  });

  test('the answer is returned before the offer is decided', async () => {
    let finish: (value: null) => void = () => {};
    fx.offer.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const result = await send('webchat');
    expect(result.response).toBe('Released.');
    await flush();
    expect(offered()).toHaveLength(1);
    finish(null);
  });

  test('an offer that fails neither fails nor delays the turn', async () => {
    fx.offer.mockRejectedValue(new Error('database gone'));
    const result = await send('webchat');
    expect(result).toMatchObject({ response: 'Released.', outcome: 'success' });
    await flush();
    expect(offered()).toHaveLength(1);
  });

  test('a client that does not list it is refused by the gate', async () => {
    await send('telegram', { renders: false });
    await flush();
    expect(offered()[0].facts.clientRendersNudge).toBe(false);
    expect(gate()).toBe('client');
  });

  test.each(['hook', 'heartbeat', 'cron'])('a %s turn is unattended and never offered', async (channel) => {
    await send(channel, { trigger: 'schedule' });
    await flush();
    expect(offered()[0].facts.trigger).toBe('schedule');
    expect(gate()).toBe('unattended');
  });

  test('a monitor wake-up is never offered', async () => {
    await send('monitor');
    await flush();
    expect(offered()[0].facts.trigger).toBe('monitor');
    expect(gate()).toBe('unattended');
  });

  test('a one-shot session is never offered', async () => {
    fx.context = { oneShot: true };
    await send('webchat');
    await flush();
    expect(gate()).toBe('one_shot');
  });

  test('a group thread is never offered', async () => {
    fx.groupChannelId = 'g1';
    await send('webchat');
    await flush();
    expect(offered()[0].facts.shared).toBe(true);
    expect(gate()).toBe('shared');
  });

  test('a failed turn is never offered', async () => {
    fx.root.mockResolvedValueOnce({ response: 'Could not finish.', agentId: 'root-agent', sources: [], outcome: 'failed' });
    await send('webchat');
    await flush();
    expect(gate()).toBe('not_successful');
  });
});
