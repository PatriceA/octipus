/**
 * A side question (`chat.interject`) gets the context hooks' blocks for the
 * question as `directResponse`'s per-turn context, under the turn's
 * audience rule (none in a room), and closes the hooks' record with the
 * reply. Real wiring down to the hooks: `contextForAgentStart` runs; the
 * hooks, the model call and the session row are stood in for.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VOLATILE_MARKER } from '@/models/providers/prompt-cache';

const USER = '33333333-3333-3333-3333-333333333333';
const BLOCK = '\n\n<recalled-knowledge>\nEnterprise hosting: 99 euro a month.\n</recalled-knowledge>\n';
const TURN = { id: 'turn-side', usageKey: 's', startUse: { knowledge: 0, notes: 0 }, citable: [] };
const fx = vi.hoisted(() => ({
  hooks: vi.fn(),
  finish: vi.fn(),
  direct: vi.fn(),
  owner: vi.fn(),
  session: {} as Record<string, unknown>,
}));
vi.mock('@/core/context-hooks/run', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runContextHooks: (...args: unknown[]) => fx.hooks(...args),
  finishContextTurn: (...args: unknown[]) => fx.finish(...args),
}));
vi.mock('@/core/memory/owner-messages', () => ({ loadRecentOwnerMessages: (...args: unknown[]) => fx.owner(...args), isTypedOwnerRow: () => false }));
vi.mock('@/core/agent/direct-response', () => ({ directResponse: (...args: unknown[]) => fx.direct(...args) }));
vi.mock('@/core/personas/resolver', () => ({ resolvePersonaForUser: async () => ({ name: 'Octi' }) }));
vi.mock('@/core/agent/context', () => ({ resolveAgentScope: async () => ({ workspaceId: 'ws', space: null, sponsor: null, trigger: 'user', funding: 'own' }) }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async (id: string) => ({ id, userId: USER, ...fx.session }) } }));
vi.mock('@/security/workspace-fs', () => ({ isSharedWorkspaceId: async () => false }));
const { answerSideQuestion } = await import('./message-handler');

beforeEach(() => {
  fx.session = {};
  fx.hooks.mockReset().mockResolvedValue({ text: BLOCK, blocks: [BLOCK], labelledBlocks: [], repeatable: [], turn: TURN });
  fx.finish.mockReset();
  fx.direct.mockReset().mockResolvedValue({ response: '99 euro a month.', metadata: {} });
  fx.owner.mockReset().mockResolvedValue([{ id: 'm1', text: 'What do we charge for hosting?' }]);
});

describe('a side question', () => {
  test('is answered with the block as per-turn context; a short one is searched with the previous typed message; the record is finished', async () => {
    const reply = await answerSideQuestion('sess-side', USER, 'and for enterprise?', 'web');
    expect(reply).toBe('Octi — side question: 99 euro a month.');
    const input = fx.hooks.mock.calls[0][0] as { event: string; query: string; previousMessage?: () => Promise<string | undefined> };
    expect(input).toMatchObject({ event: 'turn_start', query: 'and for enterprise?', userId: USER, workspaceId: 'ws', sessionId: 'sess-side', channel: 'web' });
    expect(await input.previousMessage?.()).toBe('What do we charge for hosting?');
    // directResponse(message, sessionId, userId, selector, complexity, flags, extraSystemContext, …)
    expect(fx.direct.mock.calls[0][6]).toBe(BLOCK);
    expect(fx.finish).toHaveBeenCalledWith(TURN, { response: '99 euro a month.', outcome: 'success' });
  });

  test('in a room: no hooks, nothing extra in the prompt', async () => {
    fx.session = { kind: 'room' };
    await answerSideQuestion('sess-room', USER, 'what do we charge enterprise customers for hosting?', 'web');
    expect(fx.hooks).not.toHaveBeenCalled();
    expect(fx.direct.mock.calls[0][6]).toBe('');
  });

  test('a reply that fails closes the record too', async () => {
    fx.direct.mockRejectedValue(new Error('model down'));
    expect(await answerSideQuestion('sess-side', USER, 'what do we charge enterprise customers for hosting?')).toBe('Octi — side question: model down');
    expect(fx.finish).toHaveBeenCalledWith(TURN, { outcome: 'failed' });
  });
});

describe("directResponse's per-turn context", () => {
  test('the block lands after the volatile marker: sent beside the question and stored with its row, never in the cached system part', async () => {
    const { buildDirectResponseSystem } = await vi.importActual<typeof import('@/core/agent/direct-response')>('@/core/agent/direct-response');
    const system = buildDirectResponseSystem({ persona: 'P', dateContext: 'CURRENT DATE/TIME: now', extraSystemContext: BLOCK });
    const boundary = system.match(VOLATILE_MARKER)?.index ?? -1;
    expect(boundary).toBeGreaterThan(0);
    expect(system.slice(0, boundary)).not.toContain('recalled-knowledge');
    expect(system.slice(boundary)).toContain(BLOCK.trim());
  });
});
