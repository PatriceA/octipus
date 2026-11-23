import { describe, expect, test } from 'vitest';
import { App, cors, t } from '@/api/http';

const inner = new App({ prefix: '/health' })
  .post('/upload', ({ body }) => ({ count: Array.isArray(body.files) ? body.files.length : 1 }), {
    body: t.Object({ files: t.Union([t.File(), t.Array(t.File())]) }),
  })
  .get('/', () => ({ status: 'ok' }))
  .get('/:id', ({ params }) => ({ id: params.id }))
  .post('/echo', ({ body }) => ({ got: body }), { body: t.Object({ n: t.Number() }) })
  .get('/q', ({ query }) => ({ n: query.n, type: typeof query.n }), { query: t.Object({ n: t.Number() }) });

const app = new App()
  .use(cors({ origin: true, credentials: true }))
  .onAfterHandle(({ set }) => { set.headers['X-Test'] = '1'; })
  .onError(({ code }) => (code === 'NOT_FOUND' ? { error: 'Not found' } : { error: 'boom' }))
  .derive(() => ({ user: { id: 'u1' } }))
  .onBeforeHandle((ctx: any) => {
    if (new URL(ctx.request.url).pathname === '/api/health/blocked') {
      ctx.set.status = 401;
      return { error: 'nope' };
    }
  })
  .group('/api', (a) => a.use(inner));

const call = async (path: string, init?: RequestInit) => {
  const res = await app.handle(new Request(`http://x${path}`, init));
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
};


describe('the application pipeline', () => {
  test('serves the root of a prefixed group and applies after-hook headers', async () => {
    const r = await call('/api/health');
    expect([r.status, r.body]).toEqual([200, { status: 'ok' }]);
    expect(r.headers['x-test']).toBe('1');
  });

  test('echoes an allowed CORS origin', async () => {
    const r = await call('/api/health', { headers: { origin: 'http://a' } });
    expect(r.headers['access-control-allow-origin']).toBe('http://a');
  });

  test('answers a preflight before the auth guard could reject it', async () => {
    const r = await call('/api/health', { method: 'OPTIONS', headers: { origin: 'http://a' } });
    expect(r.status).toBe(204);
  });

  test('binds a path parameter', async () => {
    expect(await call('/api/health/abc').then((r) => r.body)).toEqual({ id: 'abc' });
  });

  test('a static segment wins over a parameter declared before it', async () => {
    // `/health/:id` is registered first; `/health/q` must still match itself.
    const r = await call('/api/health/q?n=42');
    expect([r.status, r.body]).toEqual([200, { n: 42, type: 'number' }]);
  });

  test('a query field is coerced to its declared type, and rejected when it cannot be', async () => {
    expect((await call('/api/health/q?n=42')).body).toEqual({ n: 42, type: 'number' });
    expect((await call('/api/health/q?n=abc')).status).toBe(422);
  });

  test('a body is NOT coerced — a string where a number belongs is a 422', async () => {
    const post = (b: unknown) =>
      call('/api/health/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
    expect((await post({ n: 1 })).body).toEqual({ got: { n: 1 } });
    // The point of the rule: coercion here would turn the mismatch the schema
    // exists to catch into a silently accepted `"seven"` → `7`.
    expect((await post({ n: 'seven' })).status).toBe(422);
  });

  test('a before-hook return short-circuits the route', async () => {
    expect(await call('/api/health/blocked').then((r) => [r.status, r.body])).toEqual([401, { error: 'nope' }]);
  });

  test('a file field accepts a file and rejects an absent one', async () => {
    // `t.File()` must not be a stand-in for "anything": aliased to `Any` it
    // also matched `undefined`, so an upload with no files answered 200 and
    // uploaded nothing instead of 422.
    const form = new FormData();
    form.append('files', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    const ok = await app.handle(
      new Request('http://x/api/health/upload', { method: 'POST', body: form }),
    );
    expect([ok.status, await ok.json()]).toEqual([200, { count: 1 }]);

    const empty = await app.handle(
      new Request('http://x/api/health/upload', { method: 'POST', body: new FormData() }),
    );
    expect(empty.status).toBe(422);
  });

  test('an unmatched path reaches the error hook as NOT_FOUND', async () => {
    expect(await call('/api/nope').then((r) => [r.status, r.body])).toEqual([404, { error: 'Not found' }]);
  });
});

describe('hook scoping', () => {
  test('a surface with its own error hook wins over the application-wide one', async () => {
    // The real case: the OpenAI-compatible routes shape failures into the SDK's
    // error envelope. Hoisting every hook to the root put the application
    // handler first and made that unreachable, so a bad body answered the
    // generic 422 and an OpenAI client could not read it.
    const surface = new App({ prefix: '/v1' })
      .onError(({ code, set }) => {
        if (code !== 'VALIDATION') return;
        set.status = 400;
        return { error: { message: 'bad request', type: 'invalid_request_error' } };
      })
      .post('/chat', () => ({ ok: true }), { body: t.Object({ n: t.Number() }) });

    const other = new App({ prefix: '/api' })
      .post('/thing', () => ({ ok: true }), { body: t.Object({ n: t.Number() }) });

    const root = new App()
      .onError(({ code }) => (code === 'VALIDATION' ? { error: 'Invalid request data' } : { error: 'boom' }))
      .use(surface)
      .use(other);

    const post = (path: string) =>
      root.handle(new Request(`http://x${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: 'nope' }),
      }));

    const scoped = await post('/v1/chat');
    expect([scoped.status, await scoped.json()]).toEqual([
      400,
      { error: { message: 'bad request', type: 'invalid_request_error' } },
    ]);

    // And the application-wide handler still answers everything else.
    const generic = await post('/api/thing');
    expect([generic.status, await generic.json()]).toEqual([422, { error: 'Invalid request data' }]);
  });

  test('a plugin mounted by many modules contributes its hook once', async () => {
    // The shared API-context plugin is `.use()`d by fifty-five route modules.
    // Without dedupe its derive ran fifty-five times on every request.
    let derives = 0;
    const plugin = new App({ name: 'shared' }).derive(() => {
      derives += 1;
      return { tagged: true };
    });

    const a = new App({ prefix: '/a' }).use(plugin).get('/x', ({ tagged }) => ({ tagged }));
    const b = new App({ prefix: '/b' }).use(plugin).get('/y', ({ tagged }) => ({ tagged }));
    const root = new App().use(a).use(b);

    expect(await root.handle(new Request('http://x/a/x')).then((r) => r.json())).toEqual({ tagged: true });
    expect(derives).toBe(1);
    expect(await root.handle(new Request('http://x/b/y')).then((r) => r.json())).toEqual({ tagged: true });
    expect(derives).toBe(2); // once per request, not once per mount
  });

  test('a hook mounted under a prefix does not run for other paths', async () => {
    const seen: string[] = [];
    const scoped = new App({ prefix: '/only' })
      .onRequest((ctx: any) => { seen.push(new URL(ctx.request.url).pathname); })
      .get('/here', () => ({ ok: true }));
    const root = new App().use(scoped).get('/elsewhere', () => ({ ok: true }));

    await root.handle(new Request('http://x/elsewhere'));
    expect(seen).toEqual([]);
    await root.handle(new Request('http://x/only/here'));
    expect(seen).toEqual(['/only/here']);
  });
});

describe('response headers are keyed case-insensitively', () => {
  const headersApp = new App()
    .onAfterHandle(({ set }) => {
      set.headers['Content-Security-Policy'] ??= "default-src 'self'";
      set.headers['X-Frame-Options'] ??= 'DENY';
    })
    .get('/own', ({ set }) => {
      set.headers['content-security-policy'] = "default-src 'none'; sandbox";
      return 'x';
    })
    .get('/default', () => 'y');

  test("a default does not replace a handler's lower-case header, and only one copy is sent", async () => {
    const own = await headersApp.handle(new Request('http://x/own'));
    expect(own.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(own.headers.get('x-frame-options')).toBe('DENY');
    const plain = await headersApp.handle(new Request('http://x/default'));
    expect(plain.headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  test('a path spelling an unreserved character in percent-encoding is refused before routing', async () => {
    const strict = new App().get('/api/thing', () => 'ok');
    expect((await strict.handle(new Request('http://x/api/thing'))).status).toBe(200);
    for (const p of ['/%61pi/thing', '/api/%54hing', '/api/thing%', '/api/thing%G1']) {
      expect((await strict.handle(new Request(`http://x${p}`))).status, p).toBe(400);
    }
  });
});

describe('App — streamed responses', () => {
  test('a reader that goes away returns the generator, so its finally runs', async () => {
    let released = false;
    const root = new App().get('/sse', () => (async function* () {
      try {
        yield 'data: 1\n\n';
        yield 'data: 2\n\n';
        yield 'data: 3\n\n';
      } finally {
        released = true;
      }
    })());
    const res = await root.handle(new Request('http://x/sse'));
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n');
    expect(released).toBe(false);
    await reader.cancel();
    expect(released).toBe(true);
  });
});

describe('a default header never replaces one the handler set', () => {
  const withDefaults = new App()
    .onAfterHandle(({ set }) => {
      set.headers['Content-Security-Policy'] ??= "default-src 'self'";
      set.headers['cache-control'] ??= 'no-cache';
      set.headers['X-Content-Type-Options'] = 'nosniff';
    })
    .get('/own-response', () => new Response('page', { headers: { 'Content-Security-Policy': "default-src 'none'; sandbox" } }))
    .get('/own-response-status', ({ set }) => {
      set.status = 202;
      return new Response('page', { status: 200, headers: { 'content-security-policy': "default-src 'none'; sandbox" } });
    })
    .get('/assigned', ({ set }) => {
      Object.assign(set.headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      return 'data: x\n\n';
    });

  test('on a Response the handler returned, its own headers stay; defaults only add', async () => {
    for (const path of ['/own-response', '/own-response-status']) {
      const res = await withDefaults.handle(new Request(`http://x${path}`));
      expect(res.headers.get('content-security-policy'), path).toBe("default-src 'none'; sandbox");
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
    }
  });

  test('headers merged into set.headers stay case-insensitive', async () => {
    const res = await withDefaults.handle(new Request('http://x/assigned'));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('a non-canonical path is refused with the usual response headers', () => {
  test('the 400 carries CORS for an allowed origin and the after-hook headers', async () => {
    const res = await app.handle(new Request('http://x/%61pi/health', { headers: { origin: 'https://desk.test' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Bad request path', code: 'non_canonical_path' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://desk.test');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('x-test')).toBe('1');
  });
});
