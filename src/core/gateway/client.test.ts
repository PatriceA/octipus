import { afterEach, describe, expect, test, vi } from 'vitest';
import { FakeSocket } from '@/tui-pi/testing/wire';
import { GatewayClient } from './client';

vi.mock('@/core/gateway/cli-session', () => ({
  readCliSession: () => ({ token: 'cli-token', userId: 'u1', username: 'alice', isAdmin: false }),
  clearCliSession: () => {},
}));

/**
 * Regression: `respondPermission` used to emit `approval.respond` (the
 * root agent-approval channel) rather than `permission.respond` (the
 * tool-permission channel). The two are routed by different handlers
 * server-side, so the TUI's "approve" tap landed in the wrong queue
 * and never released the waiting agent — users had to re-approve from
 * a different surface (e.g. web UI) for the tool to actually run.
 *
 * These tests pin the wire format. They use a minimal stub WebSocket
 * to avoid spinning up a real connection.
 */

interface SentMessage {
  type: string;
  [k: string]: unknown;
}

function stubClient() {
  const sent: SentMessage[] = [];
  const client = new GatewayClient({});
  // Inject a stub WS that records every send. The client only checks
  // `this.ws?.readyState === OPEN` and then calls `this.ws.send(json)`.
  (client as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as SentMessage),
  };
  return { client, sent };
}

describe('GatewayClient — permission/approval wire format', () => {
  test('respondPermission emits `permission.respond` with requestId + approved', () => {
    const { client, sent } = stubClient();
    client.respondPermission('req-1', true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'permission.respond',
      requestId: 'req-1',
      approved: true,
    });
  });

  test('respondPermission(false) emits a deny on the same channel', () => {
    const { client, sent } = stubClient();
    client.respondPermission('req-2', false);
    expect(sent[0]).toEqual({
      type: 'permission.respond',
      requestId: 'req-2',
      approved: false,
    });
  });

  test('respondApproval emits `approval.respond` with response text', () => {
    const { client, sent } = stubClient();
    client.respondApproval('req-3', true);
    expect(sent[0]).toMatchObject({
      type: 'approval.respond',
      requestId: 'req-3',
      approved: true,
      response: 'yes',
    });
  });

  test('respondApproval allows a custom response string (multi-option prompts)', () => {
    const { client, sent } = stubClient();
    client.respondApproval('req-4', true, 'keep going');
    expect(sent[0]).toEqual({
      type: 'approval.respond',
      requestId: 'req-4',
      approved: true,
      response: 'keep going',
    });
  });

  test('the two channels are distinct (cross-wiring would re-introduce the original bug)', () => {
    const { client, sent } = stubClient();
    client.respondPermission('p-1', true);
    client.respondApproval('a-1', true);
    expect(sent[0].type).toBe('permission.respond');
    expect(sent[1].type).toBe('approval.respond');
  });
});

describe('GatewayClient — session-scoped commands and dropped events', () => {
  test('sendCommand carries the session so a resumed session works before its first chat.send', () => {
    const { client, sent } = stubClient();
    client.sendCommand('history', undefined, '11111111-2222-4333-8444-555555555555');
    expect(sent[0]).toEqual({ type: 'command', name: 'history', args: undefined, sessionId: '11111111-2222-4333-8444-555555555555' });
  });

  test('sendChat carries a send mode only when asked, and stopAgent sends agent.stop', () => {
    const { client, sent } = stubClient();
    const sid = '11111111-2222-4333-8444-555555555555';
    client.sendChat(sid, 'plain');
    client.sendChat(sid, 'after the turn', undefined, undefined, 'queue');
    client.stopAgent('agent-7');
    client.stopSession(sid);
    expect(sent).toEqual([
      { type: 'chat.send', sessionId: sid, content: 'plain' },
      { type: 'chat.send', sessionId: sid, content: 'after the turn', mode: 'queue' },
      { type: 'agent.stop', agentId: 'agent-7' },
      { type: 'session.stop', sessionId: sid },
    ]);
  });

  test('every send says whether the frame went out: false while the socket is not open', () => {
    const { client, sent } = stubClient();
    expect(client.sendChat('11111111-2222-4333-8444-555555555555', 'hi')).toBe(true);
    (client as unknown as { ws: { readyState: number } }).ws.readyState = 3; // CLOSED
    expect(client.sendChat('11111111-2222-4333-8444-555555555555', 'lost')).toBe(false);
    expect(client.sendCommand('status')).toBe(false);
    expect(client.stopAgent('a')).toBe(false);
    expect(client.stopSession('11111111-2222-4333-8444-555555555555')).toBe(false);
    expect(client.respondPermission('r', true)).toBe(false);
    expect(client.respondApproval('r', true)).toBe(false);
    expect(new GatewayClient({}).sendCommand('status')).toBe(false); // never connected
    expect(sent).toHaveLength(1);
  });

  test('events_dropped reaches the UI as an error instead of vanishing', () => {
    const errors: string[] = [];
    const client = new GatewayClient({ onError: (m) => errors.push(m) });
    (client as unknown as { handleMessage: (raw: string) => void })
      .handleMessage(JSON.stringify({ type: 'events_dropped', count: 12, reason: 'slow consumer' }));
    expect(errors).toEqual(['Gateway dropped 12 event(s) (slow consumer) — the transcript may be incomplete.']);
  });
});

describe('GatewayClient — attachments go over REST, the turn names them', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const image = { name: 'shot.png', mimeType: 'image/png', data: Buffer.alloc(300 * 1024, 7).toString('base64') };

  test('an image larger than the frame cap is uploaded, and chat.send carries only fileRefs', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ uploaded: [{ path: '.octipus/attachments/a/shot.png', name: 'shot.png' }] }), { status: 200 });
    }));
    const { client, sent } = stubClient();
    (client as unknown as { options: { url: string; getWorkspace: () => string } }).options = { url: 'ws://host:3005/gateway', getWorkspace: () => 'work' };
    (client as unknown as { maxFrameBytes: number }).maxFrameBytes = 262_144;

    const sid = '11111111-2222-4333-8444-555555555555';
    const result = await client.uploadAttachments(sid, [image], 'What is this?');
    expect(result).toEqual({ sessionId: sid, uploaded: [{ path: '.octipus/attachments/a/shot.png', name: 'shot.png' }] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://host:3005/api/sessions/${sid}/attachments`);
    expect(calls[0].init.headers).toEqual({ Authorization: 'Bearer cli-token', 'X-Octipus-Workspace': 'work' });
    const file = (calls[0].init.body as FormData).get('files') as File;
    expect(file.name).toBe('shot.png');
    expect(file.size).toBe(300 * 1024);

    client.sendChat(sid, 'What is this?', undefined, [{ path: result.uploaded[0].path }]);
    expect(sent).toEqual([{ type: 'chat.send', sessionId: sid, content: 'What is this?', fileRefs: [{ path: '.octipus/attachments/a/shot.png' }] }]);
  });

  test('a session the server has not seen yet is created first and its id returned', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      urls.push(`${init.method} ${url}`);
      if (url.endsWith('/api/sessions')) {
        expect(JSON.parse(String(init.body))).toMatchObject({ channelType: 'tui', title: 'Look' });
        return new Response(JSON.stringify({ id: 'created-session' }), { status: 200 });
      }
      if (url.includes('/fresh-session/')) return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 });
      return new Response(JSON.stringify({ uploaded: [{ path: 'p/shot.png', name: 'shot.png' }] }), { status: 200 });
    }));
    const { client } = stubClient();
    const result = await client.uploadAttachments('fresh-session', [image], 'Look');
    expect(result.sessionId).toBe('created-session');
    expect(urls).toEqual([
      'POST http://localhost:3007/api/sessions/fresh-session/attachments',
      'POST http://localhost:3007/api/sessions',
      'POST http://localhost:3007/api/sessions/created-session/attachments',
    ]);
  });

  test('a refused upload throws the server\'s reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Each attachment must contain data and be no larger than 10 MiB.' }), { status: 400 })));
    const { client } = stubClient();
    await expect(client.uploadAttachments('s', [image], 'x')).rejects.toThrow('no larger than 10 MiB');
  });
});

describe('GatewayClient — reconnecting after the server went away', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  test('a socket that dies with an error before it closes is reconnected', async () => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    const statuses: string[] = [];
    const client = new GatewayClient({ url: 'ws://gateway.test/gateway', onStatusChange: s => statuses.push(s), onError: () => {} });
    await client.connect();
    FakeSocket.latest().open();
    expect(client.getStatus()).toBe('connected');
    // What Node's WebSocket does when the connection is cut: `error`, then `close` 1006.
    FakeSocket.latest().onerror?.();
    FakeSocket.latest().drop();
    expect(statuses.slice(-2)).toEqual(['error', 'disconnected']);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.latest().open();
    expect(client.getStatus()).toBe('connected');
    client.disconnect();
  });
});
