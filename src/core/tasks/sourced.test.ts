import { describe, expect, test } from 'vitest';
import { emailToTask, normalizeTaskTitle, readerItemsToTasks, researchFollowUpTask } from './sourced';

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

describe('readerItemsToTasks', () => {
  test('one task per bullet, linked to the article, deduplicated', () => {
    const tasks = readerItemsToTasks(
      ['Email the vendor', '  email the VENDOR ', '', 'Book the room'],
      { url: 'https://example.com/post', title: 'Planning notes' },
    );
    expect(tasks.map((t) => t.title)).toEqual(['Email the vendor', 'Book the room']);
    expect(tasks[0].sourceRef).toEqual({ url: 'https://example.com/post', label: 'Planning notes' });
    expect(tasks[0].notes).toContain('https://example.com/post');
    expect(tasks[0].category).toBe('Reading');
  });
  test('no origin → no notes, still a task', () => {
    const [t] = readerItemsToTasks(['Do the thing'], {});
    expect(t.notes).toBeNull();
    expect(t.sourceRef).toEqual({ url: undefined, label: undefined });
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

describe('researchFollowUpTask', () => {
  test('points at the saved document and counts sources', () => {
    const t = researchFollowUpTask({ question: 'Is PGlite production-ready?', sources: [1, 2, 3] }, 'doc-1');
    expect(t.title).toBe('Review research: Is PGlite production-ready?');
    expect(t.notes).toContain('3 sources');
    expect(t.notes).toContain('Documents');
    expect(t.category).toBe('Research');
    expect(t.sourceRef).toEqual({ documentId: 'doc-1', label: 'Is PGlite production-ready?' });
  });
  test('no document id (persistence failed) → task still created, no dangling ref', () => {
    const t = researchFollowUpTask({ question: 'q', sources: [1] }, null);
    expect(t.notes).toContain('1 source.');
    expect(t.notes).not.toContain('Documents');
    expect(t.sourceRef?.documentId).toBeUndefined();
  });
});
