// src/security/atlassian-oauth.test.ts
import { describe, expect, mock, test } from 'bun:test';

describe('atlassian oauth dynamic registration', () => {
  test('discovers registration endpoint from well-known URL', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | Request) => {
      const u = url instanceof Request ? url.url : url;
      if (u.includes('well-known')) {
        return new Response(JSON.stringify({
          issuer: 'https://auth.atlassian.com',
          authorization_endpoint: 'https://auth.atlassian.com/authorize',
          token_endpoint: 'https://auth.atlassian.com/oauth/token',
          registration_endpoint: 'https://auth.atlassian.com/register',
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('register')) {
        return new Response(JSON.stringify({ client_id: 'dynamic-client-123' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const { discoverAndRegisterAtlassian } = await import('./oauth');
    const result = await discoverAndRegisterAtlassian('https://octipus.example.com');
    expect(result.clientId).toBe('dynamic-client-123');
    expect(result.authorizationEndpoint).toBe('https://auth.atlassian.com/authorize');
    expect(result.tokenEndpoint).toBe('https://auth.atlassian.com/oauth/token');
    globalThis.fetch = origFetch;
  });
});
