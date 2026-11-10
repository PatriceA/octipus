import { describe, expect, test } from 'vitest';
import { emailToTask, normalizeTaskTitle } from './sourced';

describe('normalizeTaskTitle', () => {
  test('collapses whitespace and trims', () => {
    expect(normalizeTaskTitle('  send   the\n deck ')).toBe('send the deck');
  });
  test('caps very long titles', () => {
    const t = normalizeTaskTitle('x'.repeat(500));
    expect(t.length).toBe(200);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('emailToTask', () => {
  test('subject becomes the title, sender and snippet the notes, triage the priority', () => {
    const t = emailToTask({
      id: 'm1',
      subject: 'Re: contract renewal',
      from: { name: 'Ada', email: 'ada@example.com' },
      snippet: 'Can you confirm by Friday?',
      receivedAt: '2026-09-01T09:00:00Z',
      triage: { priority: 'high' },
    });
    expect(t.title).toBe('Re: contract renewal');
    expect(t.priority).toBe(3);
    expect(t.category).toBe('Email');
    expect(t.notes).toContain('Ada <ada@example.com>');
    expect(t.notes).toContain('Can you confirm by Friday?');
    expect(t.sourceRef).toEqual({ messageId: 'm1', label: 'Re: contract renewal' });
  });
  test('untriaged email is normal priority; empty subject gets a placeholder', () => {
    const t = emailToTask({ id: 'm2', subject: '', from: { email: 'x@y.z' } });
    expect(t.title).toBe('(no subject)');
    expect(t.priority).toBe(1);
  });
  test('low-priority triage maps to no priority', () => {
    const t = emailToTask({ id: 'm3', subject: 'Newsletter', from: { email: 'x@y.z' }, triage: { priority: 'low' } });
    expect(t.priority).toBe(0);
  });
});
