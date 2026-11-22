/**
 * Writing with files and formatting, and snoozing, over mocked provider calls:
 * what a request turns into, and what is refused before the mailbox is reached.
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
vi.mock('@/core/email/providers', () => ({
  detectProvider: async () => 'google',
  connectedProviders: async () => ['google'],
  gmailApi: async (_u: string, method: string, path: string, body?: unknown) => {
    calls.push({ api: 'gmail', method, path, body });
    if (path.startsWith('/messages/fwd-1?format=full')) {
      return { id: 'fwd-1', payload: { mimeType: 'multipart/mixed', parts: [{ partId: '0', mimeType: 'text/plain', body: { data: 'aGk' } }, { partId: '1', mimeType: 'application/pdf', filename: 'orig.pdf', body: { data: Buffer.from('%PDF').toString('base64url'), size: 4 } }] } };
    }
    return {};
  },
  graphApi: async () => ({}),
  gmailBatch: async () => { throw new Error('no batch in this test'); },
  graphBytes: async () => new Uint8Array(),
}));
const handled: string[] = [];
vi.mock('@/core/email/watch', async (original) => ({
  ...(await original<typeof import('@/core/email/watch')>()),
  markEmailHandled: async ({ messageId }: { messageId: string }) => { handled.push(messageId); },
}));
const snoozed: unknown[] = [];
vi.mock('@/core/email/snooze', async (original) => {
  const real = await original<typeof import('@/core/email/snooze')>();
  return {
    ...real,
    snooze: async (userId: string, provider: string, request: { wakeAt: string; ids: string[] }) => {
      real.checkWakeAt(request.wakeAt);
      snoozed.push({ userId, provider, ...request });
      const view: import('@/core/email/snooze').SnoozeView = { id: 's1', provider: 'google', messageIds: [], from: { email: 'boss@x.com' }, subject: 'Budget', snippet: '', wakeAt: request.wakeAt };
      // Ids starting "stuck" could not be moved: they stay in the inbox.
      const stuck = request.ids.filter((id) => id.startsWith('stuck'));
      if (stuck.length) throw new real.SnoozePartialError('Some stayed.', view, request.ids.filter((id) => !stuck.includes(id)));
      return view;
    },
    listSnoozed: async () => [{ id: 's1', subject: 'Budget' }],
  };
});

type App = { handle: (req: Request) => Promise<Response> };
let userSeq = 0;
async function buildApp(authenticated = true): Promise<App> {
  const { emailComposeRoutes } = await import('./email-compose');
  const { emailRoutes } = await import('./email');
  const { principalFromUser, ANONYMOUS_PRINCIPAL } = await import('@/security/principal');
  const u = { id: `00000000-0000-4000-8000-${String(++userSeq).padStart(12, '0')}`, username: 'alice', isAdmin: false };
  return new Elysia()
    .derive(() => (authenticated ? { user: u, session: null, principal: principalFromUser(u) } : { user: null, session: null, principal: ANONYMOUS_PRINCIPAL }))
    .group('/api', (a) => a.use(emailRoutes).use(emailComposeRoutes)) as unknown as App;
}
const json = (app: App, method: string, path: string, body: unknown) =>
  app.handle(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
async function upload(app: App, name: string, content: string, type = 'text/plain') {
  const form = new FormData();
  form.append('file', new File([content], name, { type }));
  return app.handle(new Request('http://localhost/api/email/uploads', { method: 'POST', body: form }));
}
const sentMime = () => {
  const send = calls.find((c) => c.path === '/messages/send');
  return send ? Buffer.from((send.body as { raw: string }).raw, 'base64url').toString('utf8') : '';
};

beforeEach(() => { calls.length = 0; snoozed.length = 0; handled.length = 0; });

describe('uploads and the send that names them', () => {
  test('a held upload and a forwarded file go out with a formatted body', async () => {
    const app = await buildApp();
    const up = await upload(app, '../notes.txt', 'my notes');
    expect(up.status).toBe(200);
    const held = (await up.json()) as { id: string; name: string; size: number };
    expect(held).toMatchObject({ name: 'notes.txt', size: 8 });
    const res = await json(app, 'POST', '/api/email/send', {
      to: 'bob@x.com', subject: 'Fwd: Plan', body: 'See **this**', format: 'rich', confirm: true,
      attachments: [{ upload: held.id }, { forward: { messageId: 'fwd-1', attachmentId: '1' } }],
    });
    expect(res.status).toBe(200);
    const mime = sentMime();
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('filename="notes.txt"');
    expect(mime).toContain('filename="orig.pdf"');
    expect(mime).toContain(Buffer.from('<div><p>See <strong>this</strong></p></div>').toString('base64'));
    // Sent: the upload is let go of; naming it again fails.
    calls.length = 0;
    const again = await json(app, 'POST', '/api/email/send', { to: 'bob@x.com', subject: 'x', body: 'y', confirm: true, attachments: [{ upload: held.id }] });
    expect(again.status).toBe(400);
    expect(calls.some((c) => c.path === '/messages/send')).toBe(false);
  });

  test('without confirm nothing is fetched or sent, attachments or not', async () => {
    const app = await buildApp();
    const res = await json(app, 'POST', '/api/email/send', { to: 'bob@x.com', subject: 'x', body: 'y', attachments: [{ forward: { messageId: 'fwd-1', attachmentId: '1' } }] });
    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  test('another user\'s upload cannot be named', async () => {
    const owner = await buildApp();
    const { id } = (await (await upload(owner, 'a.txt', 'x')).json()) as { id: string };
    const other = await buildApp();
    const res = await json(other, 'POST', '/api/email/send', { to: 'bob@x.com', subject: 'x', body: 'y', confirm: true, attachments: [{ upload: id }] });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('an empty file is refused; a removed upload is gone; not signed in is 401', async () => {
    const app = await buildApp();
    expect((await upload(app, 'empty.txt', '')).status).toBe(400);
    const { id } = (await (await upload(app, 'a.txt', 'x')).json()) as { id: string };
    expect((await app.handle(new Request(`http://localhost/api/email/uploads/${id}`, { method: 'DELETE' }))).status).toBe(200);
    expect((await json(app, 'POST', '/api/email/send', { to: 'bob@x.com', subject: 'x', body: 'y', confirm: true, attachments: [{ upload: id }] })).status).toBe(400);
    expect((await upload(await buildApp(false), 'a.txt', 'x')).status).toBe(401);
  });
});

describe('nothing too large is read into memory', () => {
  test('an upload over the limit is refused by its declared length, or as soon as the read passes it', async () => {
    const app = await buildApp();
    const big = new Request('http://localhost/api/email/uploads', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(30 * 1048576) }, body: 'x' });
    expect((await app.handle(big)).status).toBe(413);
    // No declared length: refused once the read passes the limit.
    let served = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { served += 1048576; controller.enqueue(new Uint8Array(1048576)); if (served > 40 * 1048576) controller.close(); } });
    const streamed = new Request('http://localhost/api/email/uploads', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: endless, duplex: 'half' } as RequestInit);
    expect((await app.handle(streamed)).status).toBe(413);
    // An ordinary file still goes through.
    expect((await upload(app, 'ok.txt', 'hello')).status).toBe(200);
  });

  test('forwarded files over the limit are refused from their listed sizes, before any is downloaded', async () => {
    const { resolveAttachments } = await import('@/core/email/outgoing');
    const fetched: string[] = [];
    const refs = Array.from({ length: 3 }, (_, i) => ({ forward: { messageId: 'm1', attachmentId: String(i) } }));
    await expect(resolveAttachments('u-big', refs, async (_m, id) => { fetched.push(id); return { name: 'f', contentType: 'application/pdf', content: new Uint8Array(1) }; },
      async () => new Map([['0', 10 * 1048576], ['1', 10 * 1048576], ['2', 10 * 1048576]]))).rejects.toThrow(/add up to 25 MB/);
    expect(fetched).toEqual([]);
    // A size the listing got wrong: the fetching stops at the limit.
    await expect(resolveAttachments('u-big', refs, async (_m, id) => { fetched.push(id); return { name: 'f', contentType: 'application/pdf', content: new Uint8Array(13 * 1048576) }; },
      async () => new Map())).rejects.toThrow(/add up to 25 MB/);
    expect(fetched).toEqual(['0', '1']);
  });
});

describe('snooze routes', () => {
  test('snooze passes the conversation on; a bad time is a 400', async () => {
    const app = await buildApp();
    const wakeAt = new Date(Date.now() + 3600_000).toISOString();
    const body = { ids: ['m1'], wakeAt, from: { email: 'boss@x.com' }, subject: 'Budget', snippet: 'Please' };
    expect((await json(app, 'POST', '/api/email/snooze', body)).status).toBe(200);
    expect(snoozed).toMatchObject([{ provider: 'google', ids: ['m1'], wakeAt }]);
    expect((await json(app, 'POST', '/api/email/snooze', { ...body, wakeAt: 'soon' })).status).toBe(400);
    const list = await app.handle(new Request('http://localhost/api/email/snoozed'));
    expect(await list.json()).toEqual({ snoozed: [{ id: 's1', subject: 'Budget' }] });
  });

  test('a partial snooze marks only the snoozed messages handled; the ones left in the inbox stay watched', async () => {
    const app = await buildApp();
    const wakeAt = new Date(Date.now() + 3600_000).toISOString();
    const body = { ids: ['m1', 'stuck1', 'm2', 'stuck2', 'm3'], wakeAt, from: { email: 'boss@x.com' }, subject: 'Budget', snippet: 'Please' };
    const res = await json(app, 'POST', '/api/email/snooze', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ snoozed: { id: 's1' }, warning: 'Some stayed.' });
    await vi.waitFor(() => expect(handled).toHaveLength(3));
    expect(handled).toEqual(['m1', 'm2', 'm3']);
  });
});
