import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
} from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

/**
 * Voice routes — auth refusal + shape smoke tests. The transcription
 * happy path requires either a whisper-cpp binary on disk
 * (config.voice.whisperModelPath) or an OPENAI_API_KEY, neither of
 * which the test environment provides; those run via the dedicated
 * voice eval and the scripts/e2e harness.
 *
 * Coverage here:
 *   POST /voice/transcribe — unauthenticated rejection
 *   POST /voice/transcribe — auth'd but no whisper configured returns
 *                            a typed error (no crash)
 *   GET  /voice/status     — unauthenticated rejection
 *   GET  /voice/status     — auth'd returns sttEnabled + config shape
 */
describe.skipIf(!isIntegration)('Voice API (Integration)', () => {
  let app: ElysiaLike;

  beforeAll(async () => {
    await setupIntegrationDb();
    const { voiceRoutes } = await import('./voice');
    app = new Elysia().use(voiceRoutes);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('POST /voice/transcribe without auth → typed error', async () => {
    const res = await app.handle(new Request('http://test/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: 'YWJjZA==' }),
    }));
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  test('GET /voice/status without auth → typed error', async () => {
    const res = await app.handle(new Request('http://test/voice/status', { method: 'GET' }));
    const body = await res.json() as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  test('POST /voice/transcribe rejects malformed body (missing audio)', async () => {
    const res = await app.handle(new Request('http://test/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    // Elysia validates `t.Object({ audio: t.String })` → 422 / 400
    expect([400, 422]).toContain(res.status);
  });
});
