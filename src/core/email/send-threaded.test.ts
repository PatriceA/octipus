import { beforeEach, describe, expect, test, vi } from 'vitest';

const calls: Array<{ api: string; method: string; path: string; body?: unknown }> = [];
vi.mock('./providers', () => ({
  detectProvider: async () => 'google',
  gmailApi: async (_user: string, method: string, path: string, body?: unknown) => {
    calls.push({ api: 'gmail', method, path, body });
    if (method === 'GET') return { id: 'm1', threadId: 't1', payload: { headers: [{ name: 'Message-ID', value: '<orig@x.com>' }, { name: 'References', value: '<first@x.com>' }] } };
    return {};
  },
  graphApi: async (_user: string, method: string, path: string, body?: unknown) => { calls.push({ api: 'graph', method, path, body }); return {}; },
}));

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

describe('sendReply joins the conversation it answers', () => {
  beforeEach(() => { calls.length = 0; });

  test('Gmail: thread id plus In-Reply-To and References', async () => {
    const { sendReply } = await import('./service');
    await sendReply('u1', 'google', { to: 'bob@x.com', subject: 'Re: Plan', body: 'Fine by me.', replyTo: 'm1' });
    const send = calls.find((c) => c.path === '/messages/send')!.body as { raw: string; threadId?: string };
    expect(send.threadId).toBe('t1');
    const mime = decode(send.raw);
    expect(mime).toContain('In-Reply-To: <orig@x.com>');
    expect(mime).toContain('References: <first@x.com> <orig@x.com>');
    expect(mime).toContain('Subject: Re: Plan');
    expect(mime).toContain('Fine by me.');
  });

  test('Outlook: the reply endpoint of the message, not a new mail', async () => {
    const { sendReply } = await import('./service');
    await sendReply('u1', 'microsoft', { to: 'bob@x.com', subject: 'Re: Plan', body: 'Fine by me.', replyTo: 'm/1' });
    expect(calls).toEqual([{ api: 'graph', method: 'POST', path: '/me/messages/m%2F1/reply', body: { message: { toRecipients: [{ emailAddress: { address: 'bob@x.com' } }] }, comment: 'Fine by me.' } }]);
  });

  test('without a message to answer it is still a plain new mail', async () => {
    const { sendReply } = await import('./service');
    await sendReply('u1', 'google', { to: 'bob@x.com', subject: 'Hello', body: 'Hi.' });
    expect(calls.map((c) => c.path)).toEqual(['/messages/send']);
    expect((calls[0].body as { threadId?: string }).threadId).toBeUndefined();
  });
});
