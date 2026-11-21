/** Sending with HTML and files: which provider calls it becomes, and what happens when one fails. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

interface Call { api: string; method: string; path: string; body?: unknown }
const calls: Call[] = [];
let graphAnswer: (method: string, path: string, body?: unknown) => unknown = () => ({});
vi.mock('./providers', () => ({
  detectProvider: async () => 'google',
  gmailApi: async (_u: string, method: string, path: string, body?: unknown) => {
    calls.push({ api: 'gmail', method, path, body });
    if (method === 'GET') return { id: 'm1', threadId: 't1', payload: { headers: [{ name: 'Message-ID', value: '<orig@x.com>' }] } };
    return {};
  },
  graphApi: async (_u: string, method: string, path: string, body?: unknown) => { calls.push({ api: 'graph', method, path, body }); return graphAnswer(method, path, body); },
}));
vi.mock('@/security/oauth', () => ({ getOAuthManager: () => ({ getValidToken: async () => 'token' }) }));

const fetched: Array<{ url: string; init: RequestInit }> = [];
let fetchStatus = 200;
beforeEach(() => {
  calls.length = 0; fetched.length = 0; fetchStatus = 200;
  graphAnswer = (method, path) => {
    if (path.endsWith('/createReply')) return { id: 'draft-1', body: { contentType: 'html', content: '<p>original</p>' } };
    if (method === 'POST' && path === '/me/messages') return { id: 'draft-1' };
    if (path.endsWith('/createUploadSession')) return { uploadUrl: 'https://outlook.office.com/api/v2.0/upload/abc' };
    return {};
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { fetched.push({ url, init }); return new Response('{}', { status: fetchStatus }); }));
});
afterEach(() => vi.unstubAllGlobals());

const recipients = { to: ['bob@x.com'], cc: ['cfo@x.com'], bcc: [] };
const file = (size: number, name = 'a.pdf') => ({ name, contentType: 'application/pdf', content: new Uint8Array(size).fill(7) });

describe('Gmail', () => {
  test('a small mail goes as JSON, threaded under the original', async () => {
    const { sendFull } = await import('./send-full');
    await sendFull('u', 'google', { recipients, subject: 'Plan', text: 'ok', html: '<p>ok</p>', attachments: [file(10)], replyTo: 'm1' });
    const send = calls.find((c) => c.path === '/messages/send')!.body as { raw: string; threadId: string };
    expect(send.threadId).toBe('t1');
    const mime = Buffer.from(send.raw, 'base64url').toString('utf8');
    expect(mime).toContain('Subject: Re: Plan');
    expect(mime).toContain('In-Reply-To: <orig@x.com>');
    expect(mime).toContain('multipart/mixed');
    expect(fetched).toHaveLength(0);
  });

  test('a large mail goes through the upload endpoint as message/rfc822', async () => {
    const { sendFull } = await import('./send-full');
    await sendFull('u', 'google', { recipients, subject: 'Big', text: 'x', attachments: [file(5 * 1024 * 1024)] });
    expect(calls.some((c) => c.path === '/messages/send')).toBe(false);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart');
    expect((fetched[0].init.headers as Record<string, string>)['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(Buffer.from(fetched[0].init.body as Uint8Array).toString('utf8', 0, 400)).toContain('Content-Type: message/rfc822');
  });
});

describe('Microsoft 365', () => {
  test('a reply: reply draft, our HTML above the quote, files attached, sent', async () => {
    const { sendFull } = await import('./send-full');
    await sendFull('u', 'microsoft', { recipients, subject: 'Re: Plan', text: 'ok <b>', attachments: [file(10)], replyTo: 'm/1' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /me/messages/m%2F1/createReply',
      'PATCH /me/messages/draft-1',
      'POST /me/messages/draft-1/attachments',
      'POST /me/messages/draft-1/send',
    ]);
    const patch = calls[1].body as { body: { content: string }; ccRecipients: unknown[] };
    expect(patch.body.content).toBe('<div>ok &lt;b&gt;</div><br><p>original</p>');
    expect(patch.ccRecipients).toEqual([{ emailAddress: { address: 'cfo@x.com' } }]);
    expect(calls[2].body).toMatchObject({ '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentBytes: Buffer.from(new Uint8Array(10).fill(7)).toString('base64') });
  });

  test('a file over 3 MB goes through an upload session, in ranges, without the account token', async () => {
    const { sendFull, GRAPH_CHUNK_BYTES } = await import('./send-full');
    const size = GRAPH_CHUNK_BYTES + 1000;
    await sendFull('u', 'microsoft', { recipients, subject: 'Big', text: 'x', attachments: [file(size, 'big.pdf')] });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /me/messages', 'POST /me/messages/draft-1/attachments/createUploadSession', 'POST /me/messages/draft-1/send']);
    expect(fetched.map((f) => (f.init.headers as Record<string, string>)['Content-Range'])).toEqual([`bytes 0-${GRAPH_CHUNK_BYTES - 1}/${size}`, `bytes ${GRAPH_CHUNK_BYTES}-${size - 1}/${size}`]);
    expect(fetched.every((f) => !('Authorization' in (f.init.headers as Record<string, string>)))).toBe(true);
  });

  test('an upload URL outside Microsoft is refused, and the half-built draft is removed', async () => {
    const { sendFull } = await import('./send-full');
    graphAnswer = (method, path) => (path.endsWith('/createUploadSession') ? { uploadUrl: 'https://evil.example/collect' } : method === 'POST' && path === '/me/messages' ? { id: 'draft-1' } : {});
    await expect(sendFull('u', 'microsoft', { recipients, subject: 'Big', text: 'x', attachments: [file(4 * 1024 * 1024)] })).rejects.toThrow(/did not offer/);
    expect(fetched).toHaveLength(0);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/me/messages/draft-1' });
    expect(calls.some((c) => c.path.endsWith('/send'))).toBe(false);
  });

  test('isGraphUploadUrl and uploadRanges', async () => {
    const { isGraphUploadUrl, uploadRanges } = await import('./send-full');
    expect(isGraphUploadUrl('https://outlook.office.com/x')).toBe(true);
    expect(isGraphUploadUrl('http://outlook.office.com/x')).toBe(false);
    expect(isGraphUploadUrl('https://office.com.evil.example/x')).toBe(false);
    expect(isGraphUploadUrl(42)).toBe(false);
    expect(uploadRanges(10, 4)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 9 }]);
  });
});
