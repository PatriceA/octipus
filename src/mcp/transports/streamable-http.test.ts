import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { StreamableHTTPTransport } from './streamable-http';

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

function makeSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeJSONResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // no-op — each test sets its own fetch
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── connect ──────────────────────────────────────────────────

describe('StreamableHTTPTransport.connect', () => {
  test('is a no-op (resolves immediately, makes no requests)', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return makeJSONResponse('{}');
    }) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    await t.connect();
    expect(called).toBe(0);
  });
});

// ── send → direct JSON response ──────────────────────────────

describe('StreamableHTTPTransport.send (JSON response)', () => {
  test('dispatches the response text to message handlers', async () => {
    globalThis.fetch = (async () =>
      makeJSONResponse('{"jsonrpc":"2.0","result":{"ok":true}}')) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));

    t.send('{"method":"initialize"}');
    await waitFor(() => (messages.length >= 1 ? messages : undefined));
    expect(messages[0]).toContain('"ok":true');
  });

  test('ignores empty JSON response body', async () => {
    globalThis.fetch = (async () =>
      makeJSONResponse('   ')) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));

    t.send('{}');
    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toEqual([]);
  });

  test('posts with JSON + SSE accept headers and forwards custom headers', async () => {
    let observed: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observed = init;
      return makeJSONResponse('{}');
    }) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({
      url: 'http://example.com/mcp',
      headers: { Authorization: 'Bearer XYZ' },
    });
    t.send('{"hello":"world"}');
    await new Promise((r) => setTimeout(r, 10));

    expect(observed?.method).toBe('POST');
    const headers = observed?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toContain('application/json');
    expect(headers['Accept']).toContain('text/event-stream');
    expect(headers['Authorization']).toBe('Bearer XYZ');
    expect(observed?.body).toBe('{"hello":"world"}');
  });
});

// ── send → SSE response ──────────────────────────────────────

describe('StreamableHTTPTransport.send (SSE response)', () => {
  test('parses "data: " lines and dispatches each event', async () => {
    globalThis.fetch = (async () =>
      makeSSEResponse([
        'event: message\n',
        'data: {"n":1}\n',
        'data: {"n":2}\n',
      ])) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));

    t.send('{"method":"tools/list"}');
    await waitFor(() => (messages.length >= 2 ? messages : undefined));
    expect(messages).toEqual(['{"n":1}', '{"n":2}']);
  });

  test('processes trailing data buffer with no final newline', async () => {
    globalThis.fetch = (async () =>
      makeSSEResponse([
        'data: trailing', // no newline — ends up in buffer
      ])) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));

    t.send('{}');
    await waitFor(() => (messages.length >= 1 ? messages : undefined));
    expect(messages).toEqual(['trailing']);
  });

  test('skips non-data and empty-data SSE lines', async () => {
    globalThis.fetch = (async () =>
      makeSSEResponse([
        ': keepalive\n',
        'data: \n',
        'data: useful\n',
      ])) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    const messages: string[] = [];
    t.onMessage((m) => messages.push(m));

    t.send('{}');
    await waitFor(() => (messages.length >= 1 ? messages : undefined));
    expect(messages).toEqual(['useful']);
  });
});

// ── send → error paths ───────────────────────────────────────

describe('StreamableHTTPTransport.send (errors)', () => {
  test('non-ok HTTP response routes to error handlers', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', {
        status: 502,
        statusText: 'Bad Gateway',
      })) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));

    t.send('{}');
    await waitFor(() => (errors.length >= 1 ? errors : undefined));
    expect(errors[0].message).toMatch(/MCP POST.*502/);
    expect(errors[0].message).toContain('boom');
  });

  test('fetch rejection routes to error handlers with wrapped message', async () => {
    globalThis.fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    const errors: Error[] = [];
    t.onError((e) => errors.push(e));

    t.send('{}');
    await waitFor(() => (errors.length >= 1 ? errors : undefined));
    expect(errors[0].message).toMatch(/MCP POST.*connection refused/);
  });

  test('send is a no-op after close', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return makeJSONResponse('{}');
    }) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    t.close();
    t.send('{"ignored":true}');
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(0);
  });
});

// ── close ────────────────────────────────────────────────────

describe('StreamableHTTPTransport.close', () => {
  test('fires registered close handlers', () => {
    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    let calls = 0;
    t.onClose(() => calls++);
    t.close();
    expect(calls).toBe(1);
  });

  test('marks the transport closed so subsequent sends are ignored', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return makeJSONResponse('{}');
    }) as unknown as typeof fetch;

    const t = new StreamableHTTPTransport({ url: 'http://example.com/mcp' });
    t.close();
    t.send('{}');
    await new Promise((r) => setTimeout(r, 10));
    expect(called).toBe(0);
  });
});
