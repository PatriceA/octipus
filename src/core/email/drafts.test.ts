import { beforeEach, describe, expect, test, vi } from 'vitest';

const gmailApi = vi.fn();
const graphApi = vi.fn();
vi.mock('./providers', () => ({
  gmailApi: (...args: unknown[]) => gmailApi(...args),
  graphApi: (...args: unknown[]) => graphApi(...args),
}));

const { buildGmailReplyRaw, replySubject, saveReplyDraft } = await import('./drafts');

const decode = (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

beforeEach(() => {
  gmailApi.mockReset();
  graphApi.mockReset();
});

test('replySubject adds one "Re:"', () => {
  expect(replySubject('Invoice')).toBe('Re: Invoice');
  expect(replySubject('RE: Invoice')).toBe('RE: Invoice');
  expect(replySubject('')).toBe('Re: (no subject)');
});

test('the Gmail reply threads under the original and cannot inject headers', () => {
  const mime = decode(buildGmailReplyRaw({
    to: 'ada@example.com\r\nBcc: evil@example.com',
    subject: 'Invoice',
    body: 'Thanks, paid.',
    inReplyTo: '<abc@mail>',
    references: '<root@mail>',
  }));
  expect(mime).toContain('In-Reply-To: <abc@mail>');
  expect(mime).toContain('References: <root@mail> <abc@mail>');
  expect(mime).not.toMatch(/^Bcc:/m);
  expect(mime.endsWith('Thanks, paid.')).toBe(true);
});

describe('saveReplyDraft', () => {
  test('gmail: reads the original, replies to Reply-To, creates a draft in its thread, sends nothing', async () => {
    gmailApi.mockImplementation(async (_user: string, method: string, path: string) => {
      if (method === 'GET') {
        return { id: 'm1', threadId: 't1', payload: { headers: [
          { name: 'From', value: 'Ada <ada@example.com>' },
          { name: 'Reply-To', value: 'billing@example.com' },
          { name: 'Subject', value: 'Invoice' },
          { name: 'Message-ID', value: '<abc@mail>' },
        ] } };
      }
      expect(path).toBe('/drafts');
      return { id: 'd1' };
    });
    const draft = await saveReplyDraft('u1', 'google', 'm1', 'Paid today.');
    expect(draft).toEqual({ draftId: 'd1', provider: 'google', to: 'billing@example.com', subject: 'Re: Invoice' });
    const [, , path, body] = gmailApi.mock.calls[1];
    expect(path).toBe('/drafts');
    expect(body.message.threadId).toBe('t1');
    expect(decode(body.message.raw)).toContain('In-Reply-To: <abc@mail>');
    expect(gmailApi.mock.calls.some(([, , p]) => String(p).includes('send'))).toBe(false);
  });

  test('outlook: createReply with the text as its comment', async () => {
    graphApi.mockResolvedValue({ id: 'd2', subject: 'RE: Invoice', toRecipients: [{ emailAddress: { address: 'ada@example.com' } }] });
    const draft = await saveReplyDraft('u1', 'microsoft', 'm1', 'Paid today.');
    expect(graphApi).toHaveBeenCalledWith('u1', 'POST', '/me/messages/m1/createReply', { comment: 'Paid today.' });
    expect(draft.to).toBe('ada@example.com');
  });

  test('an empty body is refused before any request', async () => {
    await expect(saveReplyDraft('u1', 'google', 'm1', '  ')).rejects.toThrow('needs a body');
    expect(gmailApi).not.toHaveBeenCalled();
  });
});
