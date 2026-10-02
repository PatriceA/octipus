import { beforeEach, describe, expect, test } from 'vitest';
import { clearGroupBuffer, findGroupMessage, groupMessages, recordGroupMessage } from './group-buffer';

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

  test('messages older than a day are dropped', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    recordGroupMessage('teams', 'c', 't', msg('old', '2026-10-01T11:00:00.000Z'));
    recordGroupMessage('teams', 'c', 't', msg('new', '2026-10-02T11:00:00.000Z'));
    expect(groupMessages('teams', 'c', 't', now).map(m => m.id)).toEqual(['new']);
  });
});
