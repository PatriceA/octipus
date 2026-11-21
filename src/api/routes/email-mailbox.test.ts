/**
 * The mailbox routes over mocked provider calls: what the client is answered,
 * which provider calls a request turns into, and what is refused before any
 * provider is reached.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

interface Call { api: string; method: string; path: string; body?: unknown }
const calls: Call[] = [];
let connected: string[] = ['google'];
let gmail: (method: string, path: string, body?: unknown) => unknown = () => ({});
let graph: (method: string, path: string, body?: unknown) => unknown = () => ({});
const handled: Array<{ messageId: string; outcome: string }> = [];
let triage: Record<string, unknown> | Error = {};

vi.mock('@/core/email/providers', () => ({
  detectProvider: async () => connected[0] ?? null,
  connectedProviders: async () => connected,
  gmailApi: async (_u: string, method: string, path: string, body?: unknown) => { calls.push({ api: 'gmail', method, path, body }); return gmail(method, path, body); },
  graphApi: async (_u: string, method: string, path: string, body?: unknown) => { calls.push({ api: 'graph', method, path, body }); return graph(method, path, body); },
  gmailBatch: async () => { throw new Error('no batch in this test'); },
  graphBytes: async () => new Uint8Array([80, 68, 70]),
}));
vi.mock('@/core/email/triage-labels', async (original) => ({
  ...(await original<typeof import('@/core/email/triage-labels')>()),
  storedTriage: async () => { if (triage instanceof Error) throw triage; return triage; },
}));
vi.mock('@/core/email/watch', async (original) => ({
  ...(await original<typeof import('@/core/email/watch')>()),
  markEmailHandled: async (input: { messageId: string; outcome: string }) => { handled.push({ messageId: input.messageId, outcome: input.outcome }); },
}));

type App = { handle: (req: Request) => Promise<Response> };
let userSeq = 0;

async function buildApp(authenticated = true): Promise<App> {
  const { emailMailboxRoutes } = await import('./email-mailbox');
  const { emailRoutes } = await import('./email');
  const { principalFromUser, ANONYMOUS_PRINCIPAL } = await import('@/security/principal');
  // A fresh user per app: the list memory is per user.
  const u = { id: `00000000-0000-4000-8000-${String(++userSeq).padStart(12, '0')}`, username: 'alice', isAdmin: false };
  return new Elysia()
    .derive(() => (authenticated ? { user: u, session: null, principal: principalFromUser(u) } : { user: null, session: null, principal: ANONYMOUS_PRINCIPAL }))
    .group('/api', (a) => a.use(emailRoutes).use(emailMailboxRoutes)) as unknown as App;
}

async function call(app: App, method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return res;
}
const json = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, unknown> });

const meta = (id: string) => ({ id, threadId: `t-${id}`, snippet: 's', labelIds: ['INBOX'], internalDate: '1748736000000', payload: { headers: [{ name: 'From', value: 'ann@x.com' }, { name: 'Subject', value: `S ${id}` }] } });

beforeEach(() => {
  calls.length = 0; handled.length = 0; triage = {};
  connected = ['google'];
  gmail = () => ({});
  graph = () => ({});
});

describe('authentication', () => {
  test('every mailbox route answers 401 to an anonymous caller, before any provider call', async () => {
    const app = await buildApp(false);
    for (const [method, path, body] of [
      ['GET', '/api/email/accounts'], ['GET', '/api/email/messages'], ['GET', '/api/email/thread/t1'],
      ['GET', '/api/email/message/m1/attachment/1'], ['POST', '/api/email/messages/batch', { ids: ['a'], action: 'trash' }],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(app, method, path, body)).status).toBe(401);
    }
    expect(calls.length).toBe(0);
  });
});

describe('GET /api/email/messages', () => {
  test('no mailbox connected is an empty answer, not an error', async () => {
    connected = [];
    expect(await json(await call(await buildApp(), 'GET', '/api/email/messages'))).toEqual({ status: 200, body: { provider: null, items: [] } });
  });

  test('folder, search and limit reach the provider; stored triage comes with the rows', async () => {
    gmail = (_m, path) => (path.startsWith('/messages?') ? { messages: [{ id: 'a1' }] } : path.startsWith('/messages/a1') ? meta('a1') : {});
    triage = { a1: { priority: 'high', category: 'work', source: 'llm' } };
    const r = await json(await call(await buildApp(), 'GET', '/api/email/messages?folder=sent&q=invoice&unread=true&limit=500'));
    expect(r.status).toBe(200);
    expect(calls[0].path).toBe('/messages?maxResults=50&labelIds=SENT&labelIds=UNREAD&q=invoice');
    expect(r.body.items).toMatchObject([{ id: 'a1', subject: 'S a1', triage: { priority: 'high', category: 'work', source: 'llm' } }]);
  });

  test('a failing triage read never blocks the list', async () => {
    gmail = (_m, path) => (path.startsWith('/messages?') ? { messages: [{ id: 'a1' }] } : meta('a1'));
    triage = new Error('db down');
    const r = await json(await call(await buildApp(), 'GET', '/api/email/messages'));
    expect(r.status).toBe(200);
    expect((r.body.items as unknown[]).length).toBe(1);
  });

  test('an unknown folder, a provider that is not connected and a forged page token are refused', async () => {
    const app = await buildApp();
    expect((await json(await call(app, 'GET', '/api/email/messages?folder=spam'))).status).toBe(400);
    const other = await json(await call(app, 'GET', '/api/email/messages?provider=microsoft'));
    expect(other).toMatchObject({ status: 400, body: { error: expect.stringContaining('Microsoft 365 is not connected') } });
    expect((await call(app, 'GET', '/api/email/messages?provider=yahoo')).status).toBeGreaterThanOrEqual(400);
    expect(calls.length).toBe(0);
    connected = ['microsoft'];
    const forged = await json(await call(app, 'GET', `/api/email/messages?pageToken=${encodeURIComponent('https://evil.example/x')}`));
    expect(forged).toMatchObject({ status: 400, body: { error: 'Invalid page token.' } });
    expect(calls.length).toBe(0);
  });

  test('refresh=true asks the provider again within the remembered window', async () => {
    gmail = () => ({ messages: [] });
    const app = await buildApp();
    await call(app, 'GET', '/api/email/messages');
    await call(app, 'GET', '/api/email/messages');
    const lists = () => calls.filter((c) => c.path.startsWith('/messages?')).length;
    expect(lists()).toBe(1);
    await call(app, 'GET', '/api/email/messages?refresh=true');
    expect(lists()).toBe(2);
  });
});

describe('thread, accounts and attachments', () => {
  test('a thread is fetched by its id as one path segment', async () => {
    gmail = () => ({ messages: [{ ...meta('a1'), payload: { mimeType: 'text/plain', headers: meta('a1').payload.headers, body: { data: Buffer.from('Hi').toString('base64url') } } }] });
    const r = await json(await call(await buildApp(), 'GET', `/api/email/thread/${encodeURIComponent('t/1?x=1')}`));
    expect(calls[0].path).toBe('/threads/t%2F1%3Fx%3D1?format=full');
    expect(r.body.messages).toMatchObject([{ id: 'a1', body: 'Hi' }]);
  });

  test('accounts lists what is connected', async () => {
    connected = ['google', 'microsoft'];
    gmail = () => ({ emailAddress: 'me@gmail.com' });
    graph = () => ({ mail: null, userPrincipalName: 'me@corp.com' });
    expect((await json(await call(await buildApp(), 'GET', '/api/email/accounts'))).body).toEqual({ accounts: [{ provider: 'google', address: 'me@gmail.com', isDefault: true }, { provider: 'microsoft', address: 'me@corp.com', isDefault: true }] });
  });

  test('an attachment is always a download, with a neutral type for anything a browser would run', async () => {
    gmail = (_m, path) => (path.includes('/attachments/') ? { data: Buffer.from('<script>alert(1)</script>').toString('base64url') } : {
      id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [{ partId: '1', mimeType: 'text/html', filename: 'ev"il\r\n/../page.html', body: { attachmentId: 'att', size: 25 } }] },
    });
    const res = await call(await buildApp(), 'GET', '/api/email/message/m1/attachment/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('ev%22il_.._page.html');
    expect(await res.text()).toBe('<script>alert(1)</script>');
    expect((await call(await buildApp(), 'GET', '/api/email/message/m1/attachment/7')).status).toBe(404);
  });
});

describe('POST /api/email/messages/batch', () => {
  test('archive and trash are recorded for the inbox watch; other actions are not', async () => {
    const app = await buildApp();
    expect((await json(await call(app, 'POST', '/api/email/messages/batch', { ids: ['a', 'b'], action: 'archive' }))).body).toEqual({ done: ['a', 'b'], failed: [] });
    await call(app, 'POST', '/api/email/messages/batch', { ids: ['c'], action: 'trash' });
    await call(app, 'POST', '/api/email/messages/batch', { ids: ['d'], action: 'read' });
    expect(handled).toEqual([{ messageId: 'a', outcome: 'archived' }, { messageId: 'b', outcome: 'archived' }, { messageId: 'c', outcome: 'other' }]);
  });

  test('an unknown action, no ids or more than 100 are refused before any provider call', async () => {
    const app = await buildApp();
    expect((await call(app, 'POST', '/api/email/messages/batch', { ids: ['a'], action: 'delete' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(app, 'POST', '/api/email/messages/batch', { ids: [], action: 'read' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(app, 'POST', '/api/email/messages/batch', { ids: Array.from({ length: 101 }, (_, i) => `m${i}`), action: 'read' })).status).toBeGreaterThanOrEqual(400);
    expect(calls.length).toBe(0);
  });
});

describe('POST /api/email/send', () => {
  const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

  test('still gated: nothing is sent without confirm: true', async () => {
    const r = await json(await call(await buildApp(), 'POST', '/api/email/send', { to: 'bob@x.com', cc: 'c@x.com', subject: 'Hi', body: 'hello' }));
    expect(r).toMatchObject({ status: 409, body: { requiresConfirmation: true } });
    expect(calls.length).toBe(0);
  });

  test('a new mail to several recipients with cc and bcc', async () => {
    const r = await json(await call(await buildApp(), 'POST', '/api/email/send', { to: 'bob@x.com, Ann <ann@x.com>', cc: 'c@x.com', bcc: 'd@x.com', subject: 'Hi', body: 'hello', confirm: true }));
    expect(r).toEqual({ status: 200, body: { sent: true } });
    const mime = decode((calls[0].body as { raw: string }).raw);
    expect(mime).toContain('To: bob@x.com, ann@x.com\r\nCc: c@x.com\r\nBcc: d@x.com\r\nSubject: Hi\r\n');
    expect(handled).toEqual([]);
  });

  test('a reply is threaded and recorded as replied', async () => {
    gmail = (method) => (method === 'GET' ? { id: 'm1', threadId: 't1', payload: { headers: [{ name: 'Message-ID', value: '<orig@x.com>' }] } } : {});
    await call(await buildApp(), 'POST', '/api/email/send', { to: 'bob@x.com', cc: 'c@x.com', subject: 'Plan', body: 'ok', confirm: true, replyTo: 'm1' });
    const send = calls.find((c) => c.path === '/messages/send')?.body as { raw: string; threadId: string };
    expect(send.threadId).toBe('t1');
    expect(decode(send.raw)).toContain('Cc: c@x.com\r\nSubject: Re: Plan\r\nIn-Reply-To: <orig@x.com>');
    expect(handled).toEqual([{ messageId: 'm1', outcome: 'replied' }]);
  });

  test('Outlook: sendMail with all three lists; the chosen provider sends', async () => {
    connected = ['google', 'microsoft'];
    await call(await buildApp(), 'POST', '/api/email/send', { to: 'bob@x.com', cc: 'c@x.com', bcc: 'd@x.com', subject: 'Hi', body: 'hello', confirm: true, provider: 'microsoft' });
    expect(calls).toEqual([{ api: 'graph', method: 'POST', path: '/me/sendMail', body: { message: {
      subject: 'Hi', body: { contentType: 'Text', content: 'hello' },
      toRecipients: [{ emailAddress: { address: 'bob@x.com' } }], ccRecipients: [{ emailAddress: { address: 'c@x.com' } }], bccRecipients: [{ emailAddress: { address: 'd@x.com' } }],
    } } }]);
  });

  test.each([
    { to: 'victim@x.com\r\nBcc: attacker@evil.com' },
    { to: 'bob@x.com', cc: 'not an address' },
    { to: 'bob@x.com', bcc: 'a@x.com\nX-Spoof: 1' },
    { to: Array.from({ length: 51 }, (_, i) => `u${i}@x.com`).join(',') },
    { to: ' , ' },
  ])('refuses bad recipients before anything is sent: %j', async (fields) => {
    const r = await json(await call(await buildApp(), 'POST', '/api/email/send', { subject: 'Hi', body: 'hello', confirm: true, ...fields }));
    expect(r.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test('a provider that is not connected is refused', async () => {
    const r = await json(await call(await buildApp(), 'POST', '/api/email/send', { to: 'bob@x.com', subject: 'Hi', body: 'hello', confirm: true, provider: 'microsoft' }));
    expect(r).toMatchObject({ status: 400, body: { error: expect.stringContaining('not connected') } });
    expect(calls.length).toBe(0);
  });
});
