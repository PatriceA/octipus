import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { parseServiceAccount, type ServiceAccount, VertexTokenManager } from './vertex-token';
import { VertexProvider } from './vertex-provider';

// A real RSA key so buildAssertion() actually signs; 2048-bit keygen is fast.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const SA: ServiceAccount = {
  client_email: 'svc@proj.iam.gserviceaccount.com',
  private_key: PEM,
  token_uri: 'https://oauth2.test/token',
  project_id: 'proj',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function decodeSegment(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

describe('VertexTokenManager.buildAssertion', () => {
  test('produces a signed 3-part RS256 JWT with the expected claims', () => {
    const mgr = new VertexTokenManager(SA, () => 1_700_000_000_000);
    const jwt = mgr.buildAssertion();
    const [header, claims, signature] = jwt.split('.');
    expect(header && claims && signature).toBeTruthy();

    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const c = decodeSegment(claims);
    expect(c.iss).toBe(SA.client_email);
    expect(c.aud).toBe(SA.token_uri);
    expect(c.scope).toBe('https://www.googleapis.com/auth/cloud-platform');
    expect(c.iat).toBe(1_700_000_000);
    expect(c.exp).toBe(1_700_000_000 + 3600);
    expect(signature.length).toBeGreaterThan(0);
  });
});

describe('VertexTokenManager.getAccessToken', () => {
  function stubToken(): () => number {
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toBe(SA.token_uri as string);
      calls++;
      return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  test('mints once and caches within the validity window', async () => {
    const calls = stubToken();
    let now = 1_000_000_000_000;
    const mgr = new VertexTokenManager(SA, () => now);

    expect(await mgr.getAccessToken()).toBe('tok-1');
    now += 60_000; // still well inside the 1h token
    expect(await mgr.getAccessToken()).toBe('tok-1');
    expect(calls()).toBe(1);
  });

  test('refreshes once the token is within the skew of expiry', async () => {
    const calls = stubToken();
    let now = 1_000_000_000_000;
    const mgr = new VertexTokenManager(SA, () => now);

    expect(await mgr.getAccessToken()).toBe('tok-1');
    // expiry = now + 3600s; refresh fires at expiry - 60s skew.
    now += (3600 - 30) * 1000; // past the refresh threshold
    expect(await mgr.getAccessToken()).toBe('tok-2');
    expect(calls()).toBe(2);
  });

  test('coalesces concurrent refreshes into a single mint', async () => {
    const calls = stubToken();
    const mgr = new VertexTokenManager(SA, () => 1_000_000_000_000);
    const [a, b, c] = await Promise.all([mgr.getAccessToken(), mgr.getAccessToken(), mgr.getAccessToken()]);
    expect([a, b, c]).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(calls()).toBe(1);
  });

  test('throws with status detail when the token endpoint rejects', async () => {
    globalThis.fetch = (async () =>
      new Response('bad assertion', { status: 401 })) as unknown as typeof fetch;
    const mgr = new VertexTokenManager(SA, () => 1_000_000_000_000);
    await expect(mgr.getAccessToken()).rejects.toThrow(/401/);
  });
});

describe('parseServiceAccount', () => {
  test('parses valid JSON', () => {
    const sa = parseServiceAccount(JSON.stringify(SA));
    expect(sa.client_email).toBe(SA.client_email);
  });
  test('rejects non-JSON', () => {
    expect(() => parseServiceAccount('not json')).toThrow(/not valid JSON/);
  });
  test('rejects JSON missing required fields', () => {
    expect(() => parseServiceAccount(JSON.stringify({ project_id: 'x' }))).toThrow(/missing/);
  });
});

describe('VertexProvider.supportsModel', () => {
  const p = new VertexProvider();
  test('claims only the vertex/ and vertex_ai/ prefixes', () => {
    expect(p.supportsModel('vertex/gemini-2.0-flash')).toBe(true);
    expect(p.supportsModel('vertex_ai/gemini-1.5-pro')).toBe(true);
    expect(p.supportsModel('gemini-2.0-flash')).toBe(false); // owned by GeminiProvider
    expect(p.supportsModel('grok-4')).toBe(false);
  });
});
