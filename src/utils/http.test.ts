import { afterEach, describe, expect, test } from 'vitest';
import { fetchWithTimeout } from '@/utils/http';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('fetchWithTimeout', () => {
  test('passes an already-aborting signal when timeoutMs is ~0', async () => {
    // Deterministic: stub fetch to reflect the signal it was handed. With a
    // 0ms timeout the AbortSignal.timeout fires on the next tick, so the
    // signal the wrapper passes is (or becomes) aborted.
    let received: AbortSignal | undefined;
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      received = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        received?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }) as typeof fetch;

    await expect(fetchWithTimeout('https://example.com/', { timeoutMs: 0 })).rejects.toThrow();
    expect(received).toBeInstanceOf(AbortSignal);
  });

  test('forwards method/headers/body and returns the response', async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      seen = init;
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof fetch;

    const res = await fetchWithTimeout('https://example.com/', {
      method: 'POST',
      headers: { 'X-Test': '1' },
      body: 'hello',
      timeoutMs: 5000,
    });

    expect(res.status).toBe(200);
    expect(seen?.method).toBe('POST');
    expect((seen?.headers as Record<string, string>)['X-Test']).toBe('1');
    expect(seen?.body).toBe('hello');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  test('combines a caller signal with the timeout signal', async () => {
    let received: AbortSignal | undefined;
    globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
      received = init?.signal ?? undefined;
      return Promise.resolve(new Response('ok'));
    }) as typeof fetch;

    const ctrl = new AbortController();
    await fetchWithTimeout('https://example.com/', { signal: ctrl.signal, timeoutMs: 5000 });
    expect(received).toBeInstanceOf(AbortSignal);
    // Aborting the caller's controller aborts the combined signal.
    ctrl.abort();
    expect(received?.aborted).toBe(true);
  });
});
