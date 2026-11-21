/** IMAP / POP3 mailboxes in the Email page's shapes, their protection gate, and the mailboxes a triage run may cover. */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ContentRepos } from '@/db/repositories/content';
import type { MailMessageSummary, MailMessageView } from '@/shared/mail';

vi.mock('./triage-labels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./triage-labels')>()),
  storedTriage: vi.fn(async (_user: string, _mailbox: string, ids: string[]) => (ids.includes(M1) ? { [M1]: { priority: 'high', category: 'work', source: 'llm' } } : {})),
}));
let connected: string[] = ['google'];
vi.mock('./mailbox', () => ({
  resolveProvider: vi.fn(async (_user: string, requested?: string | null) => {
    if (!requested) return connected[0] ?? null;
    if (!connected.includes(requested)) throw new Error(`${requested} is not connected.`);
    return requested;
  }),
}));

const {
  IMAP_FOLDER_STATUS, ImapMailboxError, imapAiRefusal, imapItem, imapItemsByIds, imapMessage, imapPageToken, listImap, parseImapPageToken,
} = await import('./imap-mailbox');
const { checkMailbox, keepForTriage, TriageSourceError, triageSources } = await import('./triage-sources');

const ACCOUNT = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000001';
const OTHER = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000002';
const M1 = '1b9d3c55-5f2c-4c37-9a3e-6d1f00000001';
const M2 = '1b9d3c55-5f2c-4c37-9a3e-6d1f00000002';
const BOX = `imap:${ACCOUNT}` as const;
const date = new Date('2026-11-20T10:00:00.000Z');

const summary = (id: string, extra: Partial<MailMessageSummary> = {}): MailMessageSummary => ({
  id, accountId: ACCOUNT, status: 'received', from: { name: 'Clerk', address: 'clerk@office.example' }, to: [{ address: 'info@us.example' }],
  subject: `Subject ${id.slice(-1)}`, snippet: 'Hello', date: date.toISOString(), unread: true, hasAttachments: false, protectionLevel: 3, ...extra,
});
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, accountId: ACCOUNT, status: 'received', fromAddress: { name: 'Clerk', address: 'clerk@office.example' }, toAddresses: [{ address: 'info@us.example' }],
  ccAddresses: [], subject: `Subject ${id.slice(-1)}`, snippet: 'Hello', date, unread: true, attachments: [], protectionLevel: 3, ...extra,
});

/** The parts of the content scope the adapter reads, over a fixed set of rows. */
function repos(rows = [row(M1), row(M2)], accounts = [ACCOUNT]) {
  const list = vi.fn(async (filter: { limit?: number }) => rows.slice(0, filter.limit ?? 50));
  return {
    list,
    mail: {
      account: async (id: string) => (accounts.includes(id) ? { id, enabled: true, workspaceId: null } : null),
      list,
      unreadCount: async () => 7,
      findByIds: async (ids: string[]) => rows.filter((r) => ids.includes(r.id)),
      message: async (id: string) => rows.find((r) => r.id === id) ?? null,
      raw: async () => null,
    },
  } as unknown as ContentRepos & { list: typeof list };
}

describe('the shapes', () => {
  test('a stored message is a list row of its mailbox', () => {
    expect(imapItem(summary(M1))).toEqual({
      id: M1, provider: 'imap', mailbox: BOX, status: 'received', from: { name: 'Clerk', email: 'clerk@office.example' },
      to: [{ email: 'info@us.example' }], subject: 'Subject 1', snippet: 'Hello', receivedAt: date.toISOString(), unread: true, hasAttachments: false,
    });
  });

  test('attachments are listed only when they can be downloaded; a draft carries its revision', () => {
    const view: MailMessageView = { ...summary(M1, { status: 'draft' }), revision: 'a'.repeat(64), cc: [], messageIdHeader: null, inReplyTo: null, text: 'Body', html: '<p>Body</p>', attachments: [{ index: 0, filename: 'a.pdf', contentType: 'application/pdf', size: 10 }], rawKept: false, error: 'SMTP said no' };
    expect(imapMessage(view)).toMatchObject({ body: 'Body', html: '<p>Body</p>', attachments: [], revision: 'a'.repeat(64), sendError: 'SMTP said no', status: 'draft' });
    expect(imapMessage({ ...view, rawKept: true }).attachments).toEqual([{ id: '0', name: 'a.pdf', size: 10, contentType: 'application/pdf' }]);
  });

  test('folders are the stored statuses', () => {
    expect(IMAP_FOLDER_STATUS).toEqual({ inbox: 'received', sent: 'sent', drafts: 'draft', failed: 'failed' });
  });

  test('page tokens carry the last row and nothing else', () => {
    const token = imapPageToken({ id: M1, receivedAt: date.toISOString() });
    expect(parseImapPageToken(token)).toEqual({ date, id: M1 });
    for (const bad of ['', 'x', `${date.toISOString()}~nope`, `garbage~${M1}`, `${token}~more`]) expect(parseImapPageToken(bad)).toBeNull();
  });
});

describe('listImap', () => {
  test('one page of a folder, newest first, with the reader\'s triage, the next page and the unread count', async () => {
    const r = repos();
    const page = await listImap(r, 'u', ACCOUNT, { folder: 'inbox', limit: 2 });
    expect(r.list).toHaveBeenCalledWith({ accountId: ACCOUNT, status: 'received', unread: false, limit: 2 });
    expect(page).toMatchObject({ provider: null, mailbox: BOX, unreadCount: 7, nextPageToken: imapPageToken({ id: M2, receivedAt: date.toISOString() }) });
    expect(page.items.map((it) => it.triage)).toEqual([{ priority: 'high', category: 'work', source: 'llm' }, undefined]);
    const next = await listImap(r, 'u', ACCOUNT, { folder: 'sent', limit: 25, pageToken: page.nextPageToken, q: ' invoice ' });
    expect(r.list).toHaveBeenLastCalledWith({ accountId: ACCOUNT, status: 'sent', unread: false, q: 'invoice', before: { date, id: M2 }, limit: 25 });
    expect(next).not.toHaveProperty('unreadCount');
    expect(next).not.toHaveProperty('nextPageToken');
  });

  test('a mailbox the scope does not reach is not found, and a forged page token is refused', async () => {
    await expect(listImap(repos(), 'u', OTHER, { folder: 'inbox', limit: 5 })).rejects.toMatchObject({ status: 404 });
    await expect(listImap(repos(), 'u', ACCOUNT, { folder: 'inbox', limit: 5, pageToken: 'drop table' })).rejects.toBeInstanceOf(ImapMailboxError);
  });
});

describe('the protection gate', () => {
  const deps = (on: boolean, local: boolean) => ({ protectionOn: () => on, modelsLocal: vi.fn(async () => local) });

  test('with protection off, or at level 1-2, mail may go to the models', async () => {
    expect(await imapAiRefusal('u', 4, 'everyday', deps(false, false))).toBeNull();
    expect(await imapAiRefusal('u', 2, 'triage', deps(true, false))).toBeNull();
  });

  test('at level 3-4 (unclear counts as 4) only to local models', async () => {
    expect(await imapAiRefusal('u', null, 'everyday', deps(true, false))).toMatch(/protection level 4 \(not classified\).*everyday model is not local/);
    expect(await imapAiRefusal('u', 3, 'triage', deps(true, false))).toMatch(/level 3.*triage models are not local/);
    expect(await imapAiRefusal('u', 4, 'triage', deps(true, true))).toBeNull();
  });

  test('triage leaves out what may not go, and counts it', async () => {
    const rows = [{ item: imapItem(summary(M1)), level: 3 }, { item: imapItem(summary(M2)), level: 1 }, { item: imapItem(summary(M1)), level: null }];
    const d = deps(true, false);
    expect(await keepForTriage('u', rows, d)).toEqual({ items: [rows[1].item], protected: 2 });
    // One verdict per level, not one per mail.
    expect(d.modelsLocal).toHaveBeenCalledTimes(2);
  });
});

describe('the mailboxes of a triage run', () => {
  beforeEach(() => { connected = ['google']; });
  const open = { protectionOn: () => false, modelsLocal: async () => false };

  test('IMAP mail is read from the store, never from what the client sent', async () => {
    const [source] = await triageSources(repos(), 'u', {
      fallback: 'google',
      items: [{ id: M1, mailbox: BOX, from: { email: 'forged@evil.example' }, subject: 'Forged', snippet: '' }],
    }, open);
    expect(source.mailbox).toBe(BOX);
    expect(source.items).toEqual([imapItem(summary(M1))]);
  });

  test('rows go to their own mailbox; the rest to the request\'s', async () => {
    const sources = await triageSources(repos(), 'u', {
      fallback: 'google',
      items: [{ id: 'g1', from: { email: 'a@b.c' }, subject: 's', snippet: '' }, { id: M2, mailbox: BOX, from: { email: 'x@y.z' }, subject: 's', snippet: '' }],
    }, open);
    expect(sources.map((s) => [s.mailbox, s.items?.map((it) => it.id)])).toEqual([['google', ['g1']], [BOX, [M2]]]);
    expect(sources[0].items?.[0].provider).toBe('google');
  });

  test('a mailbox the caller cannot reach, or that is not connected, is refused', async () => {
    await expect(checkMailbox(repos(), 'u', `imap:${OTHER}`)).rejects.toBeInstanceOf(TriageSourceError);
    await expect(checkMailbox(repos(), 'u', 'microsoft')).rejects.toThrow(/not connected/);
    await expect(checkMailbox(repos(), 'u', 'imap:../etc')).rejects.toThrow(/Unknown mailbox/);
    expect(await checkMailbox(repos(), 'u', BOX)).toBe(BOX);
  });

  test('"newest" reads each inbox: IMAP through the scope, minus what protection keeps back', async () => {
    connected = ['google', 'microsoft'];
    const sources = await triageSources(repos(), 'u', { fallback: 'google', mailboxes: ['google', 'microsoft', BOX] }, { protectionOn: () => true, modelsLocal: async () => false });
    expect(sources.map((s) => s.mailbox)).toEqual(['google', 'microsoft', BOX]);
    expect(sources[0].newest).toBeUndefined();
    expect(await sources[2].newest!(10)).toEqual({ items: [], protected: 2 });
  });

  test('imapItemsByIds keeps only received mail of that account', async () => {
    const rows = await imapItemsByIds(repos([row(M1), row(M2, { status: 'draft' }), row(OTHER, { accountId: OTHER })]), ACCOUNT, [M1, M2, OTHER]);
    expect(rows.map((r) => r.item.id)).toEqual([M1]);
  });
});
