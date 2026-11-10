import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/connectors/definitions', async () => (await import('@/test-helpers/connector-fixtures')).mockDefinitions());

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe('connector oauth dynamic registration', () => {
  test('discovers registration endpoint from well-known URL', async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | Request) => {
      const u = url instanceof Request ? url.url : url;
      seen.push(u);
      if (u.includes('well-known')) {
        return new Response(JSON.stringify({
          issuer: 'https://auth.example.test',
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/oauth/token',
          registration_endpoint: 'https://auth.example.test/register',
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('register')) {
        return new Response(JSON.stringify({ client_id: 'dynamic-client-123' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const { discoverAndRegisterConnector } = await import('./oauth');
    const result = await discoverAndRegisterConnector('example', 'https://octipus.example.com');
    expect(result.clientId).toBe('dynamic-client-123');
    expect(result.authorizationEndpoint).toBe('https://auth.example.test/authorize');
    expect(result.tokenEndpoint).toBe('https://auth.example.test/oauth/token');
    expect(seen[0]).toBe('https://mcp.example.test/.well-known/oauth-authorization-server');
  });

  test('a removed connector id (atlassian, linear) is refused before any request', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const { discoverAndRegisterConnector } = await import('./oauth');
    for (const id of ['atlassian', 'linear']) {
      await expect(discoverAndRegisterConnector(id, 'https://octipus.example.com')).rejects.toThrow(`Unknown connector: ${id}`);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
