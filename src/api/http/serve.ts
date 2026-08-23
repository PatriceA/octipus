/**
 * Binding the application to a port on Node.
 *
 * The websocket half is here rather than in the app because it is the one part
 * that is not a request/response: `ws` handles the upgrade on the same Node
 * server `@hono/node-server` created, and hands each socket an object shaped
 * the way the six `.ws()` handlers already expect — `data.request`, `send`,
 * `close`, `readyState`, `remoteAddress`.
 */
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket as NodeWebSocket } from 'ws';
import type { App, WebSocketHandlers } from './app';

export interface ListenOptions {
  hostname: string;
  port: number;
}

export interface RunningServer {
  port: number;
  stop: (force?: boolean) => void;
}

/** `/voice/media/:provider` against `/voice/media/twilio`. */
function matchPath(pattern: string, pathname: string): boolean {
  if (!pattern.includes(':')) return pattern === pathname;
  const p = pattern.split('/');
  const a = pathname.split('/');
  if (p.length !== a.length) return false;
  return p.every((seg, i) => seg.startsWith(':') || seg === a[i]);
}

export function listen(app: App, options: ListenOptions): RunningServer {
  const nodeServer = serve({
    fetch: app.fetch,
    hostname: options.hostname,
    port: options.port,
  }) as unknown as Server;

  const wsRoutes = app.websocketRoutes();
  const wss = new WebSocketServer({ noServer: true });

  nodeServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = wsRoutes.find((r) => matchPath(r.path, url.pathname));
    if (!route) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (raw) => {
      attach(raw, route.handlers, url, req.headers, req.socket.remoteAddress ?? '127.0.0.1');
    });
  });

  return {
    get port() {
      const addr = nodeServer.address();
      return typeof addr === 'object' && addr ? addr.port : options.port;
    },
    stop: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      nodeServer.close();
    },
  };
}

function attach(
  raw: NodeWebSocket,
  handlers: WebSocketHandlers,
  url: URL,
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string,
): void {
  const request = new Request(url, {
    headers: Object.entries(headers).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v] as [string, string]],
    ),
  });

  const ws = {
    data: { request } as Record<string, unknown> & { request: Request },
    remoteAddress,
    get readyState() { return raw.readyState; },
    send(payload: string | ArrayBufferView) {
      if (raw.readyState === raw.OPEN) raw.send(payload);
    },
    close(code?: number, reason?: string) {
      try { raw.close(code, reason); } catch { /* already closing */ }
    },
    raw,
  };

  // A handler that throws must not take the process with it — one bad socket
  // is one bad socket. (The same rule the gateway applies to subscribers.)
  const guard = (label: string, fn: () => unknown) => {
    try {
      const out = fn();
      if (out instanceof Promise) out.catch((err) => onSocketError(label, err, ws));
    } catch (err) {
      onSocketError(label, err, ws);
    }
  };

  raw.on('message', (payload, isBinary) => {
    // Every handler branches on `typeof message === 'string'` first, so text
    // frames arrive decoded and binary ones as the Buffer they already handle.
    const message = isBinary ? payload : payload.toString('utf8');
    guard('message', () => handlers.message?.(ws, message));
  });
  raw.on('close', (code, reason) => {
    guard('close', () => handlers.close?.(ws, code, reason?.toString('utf8')));
  });
  raw.on('error', (err) => onSocketError('error', err, ws));

  guard('open', () => handlers.open?.(ws));
}

function onSocketError(label: string, err: unknown, ws: { close: (c?: number) => void }): void {
  // Imported lazily so this module stays usable from a test that has not
  // configured logging.
  import('@/utils/logger')
    .then(({ apiLogger }) => apiLogger.warn({ err, phase: label }, 'WebSocket handler failed'))
    .catch(() => { /* logging is best effort here */ });
  if (label === 'open') ws.close(1011);
}
