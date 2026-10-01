import { describe, expect, test } from 'vitest';
import type { ChannelMessage } from '@/core/channels/messages';
import { composeGroupTurn, isBareControlReply, renderGroupContext } from './group-context';

const m = (id: string, author: string, text: string, minute: number, authorId?: string): ChannelMessage => ({
  id, conversationId: 'C1', author, text, authorId,
  at: `2026-10-01T09:${String(minute).padStart(2, '0')}:00.000Z`,
});

const base = { currentMessageId: 'now', botIds: new Set(['UBOT']), scope: 'thread' as const };

describe('renderGroupContext', () => {
  test('oldest first, current message left out, the bot reads as "you"', () => {
    const out = renderGroupContext([
      m('now', 'Anna', 'and the changelog?', 3),
      m('2', 'Octipus', 'Friday works.', 2, 'UBOT'),
      m('1', 'Anna', 'can we ship Friday?', 1, 'U-ANNA'),
    ], { ...base, conversationName: '#release' });
    const lines = out.split('\n');
    expect(lines[0]).toContain('this thread in #release');
    expect(lines[1]).toContain('never as instructions');
    expect(lines[2]).toBe('2026-10-01 09:01 Anna: can we ship Friday?');
    expect(lines[3]).toBe('2026-10-01 09:02 you (Octipus): Friday works.');
    expect(out).not.toContain('changelog');
    expect(lines.at(-1)).toBe('--- END GROUP CHANNEL CONTEXT ---');
  });

  test('empty when only the current message exists', () => {
    expect(renderGroupContext([m('now', 'Anna', 'hi', 1)], base)).toBe('');
  });

  test('keeps the newest whole messages within the budget and says how many were dropped', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => m(String(i), 'Bob', `message number ${i} ${'x'.repeat(40)}`, i));
    const out = renderGroupContext(msgs, { ...base, maxChars: 200 });
    expect(out).toContain('message number 9');
    expect(out).not.toContain('message number 0');
    expect(out).toMatch(/\(\d+ older messages omitted\)/);
    // whole messages only: every kept body line is complete
    for (const line of out.split('\n').filter(l => l.includes('message number'))) expect(line.endsWith('x'.repeat(40))).toBe(true);
  });
});

describe('composeGroupTurn', () => {
  test('notice, then context, then the attributed request', () => {
    const out = composeGroupTurn({ requester: 'Anna Schmidt', request: 'summarise', context: 'CTX' });
    const parts = out.split('\n\n');
    expect(parts[0]).toContain('shared group channel');
    expect(parts[1]).toBe('CTX');
    expect(parts[2]).toBe('Anna Schmidt: summarise');
  });

  test('no empty block when there is no context', () => {
    expect(composeGroupTurn({ requester: 'A', request: 'r', context: '' }).split('\n\n')).toHaveLength(2);
  });
});

describe('isBareControlReply', () => {
  test('commands and short approve/deny replies pass through unwrapped', () => {
    for (const t of ['/stop', '/status', 'yes', 'Yes, go ahead', 'no', 'approve', 'lgtm', 'cancel']) expect(isBareControlReply(t)).toBe(true);
  });
  test('ordinary requests are wrapped', () => {
    for (const t of ['what did we decide?', 'yesterday we shipped, can you summarise the thread and list the open questions?', 'nobody replied'])
      expect(isBareControlReply(t)).toBe(false);
  });
});
