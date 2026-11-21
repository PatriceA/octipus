import { describe, expect, test } from 'vitest';
import { batchBoundary, buildGmailBatch, parseGmailBatch } from './gmail-batch';

describe('buildGmailBatch', () => {
  test('one application/http part per request, numbered, closed by the final boundary', () => {
    const body = buildGmailBatch(['/gmail/v1/users/me/messages/a1?format=metadata', '/gmail/v1/users/me/messages/b2?format=metadata'], 'batch_12345678');
    expect(body).toBe(
      '--batch_12345678\r\nContent-Type: application/http\r\nContent-ID: <item-0>\r\n\r\nGET /gmail/v1/users/me/messages/a1?format=metadata HTTP/1.1\r\n\r\n'
      + '--batch_12345678\r\nContent-Type: application/http\r\nContent-ID: <item-1>\r\n\r\nGET /gmail/v1/users/me/messages/b2?format=metadata HTTP/1.1\r\n\r\n'
      + '--batch_12345678--\r\n',
    );
  });

  test('refuses a path outside the mailbox, a line break in a path, an empty or oversized batch', () => {
    expect(() => buildGmailBatch(['/admin/v1/users'], 'batch_12345678')).toThrow();
    expect(() => buildGmailBatch(['https://evil.example/gmail/v1/users/me/messages/a'], 'batch_12345678')).toThrow();
    expect(() => buildGmailBatch(['/gmail/v1/users/me/messages/a\r\nDELETE /gmail/v1/users/me/messages/b'], 'batch_12345678')).toThrow();
    expect(() => buildGmailBatch([], 'batch_12345678')).toThrow();
    expect(() => buildGmailBatch(Array.from({ length: 101 }, () => '/gmail/v1/users/me/messages/a'), 'batch_12345678')).toThrow();
    expect(() => buildGmailBatch(['/gmail/v1/users/me/messages/a'], 'bad boundary')).toThrow();
  });
});

const part = (index: number, status: string, json: string) =>
  `--batch_resp\r\nContent-Type: application/http\r\nContent-ID: <response-item-${index}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: ${json.length}\r\n\r\n${json}\r\n`;

describe('parseGmailBatch', () => {
  test('reads each answer by its request number, whatever order they come in', () => {
    const text = `${part(1, '200 OK', '{"id":"b2","snippet":"two"}')}${part(0, '200 OK', '{\n "id": "a1",\n "snippet": "one"\n}')}--batch_resp--\r\n`;
    const results = parseGmailBatch('multipart/mixed; boundary=batch_resp', text);
    expect(results.get(0)).toEqual({ status: 200, body: { id: 'a1', snippet: 'one' } });
    expect(results.get(1)).toEqual({ status: 200, body: { id: 'b2', snippet: 'two' } });
  });

  test('keeps a failed part as its status, and leaves out what it cannot read', () => {
    const text = `${part(0, '404 Not Found', '{"error":{"code":404}}')}${part(1, '200 OK', '{broken')}--batch_resp\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{}\r\n--batch_resp--`;
    const results = parseGmailBatch('multipart/mixed; boundary="batch_resp"', text);
    expect(results.get(0)?.status).toBe(404);
    expect(results.has(1)).toBe(false);
    expect(results.size).toBe(1);
  });

  test('bare line feeds and a missing boundary', () => {
    const lf = part(0, '200 OK', '{"id":"a1"}').replace(/\r\n/g, '\n');
    expect(parseGmailBatch('multipart/mixed; boundary=batch_resp', `${lf}--batch_resp--`).get(0)).toEqual({ status: 200, body: { id: 'a1' } });
    expect(parseGmailBatch('application/json', lf).size).toBe(0);
    expect(batchBoundary('multipart/mixed; boundary=abc; charset=utf-8')).toBe('abc');
  });
});
