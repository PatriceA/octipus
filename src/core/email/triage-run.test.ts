/** The run layer over triageInbox: settings, scope, preview-free logic, progress, cancel and what a run may touch. */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { EmailTriage, InboxItem } from './types';

let prefs: Record<string, unknown> = {};
vi.mock('@/db/repositories/user-repository', () => ({ userRepository: {
  findById: async () => ({ preferences: prefs }),
  update: async (_id: string, patch: { preferences: Record<string, unknown> }) => { prefs = patch.preferences; },
} }));
vi.mock('./triage-labels', async (importOriginal) => ({ ...(await importOriginal<typeof import('./triage-labels')>()), storedTriage: vi.fn(async () => ({ old: { priority: 'low', source: 'llm' } })), thresholdsFor: vi.fn(async () => ({ priority: 0.7, category: 0.7 })) }));

vi.mock('./mailbox', () => ({ invalidateEmailCache: vi.fn(), listMessages: vi.fn(async () => ({ provider: 'google', items: [item('old'), item('new', true)] })) }));

const archived: string[][] = [];
const labelled: string[][] = [];
let triageImpl: (items: InboxItem[], run: { instructions?: string; signal?: AbortSignal; onProgress?: (p: { stage: 'decision' | 'llm'; done: number; total: number }) => void }) => Promise<Record<string, EmailTriage>>;
vi.mock('./service', async (importOriginal) => {
  const real = await importOriginal<typeof import('./service')>();
  return {
    ...real,
    triageInbox: vi.fn(async (_user: string, items: InboxItem[], run = {}) => triageImpl(items, run)),
    applyCategoryLabels: vi.fn(async (_u: string, _p: string, triage: Record<string, EmailTriage>) => { labelled.push(Object.keys(triage)); return Object.keys(triage).length; }),
    autoArchive: vi.fn(async (_u: string, _p: string, triage: Record<string, EmailTriage>, categories?: Iterable<string>) => { const ids = real.autoArchiveIds(triage, categories); archived.push(ids); return ids; }),
  };
});

const item = (id: string, unread = false): InboxItem => ({ id, provider: 'google', from: { email: 'a@x.com' }, subject: id, snippet: '', receivedAt: '', unread });
const finished = async (userId: string) => {
  const { currentTriageRun } = await import('./triage-run');
  await vi.waitFor(() => { if (!currentTriageRun(userId)?.finished) throw new Error('still running'); });
  return currentTriageRun(userId)!;
};

beforeEach(() => {
  prefs = {}; archived.length = 0; labelled.length = 0;
  triageImpl = async (items) => Object.fromEntries(items.map(it => [it.id, { priority: 'low', category: 'promotion', source: 'llm' } as EmailTriage]));
});

describe('triage settings', () => {
  test('defaults change nothing in the mailbox', async () => {
    const { getTriageSettings } = await import('./triage-run');
    expect(await getTriageSettings('u')).toEqual({ saved: false, lastAuto: null, settings: { scope: 'untriaged', applyLabels: false, autoArchive: false, archiveCategories: ['spam', 'promotion'], instructions: '', skipDialog: false, auto: false } });
  });

  test('a partial save keeps the rest; unknown archive categories and line breaks are dropped', async () => {
    const { getTriageSettings, setTriageSettings } = await import('./triage-run');
    await setTriageSettings('u', { autoArchive: true, archiveCategories: ['spam', 'gone'], instructions: 'My accountant\nis high' });
    await setTriageSettings('u', { scope: 'unread' });
    expect((await getTriageSettings('u')).settings).toMatchObject({ scope: 'unread', autoArchive: true, archiveCategories: ['spam'], instructions: 'My accountant is high' });
  });
});

describe('inScope', () => {
  test('untriaged, unread, all', async () => {
    const { inScope } = await import('./triage-run');
    const rows = [{ id: 'a', unread: true }, { id: 'b', unread: false }, { id: 'c', unread: false }];
    const triaged = new Set(['a', 'b']);
    expect(inScope(rows, 'untriaged', triaged)).toEqual(['c']);
    expect(inScope(rows, 'unread', triaged)).toEqual(['a']);
    expect(inScope(rows, 'all', triaged)).toEqual(['a', 'b', 'c']);
  });
});

describe('rubricKey', () => {
  test('presets without instructions keep the bare version; anything else gets its own key', async () => {
    const { DEFAULT_CATEGORIES, rubricKey } = await import('./service');
    const bare = rubricKey(DEFAULT_CATEGORIES);
    expect(bare).not.toContain('+');
    expect(rubricKey({ ...DEFAULT_CATEGORIES }, '')).toBe(bare);
    const withInstructions = rubricKey(DEFAULT_CATEGORIES, 'accountant is high');
    expect(withInstructions).toMatch(new RegExp(`^${bare}\\+[0-9a-f]{8}$`));
    expect(rubricKey({ ...DEFAULT_CATEGORIES, clients: 'paying customers' })).not.toBe(bare);
    expect(rubricKey({ ...DEFAULT_CATEGORIES, clients: 'paying customers' })).not.toBe(withInstructions);
  });
});

describe('a triage run', () => {
  test('with auto-archive off it archives and labels nothing, and proposes instead', async () => {
    const { startTriageRun } = await import('./triage-run');
    await startTriageRun('u1', 'google', { items: [item('a'), item('b')] });
    const run = await finished('u1');
    expect(run.result).toMatchObject({ archived: [], archiveProposed: ['a', 'b'], labeled: 0 });
    expect(archived).toEqual([]);
    expect(labelled).toEqual([]);
  });

  test('with the settings on it labels, archives only the chosen categories, and passes the instructions', async () => {
    const { setTriageSettings, startTriageRun } = await import('./triage-run');
    await setTriageSettings('u', { autoArchive: true, applyLabels: true, archiveCategories: ['spam'], instructions: 'be strict' });
    let seen = '';
    triageImpl = async (_items, run) => { seen = run.instructions ?? ''; return { a: { priority: 'low', category: 'spam' }, b: { priority: 'low', category: 'promotion' } }; };
    await startTriageRun('u2', 'google', { items: [item('a'), item('b')] });
    const run = await finished('u2');
    expect(seen).toBe('be strict');
    expect(run.result).toMatchObject({ archived: ['a'], archiveProposed: [], labeled: 2 });
  });

  test('"newest N" is narrowed by the scope on the server', async () => {
    const { startTriageRun } = await import('./triage-run');
    let ids: string[] = [];
    triageImpl = async (items) => { ids = items.map(it => it.id); return {}; };
    await startTriageRun('u3', 'google', { newest: 10, scope: 'untriaged' });
    await finished('u3');
    expect(ids).toEqual(['new']);
  });

  test('reports progress, refuses a second run, and cancels', async () => {
    const { cancelTriageRun, currentTriageRun, startTriageRun, TriageBusyError } = await import('./triage-run');
    const { TriageCancelledError } = await import('./service');
    triageImpl = (items, run) => new Promise((_resolve, reject) => {
      run.onProgress?.({ stage: 'decision', done: 1, total: items.length });
      run.signal?.addEventListener('abort', () => reject(new TriageCancelledError()));
    });
    await startTriageRun('u4', 'google', { items: [item('a'), item('b')] });
    await vi.waitFor(() => expect(currentTriageRun('u4')).toMatchObject({ stage: 'decision', done: 1, total: 2, finished: false }));
    await expect(startTriageRun('u4', 'google', { items: [item('c')] })).rejects.toBeInstanceOf(TriageBusyError);
    expect(cancelTriageRun('u4')).toBe(true);
    const run = await finished('u4');
    expect(run).toMatchObject({ cancelled: true });
    expect(run.error).toBeUndefined();
    expect(run.result).toBeUndefined();
  });

  test('a failure is reported without the result', async () => {
    const { startTriageRun } = await import('./triage-run');
    triageImpl = async () => { throw new Error('No model is bound'); };
    await startTriageRun('u5', 'google', { items: [item('a')] });
    expect(await finished('u5')).toMatchObject({ error: 'No model is bound', finished: true });
  });
});

describe('a run over several mailboxes ("All inboxes")', () => {
  test('progress counts across them; labels and archiving happen in Google / Microsoft mailboxes only', async () => {
    const { setTriageSettings, startTriageRun, currentTriageRun } = await import('./triage-run');
    await setTriageSettings('u', { autoArchive: true, applyLabels: true, archiveCategories: ['promotion'] });
    const box = 'imap:0b9d3c55-5f2c-4c37-9a3e-6d1f00000001' as const;
    const imapMail = (id: string): InboxItem => ({ ...item(id), provider: 'imap', mailbox: box });
    const calls: string[][] = [];
    const seen: number[] = [];
    triageImpl = async (items, run) => {
      calls.push(items.map((it) => it.id));
      run.onProgress?.({ stage: 'decision', done: items.length, total: items.length });
      seen.push(currentTriageRun('u7')!.done);
      return Object.fromEntries(items.map((it) => [it.id, { priority: 'low', category: 'promotion' } as EmailTriage]));
    };
    await startTriageRun('u7', [
      { mailbox: 'google', items: [item('g1'), item('g2')] },
      { mailbox: box, items: [imapMail('i1')], protected: 2 },
    ]);
    const run = await finished('u7');
    expect(calls).toEqual([['g1', 'g2'], ['i1']]);
    // The second mailbox counts on from the first.
    expect(seen).toEqual([2, 3]);
    expect(run).toMatchObject({ total: 3, done: 3 });
    expect(run.result).toMatchObject({ labeled: 2, archived: ['g1', 'g2'], archiveProposed: [], protected: 2 });
    expect(Object.keys(run.result!.triage).sort()).toEqual(['g1', 'g2', 'i1']);
    expect(labelled).toEqual([['g1', 'g2']]);
  });

  test('an IMAP mailbox with nothing to read gives nothing; no source reads Google for it', async () => {
    const { startTriageRun } = await import('./triage-run');
    const { listMessages } = await import('./mailbox');
    vi.mocked(listMessages).mockClear();
    let called = false;
    triageImpl = async () => { called = true; return {}; };
    await startTriageRun('u8', [{ mailbox: 'imap:0b9d3c55-5f2c-4c37-9a3e-6d1f00000001', newest: async () => ({ items: [], protected: 1 }) }], { newest: 10 });
    const run = await finished('u8');
    expect(called).toBe(false);
    expect(listMessages).not.toHaveBeenCalled();
    expect(run.result).toMatchObject({ protected: 1 });
  });
});

describe('automatic triage settings', () => {
  test('turning it on remembers when; turning it off forgets; a later save keeps the moment', async () => {
    const { getTriageSettings, setTriageSettings } = await import('./triage-run');
    await setTriageSettings('u', { auto: true }, new Date('2026-11-21T08:00:00Z'));
    expect((await getTriageSettings('u')).settings.auto).toBe(true);
    expect((prefs.emailTriage as { autoSince?: string }).autoSince).toBe('2026-11-21T08:00:00.000Z');
    await setTriageSettings('u', { scope: 'all' }, new Date('2026-11-22T08:00:00Z'));
    expect((prefs.emailTriage as { autoSince?: string }).autoSince).toBe('2026-11-21T08:00:00.000Z');
    await setTriageSettings('u', { auto: false });
    expect(prefs.emailTriage).not.toHaveProperty('autoSince');
  });

  test('the last automatic run is kept beside the settings and shown with them', async () => {
    const { getTriageSettings, recordAutoTriage, setTriageSettings } = await import('./triage-run');
    await recordAutoTriage('u', { at: '2026-11-21T09:00:00.000Z', triaged: 4, archived: 1 });
    await setTriageSettings('u', { instructions: 'be brief' });
    expect((await getTriageSettings('u')).lastAuto).toEqual({ at: '2026-11-21T09:00:00.000Z', triaged: 4, archived: 1 });
  });
});
