import { describe, expect, test } from 'vitest';
import { type GmailMessage, type GraphMessage, gmailToMessage, m365ToMessage, normalizeGmail, normalizeM365, parseAddress } from './normalize';

describe('parseAddress', () => {
  test('parses "Name <email>"', () => {
    expect(parseAddress('Jane Doe <jane@x.com>')).toEqual({ name: 'Jane Doe', email: 'jane@x.com' });
  });
  test('parses quoted name', () => {
    expect(parseAddress('"Doe, Jane" <jane@x.com>')).toEqual({ name: 'Doe, Jane', email: 'jane@x.com' });
  });
  test('parses bare email', () => {
    expect(parseAddress('jane@x.com')).toEqual({ email: 'jane@x.com' });
  });
  test('handles empty', () => {
    expect(parseAddress(undefined)).toEqual({ email: '' });
  });
});

const GMAIL: GmailMessage = {
  id: 'g1',
  threadId: 't1',
  snippet: 'Hi there, quick question',
  labelIds: ['INBOX', 'UNREAD'],
  internalDate: '1748736000000', // 2025-06-01
  payload: {
    headers: [
      { name: 'From', value: 'Acme Support <support@acme.com>' },
      { name: 'To', value: 'me@x.com' },
      { name: 'Subject', value: 'Your ticket' },
      { name: 'Date', value: 'Sun, 01 Jun 2025 00:00:00 +0000' },
    ],
    body: { data: Buffer.from('Full body text here', 'utf8').toString('base64') },
  },
};

describe('normalizeGmail', () => {
  test('maps headers, snippet, unread, receivedAt', () => {
    const item = normalizeGmail(GMAIL);
    expect(item.provider).toBe('google');
    expect(item.from).toEqual({ name: 'Acme Support', email: 'support@acme.com' });
    expect(item.subject).toBe('Your ticket');
    expect(item.snippet).toBe('Hi there, quick question');
    expect(item.unread).toBe(true);
    expect(item.receivedAt).toBe(new Date(1748736000000).toISOString());
  });

  test('gmailToMessage decodes the body + recipients', () => {
    const msg = gmailToMessage(GMAIL);
    expect(msg.body).toBe('Full body text here');
    expect(msg.to?.[0].email).toBe('me@x.com');
  });

  test('read mail (no UNREAD label) is not unread', () => {
    expect(normalizeGmail({ ...GMAIL, labelIds: ['INBOX'] }).unread).toBe(false);
  });
});

const GRAPH: GraphMessage = {
  id: 'm1',
  conversationId: 'c1',
  subject: 'Outlook hello',
  bodyPreview: 'Preview snippet',
  receivedDateTime: '2025-06-01T08:00:00Z',
  isRead: false,
  from: { emailAddress: { name: 'Bob Smith', address: 'bob@corp.com' } },
  toRecipients: [{ emailAddress: { address: 'me@x.com' } }],
  body: { content: '<p>Hello <b>world</b></p>', contentType: 'html' },
};

describe('normalizeM365', () => {
  test('maps from/subject/snippet/unread', () => {
    const item = normalizeM365(GRAPH);
    expect(item.provider).toBe('microsoft');
    expect(item.from).toEqual({ name: 'Bob Smith', email: 'bob@corp.com' });
    expect(item.subject).toBe('Outlook hello');
    expect(item.unread).toBe(true);
    expect(item.receivedAt).toBe('2025-06-01T08:00:00.000Z');
  });

  test('m365ToMessage strips HTML to plain text', () => {
    const msg = m365ToMessage(GRAPH);
    expect(msg.body).toBe('Hello world');
    expect(msg.body).not.toContain('<');
  });

  test('m365ToMessage keeps a sanitized html body', () => {
    const msg = m365ToMessage(GRAPH);
    expect(msg.html).toBe('<p>Hello <b>world</b></p>');
  });

  test('m365ToMessage sanitizes scripts out of the html body', () => {
    const msg = m365ToMessage({
      ...GRAPH,
      body: { content: '<p>hi</p><script>steal()</script><a href="javascript:alert(1)">x</a>', contentType: 'html' },
    });
    expect(msg.html).toContain('<p>hi</p>');
    expect(msg.html).not.toContain('script');
    expect(msg.html).not.toContain('javascript:');
  });

  test('read mail is not unread', () => {
    expect(normalizeM365({ ...GRAPH, isRead: true }).unread).toBe(false);
  });
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('gmailToMessage — MIME structure', () => {
  test('a mail with an attachment keeps its body (it sits one level down)', () => {
    const msg = gmailToMessage({
      ...GMAIL,
      payload: {
        headers: GMAIL.payload!.headers,
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'multipart/alternative', parts: [
            { mimeType: 'text/plain', body: { data: b64('Plain body') } },
            { mimeType: 'text/html', body: { data: b64('<p>Html <b>body</b></p>') } },
          ] },
          { mimeType: 'application/pdf', filename: 'invoice.pdf', body: {} },
        ],
      },
    });
    expect(msg.body).toBe('Plain body');
    expect(msg.html).toContain('<b>body</b>');
  });

  test('an attached text file is not taken for the body', () => {
    const msg = gmailToMessage({
      ...GMAIL,
      payload: { headers: GMAIL.payload!.headers, mimeType: 'multipart/mixed', parts: [
        { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('attachment text') } },
        { mimeType: 'text/plain', body: { data: b64('The real body') } },
      ] },
    });
    expect(msg.body).toBe('The real body');
  });

  test('an HTML-only single-part mail is rendered as HTML, not shown as source', () => {
    const msg = gmailToMessage({ ...GMAIL, payload: { headers: GMAIL.payload!.headers, mimeType: 'text/html', body: { data: b64('<p>Only html</p>') } } });
    expect(msg.html).toContain('<p>Only html</p>');
    expect(msg.body).toBe('Only html');
  });

  test('remote images are not loaded until asked for', () => {
    const msg = gmailToMessage({ ...GMAIL, payload: { headers: GMAIL.payload!.headers, mimeType: 'text/html', body: { data: b64('<p>Hi</p><img src="https://track.example/p.gif" alt="x">') } } });
    expect(msg.html).toContain('<img data-remote-src="https://track.example/p.gif"');
    expect(msg.html).not.toMatch(/\ssrc=/);
  });
});
