/**
 * WebSocket upgrades on the artifact host (`serve.ts`): only the gateway is
 * accepted there (where it admits artifact viewers only); every other socket
 * is refused. On the app's host all of them open.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('@/core/artifacts/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/artifacts/settings')>();
  return {
    ...actual,
    resolveArtifactSettings: () => ({ host: 'artifacts.test', proto: 'https' as const, gatewayWss: '', tokenSecret: '', sdkSha256: '', bundlesDir: '' }),
  };
});

import { App } from './app';
import { listen, type RunningServer } from './serve';

let server: RunningServer;

beforeAll(async () => {
  const app = new App();
  for (const path of ['/gateway', '/voice', '/ws/browser-bridge', '/federation']) {
    app.ws(path, { open() {}, message() {}, close() {} });
  }
  server = listen(app, { hostname: '127.0.0.1', port: 0 });
  // The port is known once the server is listening.
  for (let i = 0; i < 100 && !server.port; i++) await new Promise((r) => setTimeout(r, 10));
});

afterAll(() => server.stop());

function opens(path: string, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers: { host } });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
}

describe('sockets on the artifact host', () => {
  test('only the gateway upgrades there', async () => {
    expect(await opens('/gateway', 'artifacts.test')).toBe(true);
    for (const path of ['/voice', '/ws/browser-bridge', '/federation']) {
      expect(await opens(path, 'artifacts.test'), path).toBe(false);
      expect(await opens(path, 'ARTIFACTS.test:443'), path).toBe(false);
    }
  });

  test('on the app host every socket still upgrades', async () => {
    for (const path of ['/gateway', '/voice', '/ws/browser-bridge', '/federation']) {
      expect(await opens(path, 'app.test'), path).toBe(true);
    }
  });
});
