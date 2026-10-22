import { describe, expect, test } from 'vitest';
import type { MailMessage } from '@/db/schema/mail';
import { startFakePop3 } from './fixtures/fake-pop3';
import { MailInputError, parseRecipients, replyDraft, replySubject } from './drafts';
import { assertHostAllowed, MailHostError, resolveMailHost } from './hosts';
import { parseRawMessage } from './parse';
import { Pop3Client, Pop3Error } from './pop3';

const lookupTo = (...addresses: string[]) => (async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) as never;

describe('mail hosts', () => {
  test('a name resolving to any private address is local; a public one is not', async () => {
    expect(await resolveMailHost('mail.example.com', lookupTo('93.184.216.34'))).toEqual({ address: '93.184.216.34', servername: 'mail.example.com', local: false });
    expect((await resolveMailHost('mail.example.com', lookupTo('93.184.216.34', '10.0.0.5'))).local).toBe(true);
    expect((await resolveMailHost('localhost', lookupTo('93.184.216.34'))).local).toBe(true);
    expect(await resolveMailHost('127.0.0.1')).toEqual({ address: '127.0.0.1', servername: undefined, local: true });
  });

  test('ambiguous IP spellings and unresolvable names are refused', async () => {
    await expect(resolveMailHost('2130706433')).rejects.toBeInstanceOf(MailHostError);
    await expect(resolveMailHost('0x7f.0.0.1')).rejects.toBeInstanceOf(MailHostError);
    await expect(resolveMailHost('nowhere.invalid', (async () => { throw new Error('ENOTFOUND'); }) as never)).rejects.toThrow(/could not be resolved/);
  });

  test('local hosts need the allowance; plaintext only on the local network', () => {
    const local = { address: '10.0.0.5', servername: 'kim.lan', local: true };
    const pub = { address: '93.184.216.34', servername: 'mail.example.com', local: false };
    expect(() => assertHostAllowed(local, 'tls', false, 'kim.lan')).toThrow(/only an admin/);
    expect(() => assertHostAllowed(local, 'none', true, 'kim.lan')).not.toThrow();
    expect(() => assertHostAllowed(pub, 'none', true, 'mail.example.com')).toThrow(/unencrypted/i);
    expect(() => assertHostAllowed(pub, 'starttls', false, 'mail.example.com')).not.toThrow();
  });
});

describe('mail drafts', () => {
  test('recipients: lists, names, duplicates, and anything that is not an address refused', () => {
    expect(parseRecipients('a@x.de, Jane Doe <j@y.de>; A@x.de')).toEqual([{ address: 'a@x.de' }, { name: 'Jane Doe', address: 'j@y.de' }]);
    expect(parseRecipients(['b@x.de'])).toEqual([{ address: 'b@x.de' }]);
    expect(() => parseRecipients('not-an-address')).toThrow(MailInputError);
    expect(() => parseRecipients('a@x.de\r\nBcc: evil@x.de')).toThrow(MailInputError);
  });

  test('a reply goes to Reply-To, threads, quotes, and leaves the own address out of reply-all', () => {
    const original = {
      fromAddress: { name: 'Max', address: 'max@client.de' },
      replyTo: [{ address: 'office@client.de' }],
      toAddresses: [{ address: 'info@praxis.de' }, { address: 'kollege@praxis.de' }],
      ccAddresses: [{ address: 'office@client.de' }],
      subject: 'Termin',
      bodyText: 'Line one\nLine two',
      messageIdHeader: '<m1@client.de>',
      references: '<m0@client.de>',
      date: new Date('2026-10-01T08:00:00Z'),
    } as MailMessage;
    const draft = replyDraft({ address: 'INFO@praxis.de' }, original, 'Passt.', true);
    expect(draft.toAddresses).toEqual([{ address: 'office@client.de' }]);
    expect(draft.ccAddresses).toEqual([{ address: 'kollege@praxis.de' }]);
    expect(draft.subject).toBe('Re: Termin');
    expect(draft.inReplyTo).toBe('<m1@client.de>');
    expect(draft.references).toBe('<m0@client.de> <m1@client.de>');
    expect(draft.bodyText).toMatch(/^Passt\.\n\n.*Max <max@client\.de>:\n> Line one\n> Line two$/);
    expect(replySubject('AW: Termin')).toBe('AW: Termin');
  });
});

describe('mail parsing', () => {
  test('addresses, text, sanitized HTML and attachments; no script survives', async () => {
    const raw = Buffer.from([
      'From: "Max Muster" <max@client.de>',
      'To: info@praxis.de, Kollege <k@praxis.de>',
      'Reply-To: office@client.de',
      'Subject: =?UTF-8?Q?Rechnung_M=C3=A4rz?=',
      'Message-ID: <abc@client.de>',
      'Date: Wed, 01 Oct 2026 10:00:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hallo <b>Team</b></p><script>alert(1)</script><img src="https://track.example/x.png">',
      '--b1',
      'Content-Type: application/pdf; name="rechnung.pdf"',
      'Content-Disposition: attachment; filename="rechnung.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 test').toString('base64'),
      '--b1--',
      '',
    ].join('\r\n'));
    const parsed = await parseRawMessage(raw);
    expect(parsed.from).toEqual({ name: 'Max Muster', address: 'max@client.de' });
    expect(parsed.to.map((a) => a.address)).toEqual(['info@praxis.de', 'k@praxis.de']);
    expect(parsed.replyTo).toEqual([{ address: 'office@client.de' }]);
    expect(parsed.subject).toBe('Rechnung März');
    expect(parsed.messageIdHeader).toBe('<abc@client.de>');
    expect(parsed.text).toMatch(/Hallo\s+Team/);
    expect(parsed.html).toContain('Team');
    expect(parsed.html).not.toMatch(/script|alert/);
    expect(parsed.attachments).toEqual([{ filename: 'rechnung.pdf', contentType: 'application/pdf', size: 13 }]);
  });

  test('garbage still parses to something storable', async () => {
    const parsed = await parseRawMessage(Buffer.from('\u0000\u0001 not a message'));
    expect(typeof parsed.subject).toBe('string');
    expect(parsed.attachments).toEqual([]);
  });
});

describe('POP3 client', () => {
  test('lists by UIDL, reads headers with TOP and messages with RETR (dot-stuffing undone)', async () => {
    const server = await startFakePop3({
      user: 'kim', pass: 'secret',
      messages: [
        { uid: 'u-1', raw: 'Subject: one\r\n\r\nfirst' },
        { uid: 'u-2', raw: 'Subject: two\r\n\r\n.leading dot\r\n..two dots\r\nend' },
      ],
    });
    try {
      const client = await Pop3Client.connect({ address: '127.0.0.1', port: server.port, security: 'none', username: 'kim', password: 'secret' });
      expect(await client.uidl()).toEqual([{ num: 1, uid: 'u-1' }, { num: 2, uid: 'u-2' }]);
      expect([...(await client.list()).keys()]).toEqual([1, 2]);
      expect((await client.top(1, 0)).toString()).toBe('Subject: one\r\n');
      expect((await client.retr(2)).toString()).toBe('Subject: two\r\n\r\n.leading dot\r\n..two dots\r\nend\r\n');
      await client.quit();
      expect(server.retrieved).toEqual(['u-2']);
    } finally {
      await server.close();
    }
  });

  test('a refused login and an oversized message fail cleanly', async () => {
    const server = await startFakePop3({ user: 'kim', pass: 'secret', messages: [{ uid: 'big', raw: `Subject: big\r\n\r\n${'x'.repeat(5000)}` }] });
    try {
      await expect(Pop3Client.connect({ address: '127.0.0.1', port: server.port, security: 'none', username: 'kim', password: 'wrong' }))
        .rejects.toThrow(/refused the login/);
      const client = await Pop3Client.connect({ address: '127.0.0.1', port: server.port, security: 'none', username: 'kim', password: 'secret', maxResponseBytes: 1000 });
      await expect(client.retr(1)).rejects.toBeInstanceOf(Pop3Error);
      client.destroy();
    } finally {
      await server.close();
    }
  });
});
