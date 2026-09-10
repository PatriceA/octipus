import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from './server.js';

export interface HttpBridgeOptions {
  backendUrl: string;
  apiKey: string;
  allowedOrigins: string[];
}

/** Legacy HTTP+SSE bridge. Each connection owns its MCP protocol state. */
export function createHttpBridge(options: HttpBridgeOptions) {
  if (!options.apiKey.trim()) throw new Error('MCP_API_KEY is required for HTTP transport');
  const expectedKey = Buffer.from(options.apiKey);
  const origins = new Set(options.allowedOrigins.map(value => value.trim()).filter(Boolean));
  const sessions = new Map<string, { server: ReturnType<typeof createServer>; transport: SSEServerTransport }>();
  let stopping = false;

  function respond(res: ServerResponse, status: number, error: string) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (stopping) return respond(res, 503, 'Server shutting down');
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) return respond(res, 403, 'Origin not allowed');
    res.setHeader('Vary', 'Origin');
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    const url = new URL(req.url || '/', 'http://localhost');
    const method = url.pathname === '/messages' ? 'POST' : 'GET';
    if (!['/sse', '/messages', '/health'].includes(url.pathname)) return respond(res, 404, 'Not found');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== method) {
      res.setHeader('Allow', `${method}, OPTIONS`);
      return respond(res, 405, 'Method not allowed');
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'http' }));
      return;
    }

    const authorization = req.headers.authorization;
    const supplied = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
    if (supplied.length !== expectedKey.length || !timingSafeEqual(supplied, expectedKey)) {
      return respond(res, 401, 'Invalid or missing MCP API key');
    }

    if (url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) return respond(res, 400, 'Missing or unknown sessionId');
      // Let the SDK read and bound the body (4 MB), validate JSON-RPC, and
      // deliver the response over this session's SSE connection.
      await session.transport.handlePostMessage(req, res);
      return;
    }

    const server = createServer(options.backendUrl);
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, { server, transport });
    res.once('close', () => sessions.delete(transport.sessionId));
    // SDK Protocol.connect chains callbacks installed before connecting.
    transport.onerror = () => console.error('MCP HTTP session transport error');
    try {
      await server.connect(transport);
    } catch (error) {
      sessions.delete(transport.sessionId);
      await server.close();
      throw error;
    }
  }

  const httpServer = createHttpServer((req, res) => {
    void dispatch(req, res).catch(() => {
      // Do not log request bodies, keys, or SDK errors that may contain them.
      console.error('MCP HTTP request failed');
      if (!res.headersSent) respond(res, 500, 'MCP request failed');
      else if (!res.writableEnded) res.end();
    });
  });

  async function close(): Promise<void> {
    stopping = true;
    // Stop accepting clients before closing streams; otherwise a new stream
    // could enter after the session snapshot and keep shutdown alive.
    const closed = new Promise<void>((resolve, reject) => {
      httpServer.close(error => error ? reject(error) : resolve());
    });
    await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
    sessions.clear();
    httpServer.closeAllConnections();
    await closed;
  }

  return { httpServer, close, get activeSessionCount() { return sessions.size; } };
}
