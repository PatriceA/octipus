import { expect, test, vi } from 'vitest';
const compact = vi.hoisted(() => vi.fn(async () => 'Session compacted.'));
vi.mock('@/core/agent/session-compaction', () => ({ compactSessionCommand: compact }));
import './compact';
import { getAllCommands, getCommand } from './registry';

test('chat registers compact and forwards optional focus instructions', async () => {
  expect(getAllCommands().some(command => command.name === 'compact')).toBe(true);
  expect(await getCommand('compact')!.execute({ sessionId: 's1', userId: 'u1', args: 'keep decisions' }))
    .toEqual({ response: 'Session compacted.' });
  expect(compact).toHaveBeenCalledWith('s1', 'keep decisions', 'u1');
});
