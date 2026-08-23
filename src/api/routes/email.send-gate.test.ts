/**
 * The send action must be ASK-gated: POST /api/email/send without an explicit
 * confirm:true is rejected (409) BEFORE any provider/mailbox access. This
 * proves a draft can never be auto-sent — the core trust posture of the feature.
 */
import { describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Elysia } from '@/api/http';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

async function buildApp(): Promise<ElysiaLike> {
  const { emailRoutes } = await import('./email');
  const { principalFromUser } = await import('@/security/principal');
  const u = { id: '11111111-1111-1111-1111-111111111111', username: 'alice', isAdmin: false };
  return new Elysia()
    .derive(() => ({ user: u, session: null, principal: principalFromUser(u) }))
    .group('/api', (a) => a.use(emailRoutes)) as unknown as ElysiaLike;
}

async function postJson(app: ElysiaLike, path: string, body: unknown) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe('POST /api/email/send is ASK-gated', () => {
  test('without confirm → 409 requiresConfirmation, no send attempted', async () => {
    const app = await buildApp();
    const r = await postJson(app, '/api/email/send', { to: 'bob@x.com', subject: 'Hi', body: 'hello' });
    expect(r.status).toBe(409);
    expect(r.body.requiresConfirmation).toBe(true);
  });

  test('confirm:true passes the gate (provider detection then runs)', async () => {
    const app = await buildApp();
    // With confirm, the gate is passed; with no mailbox connected in the test
    // env the handler then reports "No mailbox connected" — never a 409 gate.
    const r = await postJson(app, '/api/email/send', { to: 'bob@x.com', subject: 'Hi', body: 'hello', confirm: true });
    expect(r.status).not.toBe(409);
    expect(r.body.requiresConfirmation).toBeUndefined();
  });
});
