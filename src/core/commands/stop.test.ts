/** `/stop` stops the session's agents and drops the turns queued behind the running one. */
import { expect, test, vi } from 'vitest';

const stopSession = vi.hoisted(() => vi.fn((_sessionId: string, _userId?: string) => 1));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ stopSession }) }));
vi.mock('@/core/companion/user-control', () => ({ recordCompanionOwnerStop: async () => undefined }));

import { isSessionTurnCancelled, withSessionTurn } from '@/core/session-turn-lock';
import './stop'; // self-registers the /stop command
import { stopReply } from './stop';
import { getCommand } from './registry';

test('the reply names the stopped agents and the dropped queued messages', () => {
  expect(stopReply(0, 0)).toBe('No running agents in this session.');
  expect(stopReply(1, 0)).toBe('Stopped 1 running agent.');
  expect(stopReply(2, 1)).toBe('Stopped 2 running agents; 1 queued message dropped.');
  expect(stopReply(0, 3)).toBe('No running agents in this session; 3 queued messages dropped.');
});

test('/stop drops the caller\'s queued messages; they never run, and others\' turns stay', async () => {
  let release!: () => void;
  const running = withSessionTurn('stop-s1', () => new Promise<void>(resolve => { release = resolve; }));
  const ran: string[] = [];
  const queued = [1, 2].map(n => withSessionTurn('stop-s1', async () => { ran.push(`queued-${n}`); }, { owner: 'u' }).catch(err => (isSessionTurnCancelled(err) ? 'dropped' : 'other')));
  // Another member's message and a monitor wake-up stay queued.
  const others = [
    withSessionTurn('stop-s1', async () => { ran.push('bob'); }, { owner: 'bob' }),
    withSessionTurn('stop-s1', async () => { ran.push('wake'); }, { owner: 'u', kind: 'background' }),
  ];
  await Promise.resolve();

  const result = await getCommand('stop')!.execute({ sessionId: 'stop-s1', userId: 'u', args: '' });
  expect(result.response).toBe('Stopped 1 running agent; 2 queued messages dropped.');
  expect(stopSession).toHaveBeenCalledWith('stop-s1', 'u');
  expect(await Promise.all(queued)).toEqual(['dropped', 'dropped']);
  release();
  await Promise.all([running, ...others]);
  expect(ran).toEqual(['bob', 'wake']);
});
