/**
 * `contextForAgentStart`: the audience rule, applied once for every agent
 * start, and when the previous typed message is read. The hooks themselves
 * (`runContextHooks`) and the stored messages are stood in for; the DB suite
 * (agent-start.db.test.ts) runs both for real.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { audienceOf } from '@/core/agent/audience';

const fx = vi.hoisted(() => ({
  run: vi.fn(),
  owner: vi.fn(),
  sharedWorkspace: vi.fn(),
}));
vi.mock('./run', () => ({ runContextHooks: (...args: unknown[]) => fx.run(...args) }));
vi.mock('@/core/memory/owner-messages', () => ({ loadRecentOwnerMessages: (...args: unknown[]) => fx.owner(...args) }));
vi.mock('@/security/workspace-fs', () => ({ isSharedWorkspaceId: (...args: unknown[]) => fx.sharedWorkspace(...args) }));

const { contextForAgentStart, previousTypedMessage } = await import('./agent-start');

const USER = '11111111-1111-1111-1111-111111111111';
const BLOCK = { text: '<recalled-knowledge>x</recalled-knowledge>', blocks: ['b'], labelledBlocks: [], repeatable: [], turn: { id: 't' } };
const base = { event: 'turn_start' as const, userId: USER, workspaceId: 'ws', sessionId: 'sess', query: 'what do we charge for a website build?' };

beforeEach(() => {
  fx.run.mockReset().mockResolvedValue(BLOCK);
  fx.owner.mockReset().mockResolvedValue([]);
  fx.sharedWorkspace.mockReset().mockResolvedValue(false);
});

describe('the audience rule', () => {
  test('a personal session (given or resolved) runs the hooks and returns their outcome', async () => {
    expect(await contextForAgentStart({ ...base, audience: audienceOf('personal') })).toBe(BLOCK);
    expect(await contextForAgentStart({ ...base, session: { workspaceId: 'ws' } })).toBe(BLOCK);
    // A session that does not exist yet is the requester's own.
    expect(await contextForAgentStart({ ...base, session: null })).toBe(BLOCK);
    expect(fx.run).toHaveBeenCalledTimes(3);
    expect(fx.run.mock.calls[0][0]).toMatchObject({ event: 'turn_start', userId: USER, workspaceId: 'ws', sessionId: 'sess', query: base.query });
  });

  test('a private session in a space runs them: its replies are read by the requester alone', async () => {
    fx.sharedWorkspace.mockResolvedValue(true);
    expect((await contextForAgentStart({ ...base, session: { workspaceId: 'space-ws' } })).text).toBe(BLOCK.text);
  });

  test.each([
    ['a group thread', { audience: audienceOf('group') }],
    ['a room', { audience: audienceOf('room') }],
    ['a space on another install', { audience: audienceOf('remote-space') }],
    ['a group thread, resolved', { session: { groupChannelId: 'g1' } }],
    ['a room, resolved', { session: { kind: 'room' } }],
    ['a remote room, resolved', { session: { context: { remoteRoom: { host: 'x' } } } }],
  ])('%s: nothing runs, nothing to finish', async (_label, who) => {
    const out = await contextForAgentStart({ ...base, ...who } as Parameters<typeof contextForAgentStart>[0]);
    expect(out).toEqual({ text: '', blocks: [], labelledBlocks: [], repeatable: [], turn: null });
    expect(fx.run).not.toHaveBeenCalled();
  });

  test('no real user (a system hook): nothing runs', async () => {
    for (const userId of ['system', '', null, undefined]) {
      expect((await contextForAgentStart({ ...base, userId, audience: audienceOf('personal') })).turn).toBeNull();
    }
    expect(fx.run).not.toHaveBeenCalled();
  });

  test('never throws: an audience that cannot be read, or hooks that throw, start the agent without hooks', async () => {
    fx.sharedWorkspace.mockRejectedValue(new Error('db down'));
    expect((await contextForAgentStart({ ...base, session: { workspaceId: 'ws' } })).text).toBe('');
    // Never a guess that the session is personal.
    expect(fx.run).not.toHaveBeenCalled();
    fx.run.mockRejectedValue(new Error('boom'));
    expect((await contextForAgentStart({ ...base, audience: audienceOf('personal') })).turn).toBeNull();
  });
});

describe('the previous typed message', () => {
  const personal = { audience: audienceOf('personal') };

  test('a short follow-up gets a reader for it; the reader skips this turn\'s own row', async () => {
    fx.owner.mockResolvedValue([{ id: 'm2', text: 'and for enterprise?' }, { id: 'm1', text: 'What do we charge for hosting?' }]);
    await contextForAgentStart({ ...base, ...personal, query: 'and for enterprise?', followUp: true });
    const input = fx.run.mock.calls[0][0] as { previousMessage?: () => Promise<string | undefined> };
    expect(typeof input.previousMessage).toBe('function');
    // Nothing is read until the hooks ask (only a recall hook does, inside its deadline).
    expect(fx.owner).not.toHaveBeenCalled();
    expect(await input.previousMessage?.()).toBe('What do we charge for hosting?');
    expect(fx.owner).toHaveBeenCalledWith(USER, 'sess', 2);
  });

  test('a message long enough to carry its subject, or a brief, gets no reader', async () => {
    await contextForAgentStart({ ...base, ...personal, query: 'What do we charge enterprise customers for hosting?', followUp: true });
    await contextForAgentStart({ ...base, ...personal, event: 'worker_start', query: 'and for enterprise?' });
    for (const [input] of fx.run.mock.calls) expect(input).not.toHaveProperty('previousMessage');
  });

  test('a read that fails is logged and the message is searched alone', async () => {
    fx.owner.mockRejectedValue(new Error('db down'));
    expect(await previousTypedMessage(USER, 'sess', 'and for enterprise?')).toBeUndefined();
  });
});
