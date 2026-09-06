import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test } from 'vitest';
import { GatewayHub } from './hub';
import { attachStdioAdapter, stdioModeRequested } from './stdio-adapter';

process.env.LOG_LEVEL ??= 'error';

function lines(output: PassThrough): () => Record<string, unknown>[] {
  let buffered = '';
  output.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString();
  });
  return () => buffered.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const AUTH = JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token: 'good' }, clientType: 'acp' });

function makeHub(): GatewayHub {
  const hub = new GatewayHub();
  hub.setSessionValidator(async (token) => (token === 'good' ? { userId: 'u1', username: 'u', isAdmin: false } : null));
  return hub;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('stdio gateway adapter', () => {
  test('auth, ping and events flow as JSON lines; stdin end closes the connection', async () => {
    const hub = makeHub();
    const input = new PassThrough();
    const output = new PassThrough();
    const read = lines(output);
    const closes: string[] = [];
    const adapter = attachStdioAdapter(hub, { input, output, onClose: (r) => closes.push(r) })!;
    cleanups.push(() => adapter.close());
    expect(adapter).not.toBeNull();
    expect(hub.getStatus().connections.total).toBe(1);

    input.write(`${AUTH}\r\n`);
    input.write(`${JSON.stringify({ type: 'ping' })}\n`);
    await adapter.idle();
    await settle();
    const [authOk, pong] = read();
    expect(authOk).toMatchObject({ type: 'auth_ok', userId: 'u1' });
    expect(pong).toMatchObject({ type: 'pong' });

    // Events for this user reach the pipe; another user's do not.
    hub.publishEvent({ type: 'agent.spawned', source: 'test', userId: 'u1', payload: { agentId: 'a1' } });
    hub.publishEvent({ type: 'agent.spawned', source: 'test', userId: 'u2', payload: { agentId: 'a2' } });
    await settle();
    const events = read().filter((m) => m.type === 'event');
    expect(events).toHaveLength(1);
    expect((events[0].event as { payload: { agentId: string } }).payload.agentId).toBe('a1');
    // Strict LF framing: no carriage returns on the way out.
    expect(output.readableEnded).toBe(false);

    input.end();
    await settle();
    expect(closes).toEqual(['stdin closed']);
    expect(hub.getStatus().connections.total).toBe(0);
  });

  test('a message before auth is refused and lines stay in order', async () => {
    const hub = makeHub();
    const input = new PassThrough();
    const output = new PassThrough();
    const read = lines(output);
    const adapter = attachStdioAdapter(hub, { input, output })!;
    cleanups.push(() => adapter.close());

    input.write(`${JSON.stringify({ type: 'ping' })}\n${AUTH}\n${JSON.stringify({ type: 'ping' })}\n`);
    await adapter.idle();
    await settle();
    expect(read().map((m) => m.type)).toEqual(['error', 'auth_ok', 'pong']);
    expect(read()[0]).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  test('a failed auth closes the connection from the hub side, and the adapter reports it once', async () => {
    const hub = makeHub();
    const input = new PassThrough();
    const output = new PassThrough();
    const read = lines(output);
    const closes: string[] = [];
    const adapter = attachStdioAdapter(hub, { input, output, onClose: (r) => closes.push(r) })!;
    cleanups.push(() => adapter.close());

    input.write(`${JSON.stringify({ type: 'auth', method: 'session_token', credentials: { token: 'bad' }, clientType: 'acp' })}\n`);
    await adapter.idle();
    await settle();
    expect(read()[0]).toMatchObject({ type: 'auth_error' });
    expect(closes).toEqual(['Invalid or expired session']);
    expect(hub.getStatus().connections.total).toBe(0);
    // Nothing more is written after close, and ending stdin does not report a second close.
    input.end();
    await settle();
    expect(closes).toHaveLength(1);
  });

  test('stdioModeRequested reads the flag or the env', () => {
    expect(stdioModeRequested(['node', 'index.js', '--stdio'], {})).toBe(true);
    expect(stdioModeRequested(['node', 'index.js'], { GATEWAY_STDIO: '1' })).toBe(true);
    expect(stdioModeRequested(['node', 'index.js'], {})).toBe(false);
  });
});
