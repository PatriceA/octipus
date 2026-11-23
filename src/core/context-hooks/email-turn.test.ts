/**
 * A turn that came in by email (docs/CHANNELS.md#email) gets no context
 * hooks: no note or knowledge passage is put in front of an answer that goes
 * to a forgeable channel. The same personal turn from a chat gets them.
 */
import { expect, test, vi } from 'vitest';

const fx = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('./run', () => ({ runContextHooks: (...args: unknown[]) => fx.run(...args) }));
import { contextForAgentStart } from './agent-start';

test('an email turn gets no context hooks; a chat turn does', async () => {
  fx.run.mockResolvedValue({ text: 'PRIVATE NOTE', blocks: ['PRIVATE NOTE'], labelledBlocks: [], repeatable: [], turn: null });
  const audience = { kind: 'personal', shared: false, personalMemoryOff: false, contentStorageOff: false } as never;
  const input = { event: 'turn_start' as const, userId: '11111111-1111-4111-8111-111111111111', workspaceId: 'w', sessionId: 's', query: 'q', audience };
  expect((await contextForAgentStart({ ...input, channel: 'email' })).text).toBe('');
  expect(fx.run).not.toHaveBeenCalled();
  expect((await contextForAgentStart({ ...input, channel: 'slack' })).text).toBe('PRIVATE NOTE');
});
