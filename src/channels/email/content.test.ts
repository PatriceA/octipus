import { describe, expect, test } from 'vitest';
import { mailContent, replyReferences, replySubject, splitMail, stripQuoted } from './content';
import { rawMail } from './fixtures';

describe('the new text of a mail', () => {
  test('quoted history after a reply header is cut', () => {
    expect(stripQuoted('Yes, go ahead.\n\nOn Mon, 23 Nov 2026 at 10:00, Octipus <o@c.test> wrote:\n> Shall I?\n')).toBe('Yes, go ahead.');
    expect(stripQuoted('Thanks!\n\nOn Mon, 23 Nov 2026 at 10:00, Octipus\n<o@c.test> wrote:\n> Shall I?')).toBe('Thanks!');
    expect(stripQuoted('Do it.\n\n-----Original Message-----\nFrom: x')).toBe('Do it.');
    expect(stripQuoted('Do it.\n\nFrom: Octipus\nSent: Monday\nTo: Ann\nSubject: Re: x\n\nold')).toBe('Do it.');
  });

  test('a trailing quote, the signature and a phone footer go; interleaved quotes stay', () => {
    expect(stripQuoted('Answer\n\n> old line\n> older')).toBe('Answer');
    expect(stripQuoted('Answer\n-- \nAnn Example\nCEO')).toBe('Answer');
    expect(stripQuoted('Answer\n\nSent from my iPhone')).toBe('Answer');
    expect(stripQuoted('> point one\nmy answer\n> point two\nother answer')).toBe('> point one\nmy answer\n> point two\nother answer');
  });

  test('a forward keeps the forwarded mail; an Outlook forward only when the subject says so', () => {
    const gmail = 'Please summarise the mail below.\n\n---------- Forwarded message ---------\nFrom: Bank <x@bank.test>\nSubject: Invoice\n\nYou owe 5000 EUR.';
    expect(splitMail(gmail)).toEqual({ own: 'Please summarise the mail below.', forwarded: gmail.slice(gmail.indexOf('----------')) });
    const outlook = 'Can you check this?\n\n________________________________\nFrom: Bank <x@bank.test>\nSent: Monday\nSubject: Invoice\n\nYou owe 5000 EUR.';
    expect(splitMail(outlook, { forward: true }).forwarded).toContain('You owe 5000 EUR.');
    expect(splitMail(outlook)).toEqual({ own: 'Can you check this?', forwarded: '' });
  });

  test('nothing left after cutting keeps the text whole', () => {
    expect(stripQuoted('> only a quote')).toBe('> only a quote');
  });

  test('HTML-only mail becomes text: no markup, no script', async () => {
    const { text } = await mailContent(rawMail({ html: '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Hello <b>there</b> &amp; welcome</p><div>Second line</div></body></html>' }));
    expect(text).toContain('Hello there & welcome');
    expect(text).toContain('Second line');
    expect(text).not.toMatch(/<|alert|color:red/);
  });

  test('subject and references of the reply', () => {
    expect(replySubject('Q3 report')).toBe('Re: Q3 report');
    expect(replySubject('RE: Q3 report')).toBe('RE: Q3 report');
    expect(replySubject('')).toBe('Re: your message');
    expect(replyReferences('<a@x> <b@x>', '<c@x>')).toBe('<a@x> <b@x> <c@x>');
    expect(replyReferences(null, '<c@x>')).toBe('<c@x>');
  });
});
