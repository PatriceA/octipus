import { describe, expect, test } from 'vitest';
import { capNativeSnapshot, NATIVE_SNAPSHOT_MAX_CHARS, withSessionConversation } from './session-history';

const msg = (role: string, size: number) => ({ role, content: 'x'.repeat(size) });

describe('capNativeSnapshot', () => {
  test('leaves a snapshot under the ceiling untouched', () => {
    const messages = [msg('user', 10), msg('assistant', 10)];
    expect(capNativeSnapshot(messages)).toBe(messages);
  });

  test('drops the OLDEST messages down to half the ceiling at once', () => {
    const size = Math.floor(NATIVE_SNAPSHOT_MAX_CHARS / 10);
    const messages = Array.from({ length: 12 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', size));
    const kept = capNativeSnapshot(messages);
    // The newest turn always survives — it is the one the next request needs.
    expect(kept.at(-1)).toBe(messages.at(-1));
    // Half the ceiling, not just under it: the next turns fit without another
    // trim (each trim moves the start of the history, a lost prompt cache).
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(NATIVE_SNAPSHOT_MAX_CHARS / 2 + 100);
    const next = [...kept, msg('user', size), msg('assistant', size)];
    expect(capNativeSnapshot(next)).toBe(next);
  });

  test('a trimmed snapshot keeps no signed reasoning (it was bound to the dropped turns)', () => {
    const size = Math.floor(NATIVE_SNAPSHOT_MAX_CHARS / 3);
    const signed = { anthropicContent: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'a' }] };
    const messages: Array<{ role: string; content: string; providerRaw?: Record<string, unknown> }> = [msg('user', size), msg('user', size), { ...msg('assistant', size), providerRaw: signed }, { ...msg('assistant', 10), providerRaw: signed }];
    const kept = capNativeSnapshot(messages);
    expect(kept.at(-1)?.providerRaw).toEqual({ anthropicContent: [{ type: 'text', text: 'a' }] });
    // Untrimmed: reasoning stays as it was produced.
    const small = [{ ...msg('assistant', 10), providerRaw: signed }];
    expect(capNativeSnapshot(small)).toBe(small);
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
