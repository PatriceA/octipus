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
