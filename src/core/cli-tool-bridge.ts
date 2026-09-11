import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { ToolHandler } from './agent-base';

const callSchema = z.object({ name: z.string().min(1), arguments: z.record(z.string(), z.unknown()).default({}) }).strict();
export interface BridgeResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/** A run-local capability, never an API/admin credential. No caller-supplied identity. */
export async function startCliToolBridge(options: {
  tools: () => ToolHandler[];
  execute: (name: string, args: Record<string, unknown>) => Promise<BridgeResult>;
  active: () => boolean;
  /** Read-only tools that bypass the per-worker queue (safe to answer while a delegation blocks it). */
  unqueued?: ReadonlySet<string>;
}): Promise<{ url: string; key: string; close: () => Promise<void> }> {
  const key = randomBytes(32).toString('hex');
  let closed = false;
  let closing: Promise<void> | undefined;
  // Serialize calls to the worker's executor; separate agents have separate queues.
  let queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${key}`);
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      reply(401, { error: 'Invalid agent capability' }); return;
    }
    if (closed || !options.active()) { reply(410, { error: 'Agent run is no longer active' }); return; }
      if (req.method === 'GET' && req.url === '/tools') {
        reply(200, { tools: options.tools().map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/call') { reply(404, { error: 'Not found' }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { reply(413, { error: 'Tool arguments exceed 1 MiB' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input = callSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const run = async () => {
        if (closed || !options.active()) throw new Error('Agent run is no longer active');
        // Exact membership check before ToolExecutor's fuzzy name recovery.
        if (!options.tools().some(t => t.name === input.name)) throw new Error('Tool is not available to this agent');
        return options.execute(input.name, input.arguments);
      };
      // ponytail: one queue per worker; unqueued read-only tools keep context reads
      // responsive while an awaited delegation holds the queue. Parallel executor
      // calls if ToolExecutor's counters/final-flag are ever made concurrency-safe.
      let operation: Promise<BridgeResult>;
      if (options.unqueued?.has(input.name)) operation = run();
      else { operation = queue.then(run); queue = operation.then(() => undefined, () => undefined); }
      reply(200, await operation);
    } catch (err) {
      reply(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Agent bridge has no TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`, key,
    close: () => {
      if (!closing) {
        closed = true;
        server.closeAllConnections();
        closing = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      }
      return closing;
    },
  };
}
