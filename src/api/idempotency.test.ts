/**
 * The `Idempotency-Key` route wrapper: replay with the original status, the
 * in-progress 409 carrying the meta the running request recorded, an overlong
 * key refused, and requests without a key or without a user untouched.
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import { closeStorage, initializeStorage } from '@/db/storage';
import { idempotencyTrack, idempotent } from './idempotency';

beforeAll(() => { initializeStorage({ mode: 'embedded' }); });
afterAll(async () => { await closeStorage(); });

let release = () => {};
const created = vi.fn();
let authed = true;
const app = new Elysia()
  .derive(() => ({ user: authed ? { id: 'u1' } : null }))
  .post('/things', idempotent('things', async ({ body, set, request }) => {
    created(body);
    await idempotencyTrack(request)?.setMeta({ thingId: 't-1' });
    if (body.slow) await new Promise<void>(r => { release = r; });
    set.status = 201;
    return { id: 't-1' };
  }, { joinWaitMs: 50 }));

const post = (body: object, key?: string) => app.handle(new Request('http://test/things', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}));

test('a replay keeps the original status and says it is a replay', async () => {
  created.mockClear();
  expect((await post({ n: 1 }, 'k1')).status).toBe(201);
  const again = await post({ n: 1 }, 'k1');
  expect(again.status).toBe(201);
  expect(again.headers.get('idempotent-replayed')).toBe('true');
  expect(await again.json()).toEqual({ id: 't-1' });
  expect(created).toHaveBeenCalledTimes(1);
});

test('a retry past the join wait gets 409 with what the running request recorded', async () => {
  const first = post({ slow: true }, 'k2');
  await vi.waitFor(() => expect(created).toHaveBeenCalledWith({ slow: true }));
  await new Promise(r => setTimeout(r, 10));
  const busy = await post({ slow: true }, 'k2');
  expect(busy.status).toBe(409);
  expect(busy.headers.get('retry-after')).toBe('5');
  expect(await busy.json()).toMatchObject({ code: 'idempotency_in_progress', status: 'in_progress', thingId: 't-1' });
  release();
  expect((await first).status).toBe(201);
});

test('an overlong key is refused; no key or no user runs the handler as before', async () => {
  expect((await post({ n: 2 }, 'x'.repeat(300))).status).toBe(400);
  created.mockClear();
  await post({ n: 3 });
  await post({ n: 3 });
  authed = false;
  await post({ n: 3 }, 'k3');
  await post({ n: 3 }, 'k3');
  authed = true;
  expect(created).toHaveBeenCalledTimes(4);
});
