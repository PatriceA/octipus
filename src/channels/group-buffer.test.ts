import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearGroupBuffer, findGroupMessage, findGroupMessageAnywhere, forgetGroupChat, groupMessages, groupThreads, recordGroupMessage,
} from './group-buffer';

const msg = (id: string, at = new Date().toISOString()) => ({ id, conversationId: 'c', author: 'Anna', authorId: 'u', text: `m${id}`, at });

describe('group buffer', () => {
  beforeEach(() => clearGroupBuffer());

  test('keeps messages per thread, oldest first, the newest 40', () => {
    for (let i = 0; i < 45; i++) recordGroupMessage('teams', 'c', 't1', msg(String(i)));
    recordGroupMessage('teams', 'c', 't2', msg('x'));
    const t1 = groupMessages('teams', 'c', 't1');
    expect(t1).toHaveLength(40);
    expect(t1[0]!.id).toBe('5');
    expect(groupMessages('teams', 'c', 't2').map(m => m.id)).toEqual(['x']);
    expect(groupMessages('telegram', 'c', 't1')).toEqual([]);
  });

  test('a repeated id replaces the message; lookups by id', () => {
    recordGroupMessage('telegram', 'c', 'main', msg('1'));
    recordGroupMessage('telegram', 'c', 'main', { ...msg('1'), text: 'edited' });
    expect(groupMessages('telegram', 'c', 'main')).toHaveLength(1);
    expect(findGroupMessage('telegram', 'c', 'main', '1')?.text).toBe('edited');
    expect(findGroupMessage('telegram', 'c', 'main', '2')).toBeUndefined();
  });

  test('long messages are cut; forgetting a chat drops all its threads only', () => {
    recordGroupMessage('teams', 'c', 't', { ...msg('1'), text: 'x'.repeat(5_000) });
    recordGroupMessage('teams', 'c', 't2', msg('2'));
    recordGroupMessage('teams', 'c2', 't', msg('3'));
    expect(groupMessages('teams', 'c', 't')[0]!.text).toHaveLength(1_500);
    forgetGroupChat('teams', 'c');
    expect(groupMessages('teams', 'c', 't')).toEqual([]);
    expect(groupMessages('teams', 'c', 't2')).toEqual([]);
    expect(groupMessages('teams', 'c2', 't')).toHaveLength(1);
  });

  test('a chat\'s threads, and a message found in whichever thread it is', () => {
    recordGroupMessage('slack', 'C', '90.0', msg('90.0'));
    recordGroupMessage('slack', 'C', '90.0', msg('91.0'));
    recordGroupMessage('slack', 'C', '95.0', msg('95.0'));
    recordGroupMessage('slack', 'C2', '90.0', msg('99.0'));
    expect([...groupThreads('slack', 'C').keys()].sort()).toEqual(['90.0', '95.0']);
    expect(findGroupMessageAnywhere('slack', 'C', '91.0')).toMatchObject({ thread: '90.0', message: { id: '91.0' } });
    expect(findGroupMessageAnywhere('slack', 'C', '99.0')).toBeUndefined();
  });

  test('messages older than a day are dropped', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    recordGroupMessage('teams', 'c', 't', msg('old', '2026-10-01T11:00:00.000Z'));
    recordGroupMessage('teams', 'c', 't', msg('new', '2026-10-02T11:00:00.000Z'));
    expect(groupMessages('teams', 'c', 't', now).map(m => m.id)).toEqual(['new']);
  });
});
