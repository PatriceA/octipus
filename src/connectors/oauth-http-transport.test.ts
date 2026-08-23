import { describe, expect, test, vi } from 'vitest';
import { OAuthHTTPTransport } from './oauth-http-transport';

describe('OAuthHTTPTransport', () => {
  test('injects Authorization header into POST', async () => {
    const requests: Request[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (req: Request | string) => {
      const r = req instanceof Request ? req : new Request(req);
      requests.push(r);
      return new Response(JSON.stringify({ id: 1, result: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const getToken = vi.fn(async () => 'test-token-abc');
    const transport = new OAuthHTTPTransport('https://example.com/mcp', getToken);
    await transport.connect();

    let received: string | undefined;
    transport.onMessage((msg) => { received = msg; });

    transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test', params: {} }));
    await new Promise((r) => setTimeout(r, 20));

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('Authorization')).toBe('Bearer test-token-abc');
    expect(received).toBeDefined();
    globalThis.fetch = origFetch;
  });

  test('calls getToken once per send', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 1, result: {} }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const getToken = vi.fn(async () => 'tok');
    const transport = new OAuthHTTPTransport('https://example.com/mcp', getToken);
    await transport.connect();
    transport.onMessage(() => {});
    transport.send('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}');
    transport.send('{"jsonrpc":"2.0","id":2,"method":"pong","params":{}}');
    await new Promise((r) => setTimeout(r, 20));
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
