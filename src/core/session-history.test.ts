import { describe, expect, test } from 'vitest';
import { capNativeSnapshot, NATIVE_SNAPSHOT_MAX_CHARS, withSessionConversation } from './session-history';

const msg = (role: string, size: number) => ({ role, content: 'x'.repeat(size) });

describe('capNativeSnapshot', () => {
  test('leaves a snapshot under the ceiling untouched', () => {
    const messages = [msg('user', 10), msg('assistant', 10)];
    expect(capNativeSnapshot(messages)).toBe(messages);
  });

  test('drops the OLDEST messages until it fits', () => {
    const big = Math.floor(NATIVE_SNAPSHOT_MAX_CHARS / 3);
    const messages = [msg('user', big), msg('assistant', big), msg('user', big), msg('assistant', big)];
    const kept = capNativeSnapshot(messages);
    expect(kept.length).toBeLessThan(messages.length);
    // The newest turn always survives — it is the one the next request needs.
    expect(kept.at(-1)).toBe(messages.at(-1));
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(NATIVE_SNAPSHOT_MAX_CHARS + 100);
  });

  test('never leaves a leading orphan tool result', () => {
    const big = Math.floor(NATIVE_SNAPSHOT_MAX_CHARS / 2);
    // Trimming lands exactly on a tool result whose assistant turn was dropped;
    // every provider 400s on that, so it has to go too.
    const kept = capNativeSnapshot([msg('assistant', big), msg('tool', 10), msg('user', big), msg('assistant', big)]);
    expect(kept[0].role).not.toBe('tool');
  });
});

describe('withSessionConversation', () => {
  test('serializes runs on one session and lets a different session through', async () => {
    const order: string[] = [];
    const slow = withSessionConversation('s1', async () => {
      order.push('a:start');
      await new Promise(r => setTimeout(r, 20));
      order.push('a:end');
    });
    const queued = withSessionConversation('s1', async () => { order.push('b'); });
    const other = withSessionConversation('s2', async () => { order.push('other'); });
    await Promise.all([slow, queued, other]);
    expect(order).toEqual(['a:start', 'other', 'a:end', 'b']);
  });

  test('a throwing run still releases the lock', async () => {
    await expect(withSessionConversation('s3', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withSessionConversation('s3', async () => 'after')).resolves.toBe('after');
  });
});
