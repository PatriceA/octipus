/**
 * The local header index: flags, change feeds, page tokens and freshness
 * (pure), then sync, serving, owner actions and the off switch against an
 * embedded Postgres with fake Gmail and Graph.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GmailMessage } from './normalize';

// ── Fake providers ──────────────────────────────────────────────────────

interface FakeGmail {
  messages: Map<string, GmailMessage>;
  historyId: string;
  history: unknown[];
  historyGone: boolean;
  inboxUnread: number;
  calls: string[];
}
const gmail: FakeGmail & { searchFails?: boolean } = { messages: new Map(), historyId: '100', history: [], historyGone: false, inboxUnread: 0, calls: [] };
const graph = { pages: new Map<string, unknown>(), calls: [] as string[], unread: 0 };
let connected: Array<'google' | 'microsoft'> = ['google', 'microsoft'];
const notFound = () => new Error('Mail provider returned an error (HTTP 404).');

vi.mock('./providers', () => ({
  detectProvider: async () => connected[0] ?? null,
  connectedProviders: async () => connected,
  gmailBatch: async () => { throw new Error('batch unavailable in the fake'); },
  graphBytes: async () => new Uint8Array(),
  gmailApi: async (_user: string, method: string, path: string) => {
    gmail.calls.push(`${method} ${path}`);
    if (path === '/profile') return { historyId: gmail.historyId, emailAddress: 'me@x.dev' };
    if (path === '/labels/INBOX') return { messagesUnread: gmail.inboxUnread };
    if (path.startsWith('/history')) {
      if (gmail.historyGone) throw notFound();
      return { history: gmail.history, historyId: gmail.historyId };
    }
    if (method === 'POST') return {};
    const one = path.match(/^\/messages\/([^/?]+)\?/);
    if (one) {
      const msg = gmail.messages.get(decodeURIComponent(one[1]));
      if (!msg) throw notFound();
      return msg;
    }
    if (path.startsWith('/messages?')) {
      // A search the provider cannot answer right now (the index's own reads carry newer_than:).
      const q = new URLSearchParams(path.slice('/messages?'.length)).get('q') ?? '';
      if (gmail.searchFails && q && !q.startsWith('newer_than:')) throw new Error('Mail provider returned an error (HTTP 503).');
      const max = Number(new URLSearchParams(path.slice('/messages?'.length)).get('maxResults') ?? 50);
      const ids = [...gmail.messages.values()].sort((a, b) => Number(b.internalDate) - Number(a.internalDate)).map((m) => ({ id: m.id }));
      return { messages: ids.slice(0, max) };
    }
    throw notFound();
  },
  graphApi: async (_user: string, _method: string, path: string) => {
    graph.calls.push(path);
    if (path.startsWith('/me/mailFolders/inbox?')) return { unreadItemCount: graph.unread };
    if (path.startsWith('/me/mailFolders/inbox/messages?')) return { value: [] };
    return {};
  },
  graphGetPrefer: async (_user: string, path: string) => {
    graph.calls.push(path);
    // The longest matching prefix answers.
    const prefix = [...graph.pages.keys()].filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const page = prefix === undefined ? undefined : graph.pages.get(prefix);
    if (page === undefined) throw notFound();
    if (page instanceof Error) throw page;
    return page;
  },
}));

const now = Date.now();
const minutes = (n: number) => String(now - n * 60_000);
function gmailMessage(id: string, minutesAgo: number, labels: string[], subject = `Subject ${id}`, from = 'Anna <anna@acme.io>'): GmailMessage {
  return {
    id, threadId: `t-${id}`, labelIds: labels, internalDate: minutes(minutesAgo), snippet: `Preview of ${id} `.repeat(40),
    payload: { headers: [{ name: 'From', value: from }, { name: 'To', value: 'me@x.dev' }, { name: 'Cc', value: '"Doe, Jane" <jane@x.dev>' }, { name: 'Subject', value: subject }] },
  };
}
const graphLink = (folder: string, token: string) => `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;

// ── Pure ────────────────────────────────────────────────────────────────

describe('flags', () => {
  test('Gmail folders come from labels; archived is in none of them and not spam', async () => {
    const { gmailFlags } = await import('./mail-index');
    expect(gmailFlags(['INBOX', 'UNREAD', 'STARRED'])).toEqual({ inbox: true, sent: false, drafts: false, archive: false, trash: false, starred: true, unread: true });
    expect(gmailFlags(['CATEGORY_UPDATES']).archive).toBe(true);
    expect(gmailFlags(['SPAM']).archive).toBe(false);
    expect(gmailFlags(['SENT', 'TRASH'])).toMatchObject({ sent: true, trash: true, archive: false });
    expect(gmailFlags(undefined).archive).toBe(true);
  });

  test('Graph folders come from the folder read; star is the flag', async () => {
    const { graphFlags } = await import('./mail-index');
    expect(graphFlags({ isRead: false, flag: { flagStatus: 'flagged' } }, 'archive')).toEqual({ inbox: false, sent: false, drafts: false, archive: true, trash: false, starred: true, unread: true });
    expect(graphFlags({ isRead: true }, 'inbox')).toMatchObject({ inbox: true, starred: false, unread: false });
  });

  test('a row keeps headers only, with the preview cut to 300 characters', async () => {
    const { gmailIndexRow } = await import('./mail-index');
    const row = gmailIndexRow('u', gmailMessage('m1', 5, ['INBOX']))!;
    expect(row).toMatchObject({ messageId: 'm1', threadId: 't-m1', fromName: 'Anna', fromEmail: 'anna@acme.io', to: [{ email: 'me@x.dev' }], cc: [{ name: 'Doe, Jane', email: 'jane@x.dev' }], inbox: true, hasAttachments: null });
    expect(row.snippet?.length).toBe(300);
    expect(Object.keys(row)).not.toContain('body');
    // No date: no row (it could not be placed in a list).
    expect(gmailIndexRow('u', { ...gmailMessage('m2', 5, []), internalDate: undefined })).toBeNull();
  });
});

describe('change feeds', () => {
  test('Gmail history: later records win', async () => {
    const { parseGmailHistory } = await import('./mail-index');
    const { upsert, remove } = parseGmailHistory([
      { messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] },
      { labelsRemoved: [{ message: { id: 'c' } }] },
      { messagesDeleted: [{ message: { id: 'b' } }, { message: { id: 'd' } }] },
      { messagesAdded: [{ message: { id: 'd' } }] },
    ]);
    expect([...upsert].sort()).toEqual(['a', 'c', 'd']);
    expect([...remove]).toEqual(['b']);
  });

  test('Graph delta: removed entries apart from messages', async () => {
    const { parseGraphDelta } = await import('./mail-index');
    expect(parseGraphDelta([{ id: 'a', subject: 'x' }, { id: 'b', '@removed': { reason: 'deleted' } }, { id: '' } as never])).toEqual({ messages: [{ id: 'a', subject: 'x' }], removed: ['b'] });
  });

  test('only Graph\'s own mail folder links are followed', async () => {
    const { graphLinkPath } = await import('./mail-index');
    expect(graphLinkPath(graphLink('inbox', 'x'))).toBe('/me/mailFolders/inbox/messages/delta?$deltatoken=x');
    expect(graphLinkPath('https://evil.example/v1.0/me/mailFolders/inbox')).toBeNull();
    expect(graphLinkPath('https://graph.microsoft.com/v1.0/users/other/messages')).toBeNull();
    expect(graphLinkPath('http://graph.microsoft.com/v1.0/me/mailFolders/inbox')).toBeNull();
    expect(graphLinkPath(42)).toBeNull();
  });
});

describe('page tokens', () => {
  test('index and live tokens round-trip and never look like a provider token', async () => {
    const { indexToken, parseIndexToken, liveToken, parseLiveToken } = await import('./mail-index');
    const at = new Date('2026-11-01T10:00:00Z');
    const i = indexToken(at, 'm-1');
    expect(i.startsWith('i.')).toBe(true);
    expect(parseIndexToken(i)).toEqual({ at, id: 'm-1' });
    const l = liveToken(at, 'CAE');
    expect(l.startsWith('l.')).toBe(true);
    expect(parseLiveToken(l)).toEqual({ before: at, token: 'CAE' });
    expect(parseLiveToken(liveToken(at))).toEqual({ before: at });
    expect(parseIndexToken('i.garbage')).toBeNull();
    expect(parseLiveToken('l.e30')).toBeNull();
    // Gmail's alphabet has no dot; Graph's tokens start with s or k.
    expect(/^[A-Za-z0-9_-]+$/.test(i)).toBe(false);
  });
});

describe('freshness', () => {
  test('served only after the first read and while the last sync is recent; Outlook needs the folder read to its end', async () => {
    const { FRESH_MS, isFresh } = await import('./mail-index');
    const t = Date.now();
    const base = { provider: 'google', backfilledAt: new Date(t - 1000), lastSyncAt: new Date(t - 1000), coveredFrom: new Date(t - 1e9), folders: {} };
    expect(isFresh(base, 'inbox', t)).toBe(true);
    expect(isFresh(null, 'inbox', t)).toBe(false);
    expect(isFresh({ ...base, backfilledAt: null }, 'inbox', t)).toBe(false);
    expect(isFresh({ ...base, lastSyncAt: new Date(t - FRESH_MS - 1) }, 'inbox', t)).toBe(false);
    const outlook = { ...base, provider: 'microsoft', folders: { inbox: { complete: true }, sent: { complete: false } } };
    expect(isFresh(outlook, 'inbox', t)).toBe(true);
    expect(isFresh(outlook, 'sent', t)).toBe(false);
    expect(isFresh(outlook, 'starred', t)).toBe(false);
  });

  test('search words the index answers; operators go to the provider', async () => {
    const { indexSearchTerms } = await import('./mail-index');
    expect(indexSearchTerms('  invoice   march ')).toEqual(['invoice', 'march']);
    expect(indexSearchTerms('')).toEqual([]);
    expect(indexSearchTerms('from:anna')).toBeNull();
    expect(indexSearchTerms('"exact phrase"')).toBeNull();
    expect(indexSearchTerms('a OR b')).toBeNull();
  });
});

// ── Against the database ────────────────────────────────────────────────

process.env.STORAGE_MODE = 'embedded';
const dir = mkdtempSync(join(tmpdir(), 'octipus-mail-index-'));
process.env.DATA_DIR = dir;
process.env.LOG_LEVEL = 'error';
const owner = randomUUID();
const other = randomUUID();

describe('the index', () => {
  beforeAll(async () => {
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
    await (await import('@/db/migrate')).runMigrations();
    await (await import('@/test-helpers/multiuser-fixtures')).seedUsers([{ id: owner, username: 'index-owner' }, { id: other, username: 'index-other' }]);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { gmail.calls.length = 0; graph.calls.length = 0; });

  const rowsOf = async (userId: string, provider: string) => {
    const { getDb } = await import('@/db/postgres');
    const { emailIndex } = await import('@/db/schema/email-index');
    const { and, eq } = await import('drizzle-orm');
    return getDb().select().from(emailIndex).where(and(eq(emailIndex.userId, userId), eq(emailIndex.provider, provider)));
  };

  test('Gmail: the first open reads live and starts the index; then lists, pages and counts come from it, searches from the provider', async () => {
    gmail.messages = new Map([
      ['m1', gmailMessage('m1', 1, ['INBOX', 'UNREAD'], 'Invoice for March')],
      ['m2', gmailMessage('m2', 2, ['INBOX'])],
      ['m3', gmailMessage('m3', 3, ['INBOX', 'STARRED'])],
      ['m4', gmailMessage('m4', 4, ['SENT'])],
      ['m5', gmailMessage('m5', 5, [])],
      ['m6', gmailMessage('m6', 6, ['TRASH', 'STARRED'])],
    ]);
    gmail.inboxUnread = 7;
    const { listMessages } = await import('./mailbox');
    const index = await import('./mail-index');
    const first = await listMessages(owner, 'google', { folder: 'inbox', limit: 2 });
    // Not ready yet: the provider answered.
    expect(gmail.calls.some((c) => c.startsWith('GET /messages?maxResults=2'))).toBe(true);
    expect(first.nextPageToken?.startsWith('i.')).toBeFalsy();
    await index.syncMailIndex(owner, 'google');
    expect((await rowsOf(owner, 'google')).length).toBe(6);

    gmail.calls.length = 0;
    const page1 = await listMessages(owner, 'google', { folder: 'inbox', limit: 2 });
    expect(gmail.calls.filter((c) => c.startsWith('GET /messages'))).toEqual([]);
    expect(page1.items.map((it) => it.id)).toEqual(['m1', 'm2']);
    expect(page1.items[0]).toMatchObject({ unread: true, subject: 'Invoice for March', from: { name: 'Anna', email: 'anna@acme.io' }, threadId: 't-m1' });
    // The provider's own count, not the indexed window's.
    expect(page1.unreadCount).toBe(7);
    expect(page1.nextPageToken?.startsWith('i.')).toBe(true);
    const page2 = await listMessages(owner, 'google', { folder: 'inbox', limit: 2, pageToken: page1.nextPageToken });
    expect(page2.items.map((it) => it.id)).toEqual(['m3']);
    expect(page2.unreadCount).toBeUndefined();
    // Past the window the folder goes on live, with older mail only.
    expect(page2.nextPageToken?.startsWith('l.')).toBe(true);
    gmail.calls.length = 0;
    await listMessages(owner, 'google', { folder: 'inbox', limit: 2, pageToken: page2.nextPageToken });
    expect(gmail.calls.find((c) => c.startsWith('GET /messages?'))).toMatch(/q=before%3A\d+/);

    expect((await listMessages(owner, 'google', { folder: 'archive', limit: 10 })).items.map((it) => it.id)).toEqual(['m5']);
    // Starred mail in the trash is trash.
    expect((await listMessages(owner, 'google', { folder: 'starred', limit: 10 })).items.map((it) => it.id)).toEqual(['m3']);
    expect((await listMessages(owner, 'google', { folder: 'inbox', limit: 10, unread: true })).items.map((it) => it.id)).toEqual(['m1']);
    // A search goes to the provider even with the index fresh: only it can match a body or an attachment name.
    gmail.calls.length = 0;
    await listMessages(owner, 'google', { folder: 'inbox', limit: 10, q: 'invoice' });
    expect(gmail.calls.some((c) => c.startsWith('GET /messages?') && c.includes('invoice'))).toBe(true);
    // Only when the provider cannot answer does the index, with what headers match and no live continuation.
    gmail.searchFails = true;
    try {
      const fallback = await listMessages(owner, 'google', { folder: 'inbox', limit: 10, q: 'invoice MARCH' });
      expect(fallback.items.map((it) => it.id)).toEqual(['m1']);
      expect(fallback.nextPageToken).toBeUndefined();
      expect((await listMessages(owner, 'google', { folder: 'inbox', limit: 10, q: 'acme.io' })).items.map((it) => it.id)).toEqual(['m1', 'm2', 'm3']);
      // A "%" is a character, not a wildcard.
      expect((await listMessages(owner, 'google', { folder: 'inbox', limit: 10, q: '%' })).items).toEqual([]);
    } finally { gmail.searchFails = false; }
    gmail.calls.length = 0;
    await listMessages(owner, 'google', { folder: 'inbox', limit: 10, q: 'from:anna' });
    expect(gmail.calls.some((c) => c.includes('from%3Aanna'))).toBe(true);
    // Another user sees nothing of it.
    expect((await rowsOf(other, 'google')).length).toBe(0);
  });

  test('Gmail: history adds, archives and deletes; an action shows at once; history too old reads again', async () => {
    const index = await import('./mail-index');
    gmail.messages.set('m7', gmailMessage('m7', 0, ['INBOX', 'UNREAD'], 'Brand new'));
    gmail.messages.set('m2', gmailMessage('m2', 2, []));
    gmail.messages.delete('m3');
    gmail.history = [
      { messagesAdded: [{ message: { id: 'm7' } }] },
      { labelsRemoved: [{ message: { id: 'm2' } }] },
      { messagesDeleted: [{ message: { id: 'm3' } }] },
    ];
    gmail.historyId = '120';
    gmail.inboxUnread = 8;
    await index.syncMailIndex(owner, 'google');
    expect(gmail.calls.some((c) => c.startsWith('GET /history?startHistoryId=100'))).toBe(true);
    const { listMessages, batchAction } = await import('./mailbox');
    const inbox = await listMessages(owner, 'google', { folder: 'inbox', limit: 10 }, false);
    expect(inbox.items.map((it) => it.id)).toEqual(['m7', 'm1']);
    expect(inbox.unreadCount).toBe(8);
    expect((await listMessages(owner, 'google', { folder: 'archive', limit: 10 })).items.map((it) => it.id)).toEqual(['m2', 'm5']);

    // Read: the row and the count move before any sync.
    await batchAction(owner, 'google', ['m7'], 'read');
    const after = await listMessages(owner, 'google', { folder: 'inbox', limit: 10 });
    expect(after.items.find((it) => it.id === 'm7')?.unread).toBe(false);
    expect(after.unreadCount).toBe(7);
    await batchAction(owner, 'google', ['m1'], 'archive');
    expect((await listMessages(owner, 'google', { folder: 'inbox', limit: 10 })).items.map((it) => it.id)).toEqual(['m7']);
    expect((await listMessages(owner, 'google', { folder: 'inbox', limit: 10 })).unreadCount).toBe(6);

    gmail.historyGone = true;
    gmail.calls.length = 0;
    await index.syncMailIndex(owner, 'google');
    gmail.historyGone = false;
    expect(gmail.calls).toContain('GET /profile');
    expect((await rowsOf(owner, 'google')).map((r) => r.messageId).sort()).toEqual([...gmail.messages.keys()].sort());
  });

  test('Outlook: each folder\'s delta, a missing archive folder, removals, and folders not read to the end are served live', async () => {
    const index = await import('./mail-index');
    const msg = (id: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
      id, conversationId: `c-${id}`, subject: `Outlook ${id}`, receivedDateTime: new Date(now - minutesAgo * 60_000).toISOString(), isRead: true,
      from: { emailAddress: { name: 'Ben', address: 'ben@corp.example' } }, toRecipients: [{ emailAddress: { address: 'me@corp.example' } }], hasAttachments: true, bodyPreview: 'Hi', ...extra,
    });
    graph.pages = new Map<string, unknown>([
      ['/me/mailFolders/inbox/messages/delta?$select', { value: [msg('o1', 1, { isRead: false }), msg('o2', 2)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=p2' }],
      ['/me/mailFolders/inbox/messages/delta?$skiptoken=p2', { value: [msg('o3', 3, { flag: { flagStatus: 'flagged' } })], '@odata.deltaLink': graphLink('inbox', 'd1') }],
      ['/me/mailFolders/sentitems/messages/delta', { value: [msg('o4', 4)], '@odata.deltaLink': graphLink('sentitems', 'd1') }],
      ['/me/mailFolders/drafts/messages/delta', { value: [], '@odata.deltaLink': graphLink('drafts', 'd1') }],
      ['/me/mailFolders/archive/messages/delta', new Error('Mail provider returned an error (HTTP 404).')],
      ['/me/mailFolders/deleteditems/messages/delta', { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems/messages/delta?$skiptoken=never' }],
      ['/me/mailFolders/deleteditems/messages/delta?$skiptoken=never', new Error('Mail provider returned an error (HTTP 503).')],
    ]);
    graph.unread = 3;
    const { listMessages } = await import('./mailbox');
    // The first open starts the index (and reads live meanwhile).
    await listMessages(owner, 'microsoft', { folder: 'sent', limit: 10 });
    await expect(index.syncMailIndex(owner, 'microsoft')).rejects.toThrow(/503/);
    expect((await index.mailIndexStatus(owner)).mailboxes.find((m) => m.provider === 'microsoft')).toMatchObject({ status: 'error' });
    // The trash failed: the first read is not finished, so nothing is served yet.
    graph.calls.length = 0;
    await listMessages(owner, 'microsoft', { folder: 'inbox', limit: 10 });
    expect(graph.calls.some((c) => c.startsWith('/me/mailFolders/inbox/messages?'))).toBe(true);

    graph.pages.set('/me/mailFolders/deleteditems/messages/delta?$skiptoken=never', { value: [], '@odata.deltaLink': graphLink('deleteditems', 'd1') });
    await index.syncMailIndex(owner, 'microsoft');
    const status = await index.mailIndexStatus(owner);
    expect(status.mailboxes.find((m) => m.provider === 'microsoft')).toMatchObject({ status: 'ready', messages: 4 });
    graph.calls.length = 0;
    const inbox = await listMessages(owner, 'microsoft', { folder: 'inbox', limit: 10 });
    expect(graph.calls.filter((c) => c.includes('/messages?'))).toEqual([]);
    expect(inbox.items.map((it) => it.id)).toEqual(['o1', 'o2', 'o3']);
    expect(inbox.items[0]).toMatchObject({ unread: true, hasAttachments: true, provider: 'microsoft' });
    expect(inbox.unreadCount).toBe(3);
    expect((await listMessages(owner, 'microsoft', { folder: 'starred', limit: 10 })).items.map((it) => it.id)).toEqual(['o3']);

    // The next sync continues from the delta links.
    graph.pages.set('/me/mailFolders/inbox/messages/delta?$deltatoken=d1', { value: [{ id: 'o2', '@removed': { reason: 'deleted' } }, msg('o5', 0)], '@odata.deltaLink': graphLink('inbox', 'd2') });
    for (const f of ['sentitems', 'drafts', 'deleteditems']) graph.pages.set(`/me/mailFolders/${f}/messages/delta?$deltatoken=d1`, { value: [], '@odata.deltaLink': graphLink(f, 'd1') });
    await index.syncMailIndex(owner, 'microsoft');
    expect(graph.calls).toContain('/me/mailFolders/inbox/messages/delta?$deltatoken=d1');
    expect((await listMessages(owner, 'microsoft', { folder: 'inbox', limit: 10 })).items.map((it) => it.id)).toEqual(['o5', 'o1', 'o3']);

    // A move gives the message a new id on Outlook: its row goes, the sync brings the new one.
    const { batchAction } = await import('./mailbox');
    await batchAction(owner, 'microsoft', ['o1'], 'archive');
    expect((await listMessages(owner, 'microsoft', { folder: 'inbox', limit: 10 })).items.map((it) => it.id)).toEqual(['o5', 'o3']);
  });

  test('the sweep syncs due mailboxes and drops the index of one no longer connected', async () => {
    const { getDb } = await import('@/db/postgres');
    const { emailIndexState } = await import('@/db/schema/email-index');
    const { eq } = await import('drizzle-orm');
    const index = await import('./mail-index');
    await getDb().update(emailIndexState).set({ nextSyncAt: new Date(0) }).where(eq(emailIndexState.userId, owner));
    connected = ['google'];
    gmail.history = [];
    gmail.calls.length = 0;
    expect(await index.syncDueMailIndexes(new Date())).toBe(1);
    expect(gmail.calls.some((c) => c.startsWith('GET /history'))).toBe(true);
    expect(await rowsOf(owner, 'microsoft')).toEqual([]);
    expect((await index.mailIndexStatus(owner)).mailboxes.map((m) => m.provider)).toEqual(['google']);
    // Claimed: a second sweep right away does nothing.
    expect(await index.syncDueMailIndexes(new Date())).toBe(0);
    connected = ['google', 'microsoft'];
  });

  test('another account of the provider is never served from, or written into, the default account\'s index', async () => {
    const index = await import('./mail-index');
    const { inMailbox } = await import('./account-context');
    const before = await rowsOf(owner, 'google');
    expect(before.length).toBeGreaterThan(0);
    const live = vi.fn(async () => ({ provider: 'google' as const, items: [] }));
    const second = { provider: 'google' as const, account: 'second@x.dev' };
    const page = await inMailbox(second, () => index.listWithIndex(owner, 'google', { folder: 'inbox', limit: 25 }, false, live));
    expect(live).toHaveBeenCalledWith({ folder: 'inbox', limit: 25 });
    expect(page.items).toEqual([]);
    // An action on the second account's mail leaves the default's rows as they were.
    await inMailbox(second, () => index.applyIndexAction(owner, 'google', before.map((r) => r.messageId), 'trash'));
    expect((await rowsOf(owner, 'google')).map((r) => [r.messageId, r.trash])).toEqual(before.map((r) => [r.messageId, r.trash]));
  });

  test('disconnecting a provider deletes its index', async () => {
    const index = await import('./mail-index');
    expect((await rowsOf(owner, 'google')).length).toBeGreaterThan(0);
    await index.forgetMailIndex(owner, 'microsoft');
    expect((await rowsOf(owner, 'google')).length).toBeGreaterThan(0);
    await index.forgetMailIndex(owner, 'google');
    expect(await rowsOf(owner, 'google')).toEqual([]);
    expect((await index.mailIndexStatus(owner)).mailboxes).toEqual([]);
  });

  test('off: every row goes at once, nothing is synced or stored, and lists are live', async () => {
    const index = await import('./mail-index');
    const { listMessages } = await import('./mailbox');
    await listMessages(other, 'google', { folder: 'inbox', limit: 3 });
    await index.syncMailIndex(other, 'google');
    expect((await rowsOf(other, 'google')).length).toBeGreaterThan(0);
    const off = await index.setMailIndexEnabled(other, false);
    expect(off).toEqual({ enabled: false, mailboxes: [] });
    expect(await rowsOf(other, 'google')).toEqual([]);
    gmail.calls.length = 0;
    await listMessages(other, 'google', { folder: 'sent', limit: 3 });
    expect(gmail.calls.some((c) => c.startsWith('GET /messages?'))).toBe(true);
    await index.syncMailIndex(other, 'google');
    expect(await rowsOf(other, 'google')).toEqual([]);
    expect((await index.mailIndexStatus(other)).mailboxes).toEqual([]);
    expect((await index.setMailIndexEnabled(other, true)).enabled).toBe(true);
  });
});
