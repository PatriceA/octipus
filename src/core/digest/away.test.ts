import { describe, expect, test } from 'vitest';
import { type AwayDigest, clampSince, defaultSince, renderAwayDigest } from './away';

const base = (over: Partial<AwayDigest> = {}): AwayDigest => ({
  since: '2026-09-06T08:00:00.000Z',
  until: '2026-09-07T08:00:00.000Z',
  agents: { completed: [], failed: [] },
  pipelines: [],
  approvals: [],
  tasks: [],
  unreadNotifications: 0,
  empty: true,
  ...over,
});

describe('defaultSince / clampSince', () => {
  const now = new Date('2026-09-07T08:00:00Z');
  test('default is 24h back; hours override', () => {
    expect(defaultSince(now).toISOString()).toBe('2026-09-06T08:00:00.000Z');
    expect(defaultSince(now, 6).toISOString()).toBe('2026-09-07T02:00:00.000Z');
  });
  test('clamps to [now - 30d, now]', () => {
    expect(clampSince(new Date('2020-01-01T00:00:00Z'), now).toISOString()).toBe('2026-08-08T08:00:00.000Z');
    expect(clampSince(new Date('2030-01-01T00:00:00Z'), now).toISOString()).toBe(now.toISOString());
    expect(clampSince(new Date('2026-09-07T00:00:00Z'), now).toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });
});

describe('renderAwayDigest', () => {
  test('empty digest says so and nothing else', () => {
    const text = renderAwayDigest(base());
    expect(text).toBe('## While you were away (since 2026-09-06 08:00 UTC)\n\nNothing happened: no runs finished, nothing is waiting on you.');
  });

  test('approvals and waiting pipelines come first, then failures, then the rest', () => {
    const text = renderAwayDigest(base({
      empty: false,
      approvals: [{ id: 'r1', sessionId: 's1', summary: 'Delete branch', question: 'Proceed?' }],
      pipelines: [
        { id: 'p1', title: 'Bug Fix', status: 'awaiting_approval', changedAt: '', waitingOnYou: true },
        { id: 'p2', title: 'Full Development Cycle', status: 'completed', summary: 'Shipped the migration.', changedAt: '', waitingOnYou: false },
      ],
      agents: {
        completed: [
          { id: 'a1', role: 'coding', status: 'completed', finishedAt: '', durationMs: 95_000 },
          { id: 'a2', role: 'coding', status: 'completed', finishedAt: '', durationMs: 4_000 },
          { id: 'a3', role: 'research', status: 'completed', finishedAt: '' },
        ],
        failed: [{ id: 'a4', role: 'qa', status: 'failed', finishedAt: '', error: 'exit code 1' }],
      },
      tasks: [
        { id: 't1', title: 'Reply to Ada', source: 'email', createdAt: '' },
        { id: 't2', title: 'Review research: PGlite', source: 'research', createdAt: '' },
      ],
      unreadNotifications: 3,
    }));
    const headings = text.split('\n').filter((l) => l.startsWith('**')).map((l) => l.slice(2, l.indexOf(' —')));
    expect(headings).toEqual(['Waiting on you', 'Pipelines waiting on you', 'Failed', 'Pipelines', 'Finished', 'New to-dos for you']);
    expect(text).toContain('- Delete branch: Proceed?');
    expect(text).toContain('- Bug Fix (awaiting approval)');
    expect(text).toContain('**Failed — 1 agent** (qa)');
    expect(text).toContain('- qa: exit code 1');
    expect(text).toContain('- Full Development Cycle: completed — Shipped the migration.');
    expect(text).toContain('**Finished — 3 agents** (coding ×2, research)');
    expect(text).toContain('- coding in 1m 35s');
    expect(text).toContain('**New to-dos for you — 2** (from email, from research)');
    expect(text).toContain('3 new unread notifications in the inbox.');
  });

  test('caps each section and counts the rest', () => {
    const completed = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, role: 'coding', status: 'completed' as const, finishedAt: '' }));
    const text = renderAwayDigest(base({ empty: false, agents: { completed, failed: [] } }), { maxPerSection: 3 });
    expect(text.split('\n').filter((l) => l === '- coding')).toHaveLength(3);
    expect(text).toContain('- …and 5 more');
  });

  test('a stopped agent is reported as stopped, not failed-with-error', () => {
    const text = renderAwayDigest(base({ empty: false, agents: { completed: [], failed: [{ id: 'a', role: 'review', status: 'stopped', finishedAt: '' }] } }));
    expect(text).toContain('- review (stopped)');
  });
});
