/**
 * `downloadHttps` bounds the whole download by `timeoutMs`: redirect hops
 * and the body together. Each hop used to get a fresh timeout, so a chain of
 * slow redirects (or a slow body after them) ran several times longer than
 * the limit the docs state.
 */
import { afterEach, expect, test, vi } from 'vitest';

const plan = vi.hoisted(() => ({ hopDelayMs: 0, stallBody: false }));
vi.mock('@/utils/sanitize', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/sanitize')>(),
  fetchGuarded: async (url: string, init: RequestInit = {}) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, plan.hopDelayMs);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    const hop = Number(new URL(url).searchParams.get('hop') ?? '0');
    if (hop < 3) return new Response(null, { status: 302, headers: { location: `https://example.com/file?hop=${hop + 1}` } });
    if (!plan.stallBody) return new Response('done');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); } }));
  },
}));

const { downloadHttps } = await import('./remote');

afterEach(() => { plan.hopDelayMs = 0; plan.stallBody = false; });

test('three slow redirect hops share one deadline', async () => {
  plan.hopDelayMs = 150;
  // Each hop alone is well within 400 ms; the four together are not.
  await expect(downloadHttps('https://example.com/file', { maxBytes: 1000, timeoutMs: 400 })).rejects.toThrow(/took longer than 400 ms/);
  plan.hopDelayMs = 10;
  expect((await downloadHttps('https://example.com/file', { maxBytes: 1000, timeoutMs: 400 })).toString()).toBe('done');
});

test('a body that stalls is cut off at the deadline', async () => {
  plan.stallBody = true;
  await expect(downloadHttps('https://example.com/file', { maxBytes: 1000, timeoutMs: 300 })).rejects.toThrow(/took longer than 300 ms/);
});
