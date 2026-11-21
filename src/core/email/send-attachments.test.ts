/** Mail with HTML and files: the MIME it becomes, the limits, and what a hostile name or type cannot do. */
import { describe, expect, test } from 'vitest';
import { composeParts, formattedHtml, formattedText } from './compose-format';
import { buildSendMime, buildSendRaw, checkAttachments, EmailInputError, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, safeContentType, safeFileName } from './send-mime';

const to = { to: ['bob@x.com'], cc: [], bcc: [] };
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
/** The header block and the decoded base64 parts of a MIME message. */
function parts(mime: string) {
  const [head] = mime.split('\r\n\r\n');
  const decoded = [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--)/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
  return { head, decoded };
}

describe('buildSendMime with HTML and attachments', () => {
  test('a plain mail keeps its old single-part shape', () => {
    const mime = buildSendMime({ ...to, subject: 'Hi', body: 'Hello' });
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nHello');
    expect(mime).not.toContain('multipart');
  });

  test('HTML makes text and HTML alternatives', () => {
    const mime = buildSendMime({ ...to, subject: 'Hi', body: 'Hello bold', html: '<p>Hello <strong>bold</strong></p>' });
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="=_octipus_[^"]+"/);
    expect(parts(mime).decoded).toEqual(['Hello bold', '<p>Hello <strong>bold</strong></p>']);
  });

  test('attachments make multipart/mixed: body first, then each file, base64 in short lines', () => {
    const big = new Uint8Array(5000).fill(65);
    const mime = buildSendMime({ ...to, subject: 'Report', body: 'See attached', html: '<p>See attached</p>', attachments: [
      { name: 'report.pdf', contentType: 'application/pdf', content: bytes('%PDF-1.7') },
      { name: 'data.bin', contentType: 'application/octet-stream', content: big },
    ] });
    const boundary = mime.match(/multipart\/mixed; boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeTruthy();
    expect(mime.split(`--${boundary}`).length).toBe(5); // header, body, two files, closing
    expect(mime).toContain('Content-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"');
    expect(mime.split('\r\n').every((line) => line.length <= 998)).toBe(true);
    const encoded = mime.split('Content-Disposition: attachment; filename="data.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
    expect(encoded.split('\r\n').every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').equals(Buffer.from(big))).toBe(true);
    expect(Buffer.from(buildSendRaw({ ...to, subject: 'x', body: 'y', attachments: [{ name: 'a.txt', contentType: 'text/plain', content: bytes('a') }] }), 'base64url').toString('utf8')).toContain('multipart/mixed');
  });

  test('a file name or type cannot start a header or break out of its quotes', () => {
    const mime = buildSendMime({ ...to, subject: 'x', body: 'y', attachments: [
      { name: 'evil"\r\nBcc: attacker@evil.com\r\n.pdf', contentType: 'text/plain\r\nBcc: attacker@evil.com', content: bytes('a') },
    ] });
    const headers = mime.split('\r\n').filter((line) => /^[A-Za-z-]+:/.test(line));
    expect(headers.some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(mime).toContain('Content-Type: application/octet-stream; name="evilBcc attacker@evil.com.pdf"');
  });

  test('a non-ASCII name gets the RFC 2231 form next to an ASCII fallback', () => {
    const mime = buildSendMime({ ...to, subject: 'x', body: 'y', attachments: [{ name: 'Übersicht März.pdf', contentType: 'application/pdf', content: bytes('a') }] });
    expect(mime).toContain(`filename="_bersicht M_rz.pdf"; filename*=UTF-8''%C3%9Cbersicht%20M%C3%A4rz.pdf`);
  });

  test('the limits: 20 files, 25 MB together', () => {
    const one = { content: new Uint8Array(1) };
    expect(() => checkAttachments(Array(MAX_ATTACHMENTS).fill(one))).not.toThrow();
    expect(() => checkAttachments(Array(MAX_ATTACHMENTS + 1).fill(one))).toThrow(EmailInputError);
    expect(() => checkAttachments([{ content: new Uint8Array(MAX_ATTACHMENT_BYTES) }])).not.toThrow();
    expect(() => checkAttachments([{ content: new Uint8Array(MAX_ATTACHMENT_BYTES) }, one])).toThrow(/25 MB/);
  });

  test('safeFileName and safeContentType', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\a<b>.txt')).toBe('ab.txt');
    expect(safeFileName('...hidden')).toBe('hidden');
    expect(safeFileName('\u0000\u0007')).toBe('attachment');
    const long = `${'x'.repeat(300)}.docx`;
    expect(safeFileName(long)).toHaveLength(120);
    expect(safeFileName(long).endsWith('.docx')).toBe(true);
    expect(safeContentType('Image/PNG; charset=x')).toBe('image/png');
    expect(safeContentType('text/html\r\nX: y')).toBe('application/octet-stream');
    expect(safeContentType(undefined)).toBe('application/octet-stream');
  });
});

describe('compose formatting', () => {
  test('signs become a small, safe HTML', () => {
    const html = formattedHtml('Hi **Ana**, see _this_ and *that*.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n> more\n\n[Docs](https://example.com/a?b=1&c=2)');
    expect(html).toContain('<strong>Ana</strong>');
    expect(html).toContain('<em>this</em>');
    expect(html).toContain('<em>that</em>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<blockquote>quoted<br>more</blockquote>');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">Docs</a>');
  });

  test('anything else is text: tags, handlers and script links do not survive', () => {
    const html = formattedHtml('<img src=x onerror=alert(1)> <script>x()</script> [click](javascript:alert(1)) **<b>**');
    expect(html).not.toMatch(/<img|<script|<b>|href="javascript/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('[click](javascript:alert(1))');
  });

  test('snake_case and lone asterisks are left alone', () => {
    expect(formattedHtml('a_b_c and 2 * 3 * 4')).not.toContain('<em>');
  });

  test('the plain part drops the signs and keeps the link', () => {
    expect(formattedText('Hi **Ana**, [Docs](https://x.com) _now_')).toBe('Hi Ana, Docs (https://x.com) now');
    expect(composeParts('**a**', 'plain')).toEqual({ text: '**a**' });
    expect(composeParts('**a**', 'rich').html).toContain('<strong>a</strong>');
  });
});
