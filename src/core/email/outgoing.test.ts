/** Files held for a mail: per user, limited, for an hour, and resolved in order with forwarded files. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearUploads, dropUploads, heldUploads, holdUpload, resolveAttachments, sweepUploads, UPLOAD_TTL_MS, uploadHolders, USER_MAX_BYTES, USER_MAX_FILES } from './outgoing';
import { EmailInputError, MAX_ATTACHMENT_BYTES } from './send-mime';

const file = (size = 3, name = 'a.txt') => ({ name, contentType: 'text/plain', content: new Uint8Array(size) });

beforeEach(() => clearUploads());

describe('held uploads', () => {
  test('one user cannot use another user\'s file', () => {
    const { id } = holdUpload('u1', file());
    expect(heldUploads('u1', [id])).toHaveLength(1);
    expect(() => heldUploads('u2', [id])).toThrow(EmailInputError);
  });

  test('the name is cleaned and the type checked', () => {
    const view = holdUpload('u1', { name: '../x/"evil".exe', contentType: 'bad type', content: new Uint8Array(1) });
    expect(view).toMatchObject({ name: 'evil.exe', contentType: 'application/octet-stream', size: 1 });
  });

  test('empty, too large, too many, too much', () => {
    expect(() => holdUpload('u1', file(0))).toThrow(/empty/);
    expect(() => holdUpload('u1', file(MAX_ATTACHMENT_BYTES + 1))).toThrow(/25 MB/);
    for (let i = 0; i < USER_MAX_FILES; i++) holdUpload('u2', file(1));
    expect(() => holdUpload('u2', file(1))).toThrow(/Too many/);
    holdUpload('u3', file(MAX_ATTACHMENT_BYTES));
    holdUpload('u3', file(USER_MAX_BYTES - MAX_ATTACHMENT_BYTES));
    expect(() => holdUpload('u3', file(1))).toThrow(/Too much/);
  });

  test('an upload expires after an hour; a dropped one is gone', () => {
    const t0 = Date.now();
    const { id } = holdUpload('u1', file(), t0 - UPLOAD_TTL_MS - 1);
    expect(() => heldUploads('u1', [id])).toThrow(/no longer waiting/);
    const kept = holdUpload('u1', file());
    dropUploads('u1', [kept.id]);
    expect(() => heldUploads('u1', [kept.id])).toThrow(EmailInputError);
  });

  test('the sweep drops files nobody came back for, and the users left with none', () => {
    const t0 = Date.now();
    holdUpload('gone', file(MAX_ATTACHMENT_BYTES), t0);
    const kept = holdUpload('back', file(), t0 + UPLOAD_TTL_MS);
    sweepUploads(t0 + UPLOAD_TTL_MS + 1);
    expect(uploadHolders()).toBe(1);
    expect(heldUploads('back', [kept.id])).toHaveLength(1);
    sweepUploads(t0 + 2 * UPLOAD_TTL_MS + 1);
    expect(uploadHolders()).toBe(0);
  });

  test('reading as a user who holds nothing keeps no entry for them', () => {
    expect(() => heldUploads('reader', ['x'])).toThrow(EmailInputError);
    expect(heldUploads('reader', [])).toEqual([]);
    expect(uploadHolders()).toBe(0);
  });

  test('uploads and forwarded files come back in the order the send names them', async () => {
    const a = holdUpload('u1', file(1, 'a.txt'));
    const b = holdUpload('u1', file(2, 'b.txt'));
    const fetched: string[] = [];
    const { files, uploads } = await resolveAttachments('u1', [{ upload: b.id }, { forward: { messageId: 'm1', attachmentId: '2' } }, { upload: a.id }], async (messageId, attachmentId) => {
      fetched.push(`${messageId}/${attachmentId}`);
      return { name: 'C:\\fwd\\orig.pdf', contentType: 'application/pdf', content: new Uint8Array(4) };
    });
    expect(files.map((f) => f.name)).toEqual(['b.txt', 'orig.pdf', 'a.txt']);
    expect(uploads).toEqual([b.id, a.id]);
    expect(fetched).toEqual(['m1/2']);
  });
});

describe('the periodic sweep', () => {
  afterEach(() => { clearUploads(); vi.useRealTimers(); });

  test('runs on its own after an upload, on a timer that does not hold the process open', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    holdUpload('gone', file());
    const timer = spy.mock.results[0]?.value;
    spy.mockRestore();
    expect(timer?.hasRef()).toBe(false);
    vi.advanceTimersByTime(UPLOAD_TTL_MS + 10 * 60_000);
    expect(uploadHolders()).toBe(0);
  });
});
