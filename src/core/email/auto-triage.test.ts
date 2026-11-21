/** Automatic triage: what a look takes, how often, the limits and the backoff. */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AutoSource, AutoTriageDeps } from './auto-triage';
import type { TriageSettings } from './triage-run';
import type { EmailTriage, InboxItem, MailboxKey } from './types';

const { AUTO_TRIAGE_EVERY_MS, AUTO_TRIAGE_MAX, AUTO_TRIAGE_MAX_BACKOFF_MS, autoTriageTick, autoTriageUser, nextLook, resetAutoTriage } = await import('./auto-triage');

const T0 = new Date('2026-11-21T10:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const mail = (id: string, minutesAgo = 1, mailbox: MailboxKey = 'google'): InboxItem => ({
  id, provider: mailbox === 'google' || mailbox === 'microsoft' ? mailbox : 'imap', ...(mailbox.startsWith('imap:') ? { mailbox } : {}),
  from: { email: 'a@b.c' }, subject: id, snippet: '', receivedAt: new Date(T0.getTime() - minutesAgo * 60_000).toISOString(), unread: true,
});
const settings: TriageSettings = { scope: 'untriaged', applyLabels: false, autoArchive: true, archiveCategories: ['promotion'], instructions: 'be strict', skipDialog: false, auto: true };

function deps(sources: AutoSource[], over: Partial<AutoTriageDeps> = {}) {
  const triaged = new Set<string>();
  const records: Array<Record<string, unknown>> = [];
  const triageCalls: Array<{ ids: string[]; instructions: string }> = [];
  const d: AutoTriageDeps = {
    users: async () => [{ id: 'u', since: new Date(T0.getTime() - 60 * 60_000).toISOString() }],
    sources: async () => sources,
    triaged: async (_u, _m, ids) => new Set(ids.filter((id) => triaged.has(id))),
    modelReady: async () => true,
    busy: () => false,
    settings: async () => settings,
    triage: async (_u, items, s) => {
      triageCalls.push({ ids: items.map((it) => it.id), instructions: s.instructions });
      for (const it of items) triaged.add(it.id);
      return Object.fromEntries(items.map((it) => [it.id, { priority: 'low', category: 'promotion' } as EmailTriage]));
    },
    apply: vi.fn(async (_u, mailbox, triage) => ({ triage, labeled: 0, archived: mailbox === 'google' ? Object.keys(triage) : [], archiveProposed: [] })),
    record: async (_u, last) => { records.push(last); },
    ...over,
  };
  return { d, records, triageCalls, triaged };
}
const source = (mailbox: MailboxKey, items: InboxItem[], kept = 0): AutoSource => ({ mailbox, newest: async () => ({ items, ...(kept ? { protected: kept } : {}) }) });

beforeEach(() => { resetAutoTriage(); });

describe('nextLook', () => {
  test('every few minutes; after failures twice as long each time, capped', () => {
    expect(nextLook(0, 0)).toBe(AUTO_TRIAGE_EVERY_MS);
    expect(nextLook(0, 1)).toBe(AUTO_TRIAGE_EVERY_MS * 2);
    expect(nextLook(0, 2)).toBe(AUTO_TRIAGE_EVERY_MS * 4);
    expect(nextLook(0, 10)).toBe(AUTO_TRIAGE_MAX_BACKOFF_MS);
  });
});

describe('a look at one user', () => {
  test('triages new untriaged mail with the saved settings, applies them per mailbox, and records the run', async () => {
    const box = 'imap:0b9d3c55-5f2c-4c37-9a3e-6d1f00000001' as const;
    const { d, records, triageCalls } = deps([
      source('google', [mail('g-new'), mail('g-old', 24 * 60)]),
      source(box, [mail('i-new', 5, box)], 2),
    ]);
    expect(await autoTriageUser('u', new Date(T0.getTime() - 60 * 60_000).toISOString(), T0, d)).toEqual({ result: 'ran', triaged: 2 });
    // Mail from before automatic triage was turned on is left alone.
    expect(triageCalls).toEqual([{ ids: ['g-new'], instructions: 'be strict' }, { ids: ['i-new'], instructions: 'be strict' }]);
    expect(vi.mocked(d.apply).mock.calls.map((c) => c[1])).toEqual(['google', box]);
    expect(records).toEqual([{ at: T0.toISOString(), triaged: 2, archived: 1, skipped: 2 }]);
  });

  test('waits between looks; a look with nothing new records nothing', async () => {
    const { d, records, triageCalls } = deps([source('google', [mail('a')])]);
    await autoTriageUser('u', null, T0, d);
    expect((await autoTriageUser('u', null, later(60_000), d)).result).toBe('waiting');
    expect((await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS), d)).result).toBe('idle');
    expect(triageCalls).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  test('never more than the limit in one look; the rest next time', async () => {
    const many = Array.from({ length: AUTO_TRIAGE_MAX + 5 }, (_, i) => mail(`m${i}`));
    const { d, triageCalls } = deps([source('google', many)]);
    expect((await autoTriageUser('u', null, T0, d)).triaged).toBe(AUTO_TRIAGE_MAX);
    expect((await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS), d)).triaged).toBe(5);
    expect(triageCalls.flatMap((c) => c.ids)).toHaveLength(AUTO_TRIAGE_MAX + 5);
  });

  test('a mail the models gave no answer for is not tried again', async () => {
    const { d, triageCalls } = deps([source('google', [mail('a')])], { triage: async (_u, items) => { triageCalls.push({ ids: items.map((it) => it.id), instructions: '' }); return {}; } });
    await autoTriageUser('u', null, T0, d);
    await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS), d);
    expect(triageCalls).toHaveLength(1);
  });

  test('a failure backs off, is recorded with its reason, and the mail is tried again', async () => {
    let fail = true;
    const { d, records, triageCalls } = deps([source('google', [mail('a')])]);
    const triage = d.triage;
    d.triage = async (...args) => { if (fail) throw new Error('model unavailable'); return triage(...args); };
    expect((await autoTriageUser('u', null, T0, d)).result).toBe('failed');
    expect(records.at(-1)).toMatchObject({ triaged: 0, error: 'model unavailable' });
    // After the first failure the next look waits twice as long.
    expect((await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS), d)).result).toBe('waiting');
    expect((await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS * 2), d)).result).toBe('failed');
    expect((await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS * 5), d)).result).toBe('waiting');
    fail = false;
    expect((await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS * 6), d)).result).toBe('ran');
    expect(triageCalls).toEqual([{ ids: ['a'], instructions: 'be strict' }]);
  });

  test('not while the owner\'s own run is going, and not without a model (said once)', async () => {
    const busy = deps([source('google', [mail('a')])], { busy: () => true });
    expect((await autoTriageUser('u', null, T0, busy.d)).result).toBe('busy');
    expect(busy.triageCalls).toHaveLength(0);
    resetAutoTriage();
    const none = deps([source('google', [mail('a')])], { modelReady: async () => false });
    expect((await autoTriageUser('u', null, T0, none.d)).result).toBe('no-model');
    expect((await autoTriageUser('u', null, later(AUTO_TRIAGE_EVERY_MS), none.d)).result).toBe('no-model');
    expect(none.triageCalls).toHaveLength(0);
    expect(none.records).toEqual([{ at: T0.toISOString(), triaged: 0, archived: 0, error: expect.stringMatching(/No model can triage/) }]);
  });
});

describe('a tick', () => {
  test('looks at every user who turned it on', async () => {
    // Each user's own mailbox: what one user triaged says nothing about the other.
    const { d } = deps([source('google', [mail('a'), mail('b')])], { users: async () => [{ id: 'u1', since: null }, { id: 'u2', since: null }], triaged: async () => new Set() });
    expect(await autoTriageTick(T0, d)).toBe(4);
  });
});
