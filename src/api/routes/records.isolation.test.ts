/**
 * /api/record-types, /api/records and the public /api/forms routes: another
 * user's type or record is a 404, invalid data is a 400 naming each problem,
 * and a form link takes a submission without sign-in, by its token alone.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-4111-8111-111111111111';
const bobId = '22222222-2222-4222-8222-222222222222';
let aliceApp: ElysiaLike;
let bobApp: ElysiaLike;
let publicApp: ElysiaLike;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-records-routes-'));
  const { initializeDb, executeRaw } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${aliceId}', 'alice', false), ('${bobId}', 'bob', false) ON CONFLICT DO NOTHING`);
  const { recordTypeRoutes, recordRoutes, publicFormRoutes } = await import('./records');
  const { caseRoutes } = await import('./cases');
  const { principalFromUser } = await import('@/security/principal');
  const build = (uid: string): ElysiaLike =>
    new Elysia()
      .derive(() => {
        const u = { id: uid, username: 'u', isAdmin: false };
        return { user: u, session: null, principal: principalFromUser(u) };
      })
      .group('/api', (a) => a.use(recordTypeRoutes).use(recordRoutes).use(caseRoutes)) as unknown as ElysiaLike;
  aliceApp = build(aliceId);
  bobApp = build(bobId);
  publicApp = new Elysia().group('/api', (a) => a.use(publicFormRoutes)) as unknown as ElysiaLike;
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function call(app: ElysiaLike, method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }));
  return { status: res.status, body: await res.json() };
}

const FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'phone', label: 'Phone', type: 'phone', required: true },
];

describe('record routes', () => {
  test('types and records round-trip; another user gets 404s', async () => {
    const type = await call(aliceApp, 'POST', '/api/record-types', { key: 'callback', name: 'Callback', fields: FIELDS, titleField: 'name' });
    expect(type.status).toBe(200);
    const rec = await call(aliceApp, 'POST', '/api/records', { type: 'callback', data: { name: 'Frau K.', phone: '+49 89 1' } });
    expect([rec.status, rec.body.title]).toEqual([200, 'Frau K.']);
    expect((await call(aliceApp, 'GET', '/api/records?type=callback')).body).toHaveLength(1);
    expect((await call(aliceApp, 'PATCH', `/api/records/${rec.body.id}`, { data: { phone: '+49 89 2' } })).body.data.phone).toBe('+49 89 2');

    expect((await call(bobApp, 'GET', `/api/record-types/${type.body.id}`)).status).toBe(404);
    expect((await call(bobApp, 'GET', `/api/records/${rec.body.id}`)).status).toBe(404);
    expect((await call(bobApp, 'PATCH', `/api/records/${rec.body.id}`, { data: { name: 'x' } })).status).toBe(404);
    expect((await call(bobApp, 'DELETE', `/api/records/${rec.body.id}`)).status).toBe(404);
    expect((await call(bobApp, 'GET', '/api/records?type=callback')).body).toEqual([]);
    expect((await call(bobApp, 'POST', `/api/record-types/${type.body.id}/form-links`, { title: 'x' })).status).toBe(404);
  });

  test('invalid fields and data are a 400 with every problem', async () => {
    const badType = await call(aliceApp, 'POST', '/api/record-types', { key: 'bad', name: 'Bad', fields: [{ key: 'x', label: 'X', type: 'select' }] });
    expect(badType.status).toBe(400);
    expect(badType.body.problems).toEqual(['Field "x" is a select and needs options']);
    const bad = await call(aliceApp, 'POST', '/api/records', { type: 'callback', data: { phone: 'call me', extra: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.problems).toEqual(expect.arrayContaining(['Unknown field "extra"', 'Phone: must be a phone number', 'Name: required']));
  });
});

describe('public forms', () => {
  test('mint, show, submit, revoke', async () => {
    const type = (await call(aliceApp, 'POST', '/api/record-types', { key: 'enquiry', name: 'Enquiry', fields: FIELDS })).body;
    const minted = await call(aliceApp, 'POST', `/api/record-types/${type.id}/form-links`, { title: 'Ask us', intro: 'We call back.', caseKind: 'inquiry' });
    expect(minted.status).toBe(200);
    const token = minted.body.token as string;
    expect(minted.body.path).toBe(`/forms/${token}`);
    expect(minted.body.tokenHash).toBeUndefined();

    const shown = await call(publicApp, 'GET', `/api/forms/${token}`);
    expect(shown.body).toEqual({ title: 'Ask us', intro: 'We call back.', fields: type.fields });
    const bad = await call(publicApp, 'POST', `/api/forms/${token}`, { data: { name: 'x' } });
    expect([bad.status, bad.body.problems]).toEqual([400, ['Phone: required']]);
    expect((await call(publicApp, 'POST', `/api/forms/${token}`, { data: { name: 'Ole', phone: '0151 123' } })).body).toEqual({ submitted: true });
    expect((await call(aliceApp, 'GET', '/api/cases?kind=inquiry')).body).toHaveLength(1);

    expect((await call(aliceApp, 'DELETE', `/api/record-types/${type.id}/form-links/${minted.body.id}`)).status).toBe(200);
    expect((await call(publicApp, 'GET', `/api/forms/${token}`)).status).toBe(404);
    expect((await call(publicApp, 'POST', `/api/forms/${token}`, { data: { name: 'x', phone: '1234' } })).status).toBe(404);
    expect((await call(publicApp, 'GET', '/api/forms/unknown-token-0000000000000')).status).toBe(404);
  });

  test('the form routes are public with a rate window of their own; nothing else under them is public', async () => {
    const { isPublicRoute } = await import('@/api/middleware/auth-guard');
    const { isCredentialAttempt, isPublicFormPath } = await import('@/api/middleware/rate-limit');
    expect(isPublicRoute('GET', '/api/forms/abc')).toBe(true);
    expect(isPublicRoute('POST', '/api/forms/abc')).toBe(true);
    expect(isPublicRoute('DELETE', '/api/forms/abc')).toBe(false);
    expect(isPublicRoute('GET', '/api/forms/abc/extra')).toBe(false);
    expect(isPublicRoute('GET', '/api/record-types')).toBe(false);
    expect(isPublicFormPath('/api/forms/abc')).toBe(true);
    // Not the sign-in bucket: filling in a form must not lock an office out of logging in.
    expect(isCredentialAttempt('/api/forms/abc')).toBe(false);
  });
});
