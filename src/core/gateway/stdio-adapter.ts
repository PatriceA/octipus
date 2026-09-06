/**
 * The gateway over stdin/stdout — the same typed protocol as the WebSocket
 * endpoint, framed as strict-LF JSON lines, so an IDE, a CI job or any
 * parent process can embed Octipus as a subprocess without a WS server.
 *
 * One line in is one client message (`auth` first, as on the socket); one
 * line out is one gateway message. The hub sees an ordinary connection: the
 * adapter is a `ServerWebSocket` whose `send` writes a line and whose
 * `close` tears the connection down, and stdin's end is the socket's close.
 * Everything the connection manager enforces — the auth deadline, rate
 * limits, per-user budgets, the event-visibility rule — applies unchanged.
 *
 * Log output must not share the pipe: `--stdio` mode sends logs to stderr
 * (see `utils/logger`). Lines are processed strictly in order, one at a
 * time, so a `chat.send` never overtakes the `auth` before it.
 */
import { createInterface } from 'node:readline';
import type { GatewayHub } from './hub';
import type { GatewayMessage } from './protocol';

export interface StdioAdapterOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** What the connection manager sees as the peer; loopback by default so `local` auth works. */
  ip?: string;
  /** Called once, after the connection is gone (stdin ended, or the hub closed it). */
  onClose?: (reason: string) => void;
}

export interface StdioAdapter {
  connectionId: string;
  /** Close the connection from this side (the hub is told; the input is no longer read). */
  close(reason?: string): void;
  /** Resolves when every line read so far has been handled. Test seam. */
  idle(): Promise<void>;
}

const WS_OPEN = 1;
const WS_CLOSED = 3;

export function attachStdioAdapter(hub: GatewayHub, opts: StdioAdapterOptions): StdioAdapter | null {
  const ip = opts.ip ?? '127.0.0.1';
  let closed = false;
  let connectionId = '';

  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    ws.readyState = WS_CLOSED;
    rl.close();
    // Idempotent on the manager's side: a connection it already dropped is a no-op.
    hub.connectionManager.handleClose(connectionId, 1000, reason);
    opts.onClose?.(reason);
  };

  const ws = {
    data: {} as Record<string, unknown>,
    readyState: WS_OPEN,
    send(payload: string | ArrayBufferView) {
      if (closed) return;
      const text = typeof payload === 'string' ? payload : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf-8');
      // JSON.stringify never emits a raw newline, so one line is one message.
      opts.output.write(`${text}\n`);
    },
    close(_code?: number, reason?: string) {
      finish(reason || 'closed by gateway');
    },
  };

  const rl = createInterface({ input: opts.input, crlfDelay: Number.POSITIVE_INFINITY, terminal: false });

  const id = hub.connectionManager.handleOpen(ws, ip);
  if (!id) {
    rl.close();
    return null;
  }
  connectionId = id;

  // Lines are handled one after another: the manager's `handleMessage` is
  // async (auth validates against the session store), and two lines racing
  // would let a message pass before its auth had settled.
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw || closed) return;
    chain = chain.then(() => hub.connectionManager.handleMessage(connectionId, raw)).catch(() => {
      // The manager reports protocol errors to the client itself; a throw
      // here is a bug in a handler, and the next line must still be read.
    });
  });
  rl.on('close', () => {
    chain.then(() => finish('stdin closed'));
  });

  return {
    connectionId,
    close: (reason) => finish(reason ?? 'closed by adapter'),
    idle: () => chain,
  };
}

/** Whether this process was asked to serve the gateway over its own stdio. */
export function stdioModeRequested(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--stdio') || env.GATEWAY_STDIO === '1';
}

/** Re-exported so an embedding client can type what it reads back. */
export type { GatewayMessage };
