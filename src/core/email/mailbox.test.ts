import { beforeEach, describe, expect, test, vi } from 'vitest';

interface Call { api: 'gmail' | 'graph' | 'batch' | 'bytes'; method?: string; path: string; body?: unknown }
const calls: Call[] = [];
let connected: string[] = ['google', 'microsoft'];
let gmail: (method: string, path: string, body?: unknown) => unknown = () => ({});
let graph: (method: string, path: string, body?: unknown) => unknown = () => ({});
let batch: (body: string, boundary: string) => { contentType: string; text: string } = () => { throw new Error('batch down'); };

vi.mock('./providers', () => ({
  detectProvider: async () => connected[0] ?? null,
  connectedProviders: async () => connected,
  gmailApi: async (_u: string, method: string, path: string, body?: unknown) => { calls.push({ api: 'gmail', method, path, body }); return gmail(method, path, body); },
  graphApi: async (_u: string, method: string, path: string, body?: unknown) => { calls.push({ api: 'graph', method, path, body }); return graph(method, path, body); },
  gmailBatch: async (_u: string, body: string, boundary: string) => { calls.push({ api: 'batch', path: body }); return batch(body, boundary); },
  graphBytes: async (_u: string, path: string) => { calls.push({ api: 'bytes', path }); return new Uint8Array([1, 2, 3]); },
}));

const mailbox = await import('./mailbox');
const { MailboxError } = mailbox;

const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  id, threadId: `t-${id}`, snippet: `snippet ${id}`, labelIds: ['INBOX', 'UNREAD', 'STARRED'], internalDate: '1748736000000',
  payload: { headers: [{ name: 'From', value: 'Ann <ann@x.com>' }, { name: 'To', value: '"Doe, Jo" <jo@x.com>, me@x.com' }, { name: 'Subject', value: `Subject ${id}` }] },
  ...extra,
});
const batchAnswer = (items: Array<[number, number, unknown]>) => ({
  contentType: 'multipart/mixed; boundary=resp',
  text: `${items.map(([i, status, body]) => `--resp\r\nContent-Type: application/http\r\nContent-ID: <response-item-${i}>\r\n\r\nHTTP/1.1 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}\r\n`).join('')}--resp--`,
});

let user = 0;
const nextUser = () => `user-${++user}`;

beforeEach(() => {
  calls.length = 0;
  connected = ['google', 'microsoft'];
  gmail = () => ({});
  graph = () => ({});
  batch = () => { throw new Error('batch down'); };
});

describe('resolveProvider', () => {
  test('the default mailbox, a named one, and a named one that is not connected', async () => {
    expect(await mailbox.resolveProvider('u')).toBe('google');
    expect(await mailbox.resolveProvider('u', 'microsoft')).toBe('microsoft');
    connected = ['google'];
    await expect(mailbox.resolveProvider('u', 'microsoft')).rejects.toThrow('Microsoft 365 is not connected');
    await expect(mailbox.resolveProvider('u', 'yahoo')).rejects.toThrow(MailboxError);
    connected = [];
    expect(await mailbox.resolveProvider('u')).toBeNull();
  });
});

describe('gmailListPath', () => {
  const base = { limit: 25 };
  test('each folder', () => {
    expect(mailbox.gmailListPath({ ...base, folder: 'inbox' })).toBe('/messages?maxResults=25&labelIds=INBOX');
    expect(mailbox.gmailListPath({ ...base, folder: 'starred' })).toBe('/messages?maxResults=25&labelIds=STARRED');
    expect(mailbox.gmailListPath({ ...base, folder: 'sent' })).toBe('/messages?maxResults=25&labelIds=SENT');
    expect(mailbox.gmailListPath({ ...base, folder: 'drafts' })).toBe('/messages?maxResults=25&labelIds=DRAFT');
    expect(mailbox.gmailListPath({ ...base, folder: 'trash' })).toBe('/messages?maxResults=25&labelIds=TRASH&includeSpamTrash=true');
    expect(mailbox.gmailListPath({ ...base, folder: 'archive' })).toBe(`/messages?maxResults=25&q=${encodeURIComponent('-in:inbox -in:sent -in:drafts -in:chats')}`);
  });
  test('unread, search and paging', () => {
    expect(mailbox.gmailListPath({ ...base, folder: 'inbox', unread: true, q: '  from:ann   invoice & more ', pageToken: 'AbC_-123' }))
      .toBe(`/messages?maxResults=25&labelIds=INBOX&labelIds=UNREAD&q=${encodeURIComponent('from:ann invoice & more')}&pageToken=AbC_-123`);
    expect(() => mailbox.gmailListPath({ ...base, folder: 'inbox', pageToken: 'x&labelIds=TRASH' })).toThrow(MailboxError);
  });
});

describe('Graph list paths and page tokens', () => {
  const base = { limit: 25 };
  const select = '$select=id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments,flag';
  test('the inbox is the inbox folder, not every message', () => {
    expect(mailbox.graphListPath({ ...base, folder: 'inbox' })).toBe(`/me/mailFolders/inbox/messages?${select}&$top=25&$orderby=receivedDateTime%20desc`);
    expect(mailbox.graphListPath({ ...base, folder: 'sent', pageToken: 's50' })).toBe(`/me/mailFolders/sentitems/messages?${select}&$top=25&$orderby=receivedDateTime%20desc&$skip=50`);
    expect(mailbox.graphListPath({ ...base, folder: 'drafts' })).toContain('/me/mailFolders/drafts/messages?');
    expect(mailbox.graphListPath({ ...base, folder: 'archive' })).toContain('/me/mailFolders/archive/messages?');
    expect(mailbox.graphListPath({ ...base, folder: 'trash' })).toContain('/me/mailFolders/deleteditems/messages?');
  });
  test('filters lead with the sort property', () => {
    expect(decodeURIComponent(mailbox.graphListPath({ ...base, folder: 'starred', unread: true })))
      .toBe(`/me/messages?${select}&$top=25&$filter=receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false and flag/flagStatus eq 'flagged'&$orderby=receivedDateTime desc`);
  });
  test('a search has no $orderby, $filter or $skip, and cannot break out of its quotes', () => {
    const path = decodeURIComponent(mailbox.graphListPath({ ...base, folder: 'inbox', unread: true, q: 'budget" OR "x\\', pageToken: 'kABC-123' }));
    expect(path).toBe(`/me/mailFolders/inbox/messages?${select}&$top=25&$search="budget  OR  x isread:false"&$skiptoken=ABC-123`);
    expect(path).not.toMatch(/\$orderby|\$filter|\$skip=/);
    expect(() => mailbox.graphListPath({ ...base, folder: 'inbox', q: 'x', pageToken: 's25' })).toThrow(MailboxError);
    expect(() => mailbox.graphListPath({ ...base, folder: 'inbox', pageToken: 'kABC' })).toThrow(MailboxError);
  });
  test('a page token is never a URL', () => {
    for (const bad of ['https://graph.microsoft.com/v1.0/me/messages?$skip=10', 's-1', 's12345678', 'k', 'k a', 'k"x', 'x10', 'k&$select=body']) {
      expect(() => mailbox.parseGraphPageToken(bad)).toThrow(MailboxError);
    }
    expect(mailbox.parseGraphPageToken(undefined)).toEqual({ skip: 0 });
    expect(mailbox.parseGraphPageToken('s75')).toEqual({ skip: 75 });
  });
  test('only the skip token of a next link from Graph itself is kept', () => {
    expect(mailbox.graphNextPageToken('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$search=%22x%22&$skiptoken=AbC%3D%3D')).toBe('kAbC==');
    expect(mailbox.graphNextPageToken('https://evil.example/v1.0/me/messages?$skiptoken=AbC')).toBeUndefined();
    expect(mailbox.graphNextPageToken('http://graph.microsoft.com/v1.0/me/messages?$skiptoken=AbC')).toBeUndefined();
    expect(mailbox.graphNextPageToken('https://graph.microsoft.com/v1.0/me/messages?$skip=10')).toBeUndefined();
    expect(mailbox.graphNextPageToken(undefined)).toBeUndefined();
  });
});

describe('listMessages', () => {
  test('Gmail: one list call and one batch for the page', async () => {
    gmail = (_m, path) => (path.startsWith('/messages?') ? { messages: [{ id: 'a1' }, { id: 'b2' }], nextPageToken: 'next_1' } : path === '/labels/INBOX' ? { messagesUnread: 7 } : {});
    batch = () => batchAnswer([[1, 200, meta('b2')], [0, 200, meta('a1')]]);
    const page = await mailbox.listMessages(nextUser(), 'google', { folder: 'inbox', limit: 25 });
    expect(page.items.map((it) => it.id)).toEqual(['a1', 'b2']);
    expect(page.items[0]).toMatchObject({ provider: 'google', from: { name: 'Ann', email: 'ann@x.com' }, to: [{ name: 'Doe, Jo', email: 'jo@x.com' }, { email: 'me@x.com' }], unread: true, starred: true, subject: 'Subject a1' });
    expect(page.items[0].hasAttachments).toBeUndefined(); // list metadata cannot tell
    expect(page.nextPageToken).toBe('next_1');
    expect(page.unreadCount).toBe(7);
    expect(calls.filter((c) => c.api === 'gmail' && c.path.startsWith('/messages/')).length).toBe(0);
    expect(calls.find((c) => c.api === 'batch')?.path).toContain('GET /gmail/v1/users/me/messages/a1?format=metadata');
  });

  test('Gmail: what the batch does not answer is fetched on its own; a failed batch falls back for all', async () => {
    gmail = (_m, path) => {
      if (path.startsWith('/messages?')) return { messages: [{ id: 'a1' }, { id: 'b2' }, { id: 'c3' }] };
      if (path.startsWith('/messages/c3')) throw new Error('gone');
      const id = path.match(/^\/messages\/(\w+)\?/)?.[1];
      return id ? meta(id) : {};
    };
    // b2 answers 404 in the batch; a1 answers with another message's id (never trusted).
    batch = () => batchAnswer([[0, 200, meta('zz')], [1, 404, { error: {} }], [2, 200, meta('c3')]]);
    const page = await mailbox.listMessages(nextUser(), 'google', { folder: 'sent', limit: 25 });
    expect(page.items.map((it) => it.id)).toEqual(['a1', 'b2', 'c3']);
    expect(page.unreadCount).toBeUndefined();

    calls.length = 0;
    batch = () => { throw new Error('batch down'); };
    const fallback = await mailbox.listMessages(nextUser(), 'google', { folder: 'sent', limit: 25 });
    expect(fallback.items.map((it) => it.id)).toEqual(['a1', 'b2']); // c3 cannot be read: left out, the list still loads
    expect(calls.filter((c) => c.api === 'gmail' && c.path.startsWith('/messages/')).length).toBe(3);
  });

  test('Graph: rows, offset paging, search paging by skip token', async () => {
    const row = (id: string) => ({ id, conversationId: `c-${id}`, subject: `S ${id}`, bodyPreview: 'p', receivedDateTime: '2025-06-01T08:00:00Z', isRead: false, hasAttachments: true, flag: { flagStatus: 'flagged' }, from: { emailAddress: { address: 'bob@corp.com' } }, toRecipients: [{ emailAddress: { address: 'me@x.com' } }] });
    graph = (_m, path) => (path.includes('unreadItemCount') ? { unreadItemCount: 3 } : { value: [row('m1'), row('m2')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=TOK1' });
    const u = nextUser();
    const page = await mailbox.listMessages(u, 'microsoft', { folder: 'inbox', limit: 2 });
    expect(page).toMatchObject({ provider: 'microsoft', nextPageToken: 's2', unreadCount: 3 });
    expect(page.items[0]).toMatchObject({ id: 'm1', threadId: 'c-m1', unread: true, starred: true, hasAttachments: true, to: [{ email: 'me@x.com' }] });
    const search = await mailbox.listMessages(u, 'microsoft', { folder: 'inbox', limit: 2, q: 'budget' });
    expect(search.nextPageToken).toBe('kTOK1');
    expect(search.unreadCount).toBeUndefined();
  });

  test('a page is remembered per user for a short while, and forgotten on invalidate or refresh', async () => {
    let lists = 0;
    gmail = (_m, path) => { if (path.startsWith('/messages?')) lists++; return { messages: [] }; };
    const a = nextUser();
    const b = nextUser();
    const opts = { folder: 'inbox' as const, limit: 25 };
    await mailbox.listMessages(a, 'google', opts);
    await mailbox.listMessages(a, 'google', opts);
    expect(lists).toBe(1);
    await mailbox.listMessages(b, 'google', opts); // never another user's page
    expect(lists).toBe(2);
    await mailbox.listMessages(a, 'google', { ...opts, q: 'x' });
    expect(lists).toBe(3);
    await mailbox.listMessages(a, 'google', opts, true);
    expect(lists).toBe(4);
    mailbox.invalidateEmailCache(a);
    await mailbox.listMessages(a, 'google', opts);
    await mailbox.listMessages(b, 'google', opts);
    expect(lists).toBe(5);
  });
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
const FULL = {
  id: 'g1', threadId: 't1', labelIds: ['INBOX'], internalDate: '1748736000000',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [{ name: 'From', value: 'ann@x.com' }, { name: 'To', value: 'me@x.com' }, { name: 'Cc', value: 'Bo <bo@x.com>' }, { name: 'Subject', value: 'Files' }],
    parts: [
      { partId: '0', mimeType: 'multipart/related', parts: [
        { partId: '0.0', mimeType: 'text/html', body: { data: b64('<p>Body</p><img src="https://t.example/p.gif">') } },
        { partId: '0.1', mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline; filename="logo.png"' }, { name: 'Content-ID', value: '<logo>' }], body: { attachmentId: 'att-inline', size: 10 } },
      ] },
      { partId: '1', mimeType: 'Application/PDF', filename: 'invoice.pdf', body: { attachmentId: 'att-pdf', size: 1234 } },
      { partId: '2', mimeType: 'message/rfc822', parts: [{ partId: '2.0', mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('small file'), size: 10 } }] },
    ],
  },
};

describe('reading', () => {
  test('Gmail message: cc, and attachments at any depth without the inline image', async () => {
    gmail = () => FULL;
    const msg = await mailbox.readMessage('u', 'google', 'g/1');
    expect(calls[0].path).toBe('/messages/g%2F1?format=full');
    expect(msg.cc).toEqual([{ name: 'Bo', email: 'bo@x.com' }]);
    expect(msg.hasAttachments).toBe(true);
    expect(msg.attachments).toEqual([
      { id: '1', name: 'invoice.pdf', size: 1234, contentType: 'application/pdf' },
      { id: '2.0', name: 'notes.txt', size: 10, contentType: 'text/plain' },
    ]);
    expect(msg.html).toContain('data-remote-src="https://t.example/p.gif"');
  });

  test('Graph message: attachments are listed only when it has some, and a failed list does not hide the mail', async () => {
    const base = { id: 'm1', subject: 'S', body: { contentType: 'text', content: 'Hello' }, ccRecipients: [{ emailAddress: { address: 'bo@x.com' } }] };
    graph = () => ({ ...base, hasAttachments: false });
    expect((await mailbox.readMessage('u', 'microsoft', 'm1')).attachments).toBeUndefined();
    expect(calls.length).toBe(1);
    graph = (_m, path) => (path.includes('/attachments') ? { value: [{ id: 'A1', name: 'a.pdf', size: 5, contentType: 'application/pdf' }, { id: 'A2', name: 'sig.png', isInline: true }] } : { ...base, hasAttachments: true });
    const msg = await mailbox.readMessage('u', 'microsoft', 'm1');
    expect(msg.attachments).toEqual([{ id: 'A1', name: 'a.pdf', size: 5, contentType: 'application/pdf' }]);
    expect(msg.cc).toEqual([{ name: undefined, email: 'bo@x.com' }]);
    graph = (_m, path) => { if (path.includes('/attachments')) throw new Error('x'); return { ...base, hasAttachments: true }; };
    expect((await mailbox.readMessage('u', 'microsoft', 'm1')).body).toBe('Hello');
  });

  test('a thread comes back oldest first', async () => {
    gmail = () => ({ messages: [{ ...FULL, id: 'late', internalDate: '1748739600000' }, { ...FULL, id: 'early', internalDate: '1748736000000' }] });
    expect((await mailbox.getThread('u', 'google', 't1')).map((m) => m.id)).toEqual(['early', 'late']);
    expect(calls[0].path).toBe('/threads/t1?format=full');
    calls.length = 0;
    graph = () => ({ value: [{ id: 'b', receivedDateTime: '2025-06-02T00:00:00Z' }, { id: 'a', receivedDateTime: '2025-06-01T00:00:00Z' }] });
    expect((await mailbox.getThread('u', 'microsoft', "AAQ='x")).map((m) => m.id)).toEqual(['a', 'b']);
    expect(decodeURIComponent(calls[0].path)).toContain("$filter=conversationId eq 'AAQ=''x'");
  });
});

describe('getAttachment', () => {
  test('Gmail: found by its position, fetched by the id Gmail gives for this read', async () => {
    gmail = (_m, path) => (path.includes('/attachments/') ? { data: b64('PDFDATA') } : FULL);
    const file = await mailbox.getAttachment('u', 'google', 'g1', '1');
    expect(file).toMatchObject({ name: 'invoice.pdf', contentType: 'Application/PDF' });
    expect(Buffer.from(file.content).toString()).toBe('PDFDATA');
    expect(calls[1].path).toBe('/messages/g1/attachments/att-pdf');
    const small = await mailbox.getAttachment('u', 'google', 'g1', '2.0');
    expect(Buffer.from(small.content).toString()).toBe('small file');
  });

  test('Gmail: a body part, an unknown position or a crafted id is not an attachment; a huge one is refused before it is fetched', async () => {
    gmail = () => FULL;
    await expect(mailbox.getAttachment('u', 'google', 'g1', '0.0')).rejects.toMatchObject({ status: 404 });
    await expect(mailbox.getAttachment('u', 'google', 'g1', '9')).rejects.toMatchObject({ status: 404 });
    await expect(mailbox.getAttachment('u', 'google', 'g1', '../../labels')).rejects.toMatchObject({ status: 404 });
    gmail = () => ({ ...FULL, payload: { ...FULL.payload, parts: [{ partId: '1', mimeType: 'video/mp4', filename: 'big.mp4', body: { attachmentId: 'x', size: 26 * 1024 * 1024 } }] } });
    calls.length = 0;
    await expect(mailbox.getAttachment('u', 'google', 'g1', '1')).rejects.toMatchObject({ status: 413 });
    expect(calls.length).toBe(1);
  });

  test('Graph: a file attachment by $value; an attached item or an oversized file is refused', async () => {
    graph = () => ({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'A/1', name: 'a.pdf', size: 3, contentType: 'application/pdf' });
    const file = await mailbox.getAttachment('u', 'microsoft', 'm1', 'A/1');
    expect(file).toMatchObject({ name: 'a.pdf', contentType: 'application/pdf' });
    expect(calls.at(-1)).toEqual({ api: 'bytes', path: '/me/messages/m1/attachments/A%2F1/$value' });
    graph = () => ({ '@odata.type': '#microsoft.graph.itemAttachment', name: 'mail' });
    await expect(mailbox.getAttachment('u', 'microsoft', 'm1', 'A1')).rejects.toMatchObject({ status: 415 });
    graph = () => ({ '@odata.type': '#microsoft.graph.fileAttachment', size: 30 * 1024 * 1024 });
    await expect(mailbox.getAttachment('u', 'microsoft', 'm1', 'A1')).rejects.toMatchObject({ status: 413 });
  });
});

describe('batchAction', () => {
  test('Gmail label changes are one call; trash is the trash endpoint, never a delete', async () => {
    expect(await mailbox.batchAction('u', 'google', ['a', 'b', 'a'], 'archive')).toEqual({ done: ['a', 'b'], failed: [] });
    expect(calls).toEqual([{ api: 'gmail', method: 'POST', path: '/messages/batchModify', body: { ids: ['a', 'b'], removeLabelIds: ['INBOX'] } }]);
    calls.length = 0;
    await mailbox.batchAction('u', 'google', ['a'], 'unread');
    await mailbox.batchAction('u', 'google', ['a'], 'star');
    expect(calls.map((c) => c.body)).toEqual([{ ids: ['a'], addLabelIds: ['UNREAD'] }, { ids: ['a'], addLabelIds: ['STARRED'] }]);
    calls.length = 0;
    gmail = (_m, path) => { if (path.includes('/b/')) throw new Error('x'); return {}; };
    expect(await mailbox.batchAction('u', 'google', ['a', 'b'], 'trash')).toEqual({ done: ['a'], failed: ['b'] });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /messages/a/trash', 'POST /messages/b/trash']);
    calls.length = 0;
    await mailbox.batchAction('u', 'google', ['a/b'], 'untrash');
    expect(calls[0].path).toBe('/messages/a%2Fb/untrash');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('a failed Gmail label change reports every id as failed', async () => {
    gmail = () => { throw new Error('x'); };
    expect(await mailbox.batchAction('u', 'google', ['a', 'b'], 'read')).toEqual({ done: [], failed: ['a', 'b'] });
  });

  test('Graph: moves and patches per message', async () => {
    const run = async (action: Parameters<typeof mailbox.batchAction>[3]) => { calls.length = 0; await mailbox.batchAction('u', 'microsoft', ['m/1'], action); return calls[0]; };
    expect(await run('archive')).toEqual({ api: 'graph', method: 'POST', path: '/me/messages/m%2F1/move', body: { destinationId: 'archive' } });
    expect(await run('trash')).toMatchObject({ path: '/me/messages/m%2F1/move', body: { destinationId: 'deleteditems' } });
    expect(await run('untrash')).toMatchObject({ body: { destinationId: 'inbox' } });
    expect(await run('unarchive')).toMatchObject({ body: { destinationId: 'inbox' } });
    expect(await run('read')).toMatchObject({ method: 'PATCH', path: '/me/messages/m%2F1', body: { isRead: true } });
    expect(await run('unread')).toMatchObject({ body: { isRead: false } });
    expect(await run('star')).toMatchObject({ body: { flag: { flagStatus: 'flagged' } } });
    expect(await run('unstar')).toMatchObject({ body: { flag: { flagStatus: 'notFlagged' } } });
  });

  test('at most 100 at once', async () => {
    await expect(mailbox.batchAction('u', 'google', Array.from({ length: 101 }, (_, i) => `m${i}`), 'read')).rejects.toThrow('At most 100');
  });
});

describe('listAccounts', () => {
  test('connected mailboxes with their address; a failed lookup still lists the account', async () => {
    gmail = () => ({ emailAddress: 'me@gmail.com' });
    graph = () => { throw new Error('x'); };
    expect(await mailbox.listAccounts(nextUser())).toEqual({ accounts: [{ provider: 'google', address: 'me@gmail.com', isDefault: true }, { provider: 'microsoft', isDefault: true }] });
    connected = [];
    expect(await mailbox.listAccounts(nextUser())).toEqual({ accounts: [] });
  });
});
