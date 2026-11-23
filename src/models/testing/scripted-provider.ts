/**
 * A scripted model provider on a real local HTTP socket.
 *
 * The provider boundary is HTTP: the OpenAI SDK, `fetch`-based providers and
 * the LiteLLM proxy client all speak to an endpoint. Mocking the SDK or
 * `fetch` per test proves what a test told the mock, not what went over the
 * wire. This double listens on 127.0.0.1 (port 0, so suites never collide),
 * records every request it receives, and answers from a script: JSON bodies,
 * SSE streams, error statuses with headers (Retry-After), malformed bodies,
 * connection resets and requests that never answer.
 *
 * Used by the provider-boundary unit suites and by the production acceptance
 * lane (scripts/e2e/acceptance.ts), which scripts it with a handler. It is
 * test-only and imported by nothing that ships.
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface WireMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  [key: string]: unknown;
}

/** The fields of a request body the suites read; anything else is reachable by key. */
export interface WireBody {
  model?: string;
  messages?: WireMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  input?: unknown;
  [key: string]: unknown;
}

export interface RecordedRequest {
  method: string;
  /** Path without the query string, e.g. `/chat/completions`. */
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  rawBody: string;
  /** The body parsed as JSON, or undefined when it is not a JSON object. */
  body: WireBody | undefined;
  /** When the double received it (`Date.now()`, so fake timers apply). */
  receivedAt: number;
  /** True once the connection closed before the reply was finished: the client aborted or timed out, or the script reset it. */
  clientClosed: boolean;
  /** Resolves when the connection closes before the reply was finished. */
  closed: Promise<void>;
}

export type ScriptedReply =
  | { kind: 'json'; status: number; body: unknown; headers: Record<string, string> }
  | { kind: 'text'; status: number; body: string; headers: Record<string, string> }
  | { kind: 'sse'; status: number; events: unknown[]; headers: Record<string, string>; done: boolean; then: 'end' | 'reset' | 'hold' }
  | { kind: 'reset' }
  | { kind: 'hang' };

export type ScriptedHandler = (req: RecordedRequest) => ScriptedReply | Promise<ScriptedReply>;

interface ReplyOptions {
  status?: number;
  headers?: Record<string, string>;
}

/** A JSON answer. */
export function json(body: unknown, opts: ReplyOptions = {}): ScriptedReply {
  return { kind: 'json', status: opts.status ?? 200, body, headers: opts.headers ?? {} };
}

/** A raw body, for malformed answers (`text('{"choices": [', { contentType: 'application/json' })`). */
export function text(body: string, opts: ReplyOptions & { contentType?: string } = {}): ScriptedReply {
  return { kind: 'text', status: opts.status ?? 200, body, headers: { 'content-type': opts.contentType ?? 'text/plain', ...opts.headers } };
}

/**
 * An SSE stream: each event is sent as one `data:` line (objects JSON-encoded,
 * strings as given), then `data: [DONE]` unless `done: false`. `then: 'reset'`
 * destroys the socket after the events (a mid-stream failure); `then: 'hold'`
 * leaves the stream open until the client goes away (an abort).
 */
export function sse(events: unknown[], opts: ReplyOptions & { done?: boolean; then?: 'end' | 'reset' | 'hold' } = {}): ScriptedReply {
  const then = opts.then ?? 'end';
  return { kind: 'sse', status: opts.status ?? 200, events, headers: opts.headers ?? {}, done: opts.done ?? then === 'end', then };
}

/** Destroy the connection without answering (a network reset). */
export function reset(): ScriptedReply {
  return { kind: 'reset' };
}

/** Never answer (a timeout, or a request the caller aborts). */
export function hang(): ScriptedReply {
  return { kind: 'hang' };
}

// ── OpenAI-compatible wire builders ─────────────────────────────────

export interface WireToolCall { id: string; name: string; arguments: string }
export interface WireUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number; [k: string]: unknown }

/** A `chat.completion` body. `message` adds fields to the assistant message (e.g. `reasoning_content`). */
export function chatCompletion(opts: {
  content?: string | null;
  toolCalls?: WireToolCall[];
  finishReason?: string;
  usage?: WireUsage;
  model?: string;
  id?: string;
  message?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    id: opts.id ?? 'chatcmpl-scripted',
    object: 'chat.completion',
    created: 1,
    model: opts.model ?? 'scripted-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: opts.content ?? null,
        ...(opts.toolCalls ? { tool_calls: opts.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })) } : {}),
        ...opts.message,
      },
      finish_reason: opts.finishReason ?? (opts.toolCalls?.length ? 'tool_calls' : 'stop'),
    }],
    usage: opts.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** One `chat.completion.chunk`. `toolCalls` are deltas: `{ index, id?, name?, arguments? }`. */
export function chatChunk(opts: {
  content?: string;
  toolCalls?: Array<{ index: number; id?: string; name?: string; arguments?: string }>;
  finishReason?: string | null;
  usage?: WireUsage;
  model?: string;
  id?: string;
  noChoices?: boolean;
} = {}): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (opts.content !== undefined) delta.content = opts.content;
  if (opts.toolCalls) {
    delta.tool_calls = opts.toolCalls.map(tc => ({
      index: tc.index,
      ...(tc.id ? { id: tc.id, type: 'function' } : {}),
      function: { ...(tc.name ? { name: tc.name } : {}), ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}) },
    }));
  }
  return {
    id: opts.id ?? 'chatcmpl-scripted',
    object: 'chat.completion.chunk',
    created: 1,
    model: opts.model ?? 'scripted-model',
    choices: opts.noChoices ? [] : [{ index: 0, delta, finish_reason: opts.finishReason ?? null }],
    ...(opts.usage ? { usage: opts.usage } : {}),
  };
}

/** An `/embeddings` body; `index` is each vector's position unless `order` reorders the list. */
export function embeddings(vectors: number[][], opts: { model?: string; order?: number[]; usage?: { prompt_tokens: number; total_tokens: number } } = {}): Record<string, unknown> {
  const order = opts.order ?? vectors.map((_, i) => i);
  return {
    object: 'list',
    model: opts.model ?? 'scripted-embed',
    data: order.map(i => ({ object: 'embedding', index: i, embedding: vectors[i] })),
    usage: opts.usage ?? { prompt_tokens: vectors.length, total_tokens: vectors.length },
  };
}

/** An OpenAI-style error answer: `{ error: { message, type, code } }` with that status. */
export function openAIError(status: number, message: string, opts: { type?: string; code?: string | null; headers?: Record<string, string> } = {}): ScriptedReply {
  return json({ error: { message, type: opts.type ?? 'invalid_request_error', code: opts.code ?? null, param: null } }, { status, headers: opts.headers });
}

// ── Server ──────────────────────────────────────────────────────────

export interface ScriptedProvider {
  /** `http://127.0.0.1:<port>` — no trailing slash, no path. */
  readonly url: string;
  /** Every request received, in arrival order. */
  readonly requests: RecordedRequest[];
  /** Queue replies, consumed one per request in arrival order. */
  enqueue(...replies: ScriptedReply[]): void;
  /** Answer requests the queue does not cover. Without one, they get a loud 500. */
  respondWith(handler: ScriptedHandler): void;
  /** Resolves once `count` requests have arrived in total. */
  waitForRequests(count: number): Promise<void>;
  /** Forget recorded requests, queued replies and the handler. */
  reset(): void;
  close(): Promise<void>;
}

export async function startScriptedProvider(): Promise<ScriptedProvider> {
  const requests: RecordedRequest[] = [];
  const queue: ScriptedReply[] = [];
  let handler: ScriptedHandler | undefined;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const sockets = new Set<Socket>();

  const server = createServer(async (req, res) => {
    let rawBody = '';
    for await (const part of req) rawBody += part;
    const url = new URL(req.url ?? '/', 'http://scripted.local');
    let body: WireBody | undefined;
    try {
      const parsed: unknown = rawBody ? JSON.parse(rawBody) : undefined;
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as WireBody : undefined;
    } catch {
      body = undefined;
    }
    let markClosed: () => void = () => {};
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      rawBody,
      body,
      receivedAt: Date.now(),
      clientClosed: false,
      closed: new Promise<void>(resolve => { markClosed = resolve; }),
    };
    res.on('close', () => {
      if (res.writableFinished) return;
      recorded.clientClosed = true;
      markClosed();
    });
    requests.push(recorded);
    for (const w of waiters.filter(w => requests.length >= w.count)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }

    send(res, await replyFor(recorded));
  });
  const replyFor = async (recorded: RecordedRequest): Promise<ScriptedReply> => {
    const queued = queue.shift();
    if (queued) return queued;
    if (!handler) return json({ error: { message: `scripted provider: no reply scripted for ${recorded.method} ${recorded.path}` } }, { status: 500 });
    try {
      return await handler(recorded);
    } catch (err) {
      return json({ error: { message: `scripted provider: handler failed: ${(err as Error).message}` } }, { status: 500 });
    }
  };
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('scripted provider: no TCP address');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    enqueue: (...replies) => { queue.push(...replies); },
    respondWith: (h) => { handler = h; },
    waitForRequests: (count) => requests.length >= count
      ? Promise.resolve()
      : new Promise<void>(resolve => { waiters.push({ count, resolve }); }),
    reset: () => { requests.length = 0; queue.length = 0; handler = undefined; },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function send(res: ServerResponse, reply: ScriptedReply): void {
  switch (reply.kind) {
    case 'json':
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body));
      return;
    case 'text':
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
      return;
    case 'reset':
      res.socket?.destroy();
      return;
    case 'hang':
      return;
    case 'sse': {
      res.writeHead(reply.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...reply.headers });
      const frames = reply.events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
      if (reply.done) frames.push('data: [DONE]\n\n');
      const payload = frames.join('');
      if (reply.then === 'end') { res.end(payload); return; }
      if (reply.then === 'hold') { res.write(payload); return; }
      res.write(payload, () => res.socket?.destroy());
      return;
    }
  }
}
