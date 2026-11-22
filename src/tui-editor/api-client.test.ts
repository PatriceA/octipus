import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { ApiClient } from './api-client';
import { WorkspaceStore } from './stores/workspace-store';

let server: Server | null = null;
afterEach(async () => { await new Promise<void>((resolve) => { if (server) server.close(() => resolve()); else resolve(); }); server = null; });

/** A local server answering with `handle`; resolves to its base URL. */
async function serve(handle: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handle);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('ApiClient', () => {
  test('sends the active workspace and returns the JSON', async () => {
    const seen: Array<string | undefined> = [];
    const baseUrl = await serve((req, res) => {
      seen.push(req.headers['x-octipus-workspace'] as string | undefined);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: req.url }));
    });
    const workspaceStore = new WorkspaceStore();
    const client = new ApiClient({ baseUrl, workspaceStore });
    expect(await client.getJson('/me')).toEqual({ ok: true, data: { ok: '/me' } });
    workspaceStore.setActive('team');
    expect((await client.postJson('/x', { a: 1 })).ok).toBe(true);
    expect(seen).toEqual([undefined, 'team']);
  });

  test('a server that never answers times out with a reason (docs/plans/tui-modernization.md §5.2)', async () => {
    const baseUrl = await serve(() => { /* never answers */ });
    const client = new ApiClient({ baseUrl, workspaceStore: new WorkspaceStore(), timeoutMs: 100 });
    const started = Date.now();
    const result = await client.getJson('/slow');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toEqual({ ok: false, error: `${baseUrl}/slow did not answer within 0.1 s` });
    server?.closeAllConnections();
  });

  test('an HTTP error, a body that is not JSON and an unreachable server each say what happened', async () => {
    const baseUrl = await serve((req, res) => {
      if (req.url === '/missing') { res.statusCode = 404; res.end('nope'); return; }
      res.end('<html>');
    });
    const client = new ApiClient({ baseUrl, workspaceStore: new WorkspaceStore() });
    expect(await client.getJson('/missing')).toEqual({ ok: false, error: `${baseUrl}/missing answered 404 Not Found` });
    const notJson = await client.getJson('/page');
    expect(!notJson.ok && notJson.error).toMatch(/did not return JSON/);
    const down = await new ApiClient({ baseUrl: 'http://127.0.0.1:1', workspaceStore: new WorkspaceStore() }).getJson('/x');
    expect(!down.ok && down.error).toMatch(/could not be reached/);
  });
});
