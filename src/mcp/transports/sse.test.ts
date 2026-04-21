import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SSETransport } from './sse';

// ── Helpers ───────────────────────────────────────────────────

function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 1000,
  intervalMs = 2,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const value = fn();
      if (value !== undefined) return resolve(value);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('waitFor: timed out'));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** Build a Response whose body streams the given chunks as SSE text. */
function makeSSEResponse(chunks: string[], ok = true, status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
        // yield to the event loop between chunks
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: { 'content-type': 'text/event-stream' },
  });
}

// Capture and replace global fetch per-test.
const originalFetch = globalThis.fetch;
type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── connect + message parsing ─────────────────────────────────

describe('SSETransport.connect', () => {
  test('parses SSE "data: " lines and dispatches to handlers', async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return makeSSEResponse([
        'data: first\n',
        'data: second\n',
      ]);
    }) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));
    await t.connect();

    await waitFor(() => (messages.length >= 2 ? messages : undefined));
    expect(messages).toEqual(['first', 'second']);
    t.close();
  });

  test('skips non-data lines and empty data payloads', async () => {
    globalThis.fetch = (async () =>
      makeSSEResponse([
        ': heartbeat\n',
        'event: ping\n',
        'data: \n',
        'data: kept\n',
      ])) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));
    await t.connect();

    await waitFor(() => (messages.length >= 1 ? messages : undefined));
    expect(messages).toEqual(['kept']);
    t.close();
  });

  test('close handlers fire when SSE stream ends', async () => {
    globalThis.fetch = (async () =>
      makeSSEResponse(['data: one\n'])) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    let closed = false;
    t.onClose(() => {
      closed = true;
    });
    await t.connect();

    await waitFor(() => (closed ? true : undefined));
    expect(closed).toBe(true);
  });

  test('non-ok response triggers error handlers', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', {
        status: 500,
        statusText: 'Server Error',
      })) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));
    await t.connect();

    await waitFor(() => (errors.length >= 1 ? errors : undefined));
    expect(errors[0].message).toMatch(/SSE connection failed.*500/);
    t.close();
  });

  test('missing response body triggers error handlers', async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));
    await t.connect();

    await waitFor(() => (errors.length >= 1 ? errors : undefined));
    expect(errors[0].message).toMatch(/No response body/);
    t.close();
  });

  test('AbortError from close is silently swallowed (no error dispatched)', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      // Simulate the abort being honored: wait then throw AbortError
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));
    await t.connect();
    t.close();

    // Give the microtask a chance to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toEqual([]);
  });

  test('custom headers are forwarded to fetch', async () => {
    let observedHeaders: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observedHeaders = init?.headers;
      return makeSSEResponse([]);
    }) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
      headers: { Authorization: 'Bearer abc' },
    });
    await t.connect();
    await new Promise((r) => setTimeout(r, 10));

    expect(observedHeaders).toEqual({ Authorization: 'Bearer abc' });
    t.close();
  });
});

// ── send ─────────────────────────────────────────────────────

describe('SSETransport.send', () => {
  test('posts the message body to the postUrl with JSON content-type', async () => {
    let captured: FetchCall | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
      headers: { 'X-Trace-Id': 'abc' },
    });

    t.send('{"jsonrpc":"2.0"}');
    await new Promise((r) => setTimeout(r, 10));

    expect(captured).toBeDefined();
    expect(captured!.url).toBe('http://example.com/post');
    expect(captured!.init?.method).toBe('POST');
    expect(captured!.init?.body).toBe('{"jsonrpc":"2.0"}');
    const headers = captured!.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Trace-Id']).toBe('abc');
  });

  test('fetch rejection is routed to error handlers', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));

    t.send('{"foo":"bar"}');
    await waitFor(() => (errors.length >= 1 ? errors : undefined));
    expect(errors[0].message).toBe('network down');
  });
});

// ── close ────────────────────────────────────────────────────

describe('SSETransport.close', () => {
  test('close is safe when never connected', () => {
    const t = new SSETransport({
      sseUrl: 'http://example.com/sse',
      postUrl: 'http://example.com/post',
    });
    expect(() => t.close()).not.toThrow();
    // second close is still safe
    expect(() => t.close()).not.toThrow();
  });
});
