import type { TestRunner } from '../runner';
import { assert } from '../runner';
import type { APIClient } from '../client';
import { fixtures } from '../fixtures';
import { GatewayWSClient } from '../ws-client';
import { randomUUID } from 'crypto';

/**
 * Gateway WebSocket flow — low-level wire protocol.
 * Covers: connect + auth handshake, chat.send → chat.response event,
 * invalid message rejection, disconnect cleanup.
 */
export async function testGatewayWS(runner: TestRunner, client: APIClient) {
  console.log('\n\x1b[1mGateway WebSocket\x1b[0m');

  if (!fixtures.authToken) {
    console.log('  \x1b[33m⊘ No auth token — skipping\x1b[0m');
    return;
  }

  await runner.test('WS connects and completes auth handshake', async () => {
    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      assert(!!ws.connectionId, 'Expected connectionId from auth_ok');
      assert(!!ws.userId, 'Expected userId from auth_ok');
      assert(ws.isOpen, 'WS should be open after auth');
    } finally {
      ws.close();
    }
  });

  await runner.test('WS ping/pong round-trip', async () => {
    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      ws.send({ type: 'ping' });
      const pong = await ws.waitFor((f) => f.type === 'pong', 5_000);
      assert(typeof (pong as any).serverTime === 'string', 'pong should carry serverTime');
    } finally {
      ws.close();
    }
  });

  await runner.test('WS chat.send produces a chat.response event', async () => {
    // Create a session via REST so we have a real sessionId owned by our user
    const sessionResp = await client.request<{ id: string }>('POST', '/sessions', { channel: 'webchat' });
    if (sessionResp.status !== 200 || !sessionResp.data.id) {
      throw new Error(`Could not create session for WS chat test (status ${sessionResp.status})`);
    }
    const sessionId = sessionResp.data.id;

    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      ws.send({
        type: 'chat.send',
        sessionId,
        content: 'Reply with just the word "ok".',
      });
      // Orchestrator response can be slow on a cold model — give it 30s.
      const evt = await ws.waitForEvent('chat.response', 30_000);
      const payload = (evt as any).event.payload;
      assert(!!payload, 'chat.response event should carry a payload');
      assert(payload.response !== undefined, 'chat.response payload should have a response field');
    } finally {
      ws.close();
    }
  });

  await runner.test('WS rejects pre-auth non-auth messages', async () => {
    // Open a raw WS and send a non-auth first frame — expect AUTH_REQUIRED error.
    const ws = new WebSocket(fixtures.gatewayUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('open timeout')), 5000);
        ws.onopen = () => { clearTimeout(t); resolve(); };
        ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
      });

      const errorFrame = await new Promise<any>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no error frame within 5s')), 5000);
        ws.onmessage = (event) => {
          try {
            const f = JSON.parse(event.data as string);
            if (f.type === 'error' || f.type === 'auth_error') {
              clearTimeout(t);
              resolve(f);
            }
          } catch { /* ignore */ }
        };
        // Send a chat.send before auth — must be rejected
        ws.send(JSON.stringify({
          type: 'chat.send',
          sessionId: randomUUID(),
          content: 'should be rejected',
        }));
      });

      assert(
        errorFrame.code === 'AUTH_REQUIRED' || errorFrame.type === 'auth_error',
        `Expected AUTH_REQUIRED/auth_error, got ${JSON.stringify(errorFrame)}`,
      );
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  });

  await runner.test('WS rejects malformed JSON frames post-auth', async () => {
    const ws = new GatewayWSClient();
    try {
      await ws.connect();
      // Send a message that doesn't match any schema — should get INVALID_MESSAGE error.
      // We use the raw socket to bypass our typed send().
      (ws as any).ws.send('{not valid json');
      const err = await ws.waitFor((f) => f.type === 'error', 5_000);
      assert((err as any).code === 'INVALID_MESSAGE', `Expected INVALID_MESSAGE, got ${(err as any).code}`);
    } finally {
      ws.close();
    }
  });

  await runner.test('WS disconnect closes cleanly without hanging server', async () => {
    const ws = new GatewayWSClient();
    await ws.connect();
    const connId = ws.connectionId;
    ws.close();
    // Give the server a moment to register the close.
    await new Promise(r => setTimeout(r, 200));
    // /gateway/status should still work (sanity: server didn't die).
    const { status, data } = await client.request<{ started: boolean; connections: { total: number } }>(
      'GET', '/gateway/status',
    );
    assert(status === 200, `Expected gateway/status 200 after close, got ${status}`);
    assert(data.started === true, 'Gateway should still be started');
    assert(!!connId, 'Expected a connectionId before close');
  });
}
