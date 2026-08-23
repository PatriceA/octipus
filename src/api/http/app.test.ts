import { describe, expect, test } from 'vitest';
import { App, cors, t } from '@/api/http';

const inner = new App({ prefix: '/health' })
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

  test('an unmatched path reaches the error hook as NOT_FOUND', async () => {
    expect(await call('/api/nope').then((r) => [r.status, r.body])).toEqual([404, { error: 'Not found' }]);
  });
});
