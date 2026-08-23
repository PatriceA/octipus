/**
 * The HTTP application, shaped the way the routes already expect and backed by
 * Hono on Node.
 *
 * Ninety-five route modules, thirty-two route tests and three middleware
 * plugins are written against a small, entirely regular slice of Elysia's
 * surface: a prefixed instance, the verb methods, `.use`, `.group`, `.derive`,
 * four lifecycle hooks, `.ws`, and a context carrying `body`/`params`/`query`/
 * `request`/`set`. This module implements that slice over Hono so the runtime
 * changes without the routes changing with it.
 *
 * Hooks carry the path prefix they were mounted under. A hook registered on
 * the root applies everywhere; one registered inside a prefixed instance
 * applies only to that prefix. That is not decoration — the OpenAI-compatible
 * surface registers its own `onError` to shape failures into the SDK's error
 * envelope, and hoisting every hook to the root made it unreachable behind the
 * root handler, so an invalid body answered `422 {"error":"…"}` instead of the
 * envelope an OpenAI client knows how to read.
 *
 * Error hooks run most-specific-first for the same reason. Everything else
 * runs in registration order, broad to narrow, as it did.
 */
import { Hono } from 'hono';
import type { TSchema } from './t';
import { checkValue, ValidationError } from './validate';

export type Ctx = Record<string, any> & {
  request: Request;
  set: { status?: number; headers: Record<string, string> };
  body: any;
  params: Record<string, string>;
  /**
   * Loosely typed because a `query` schema coerces: `t.Number()` on a query
   * field yields a number here, not the string the URL carried.
   */
  query: Record<string, any>;
  headers: Record<string, string | undefined>;
  /**
   * Auth fields. Not optional, because the root application's first `derive`
   * sets all three on every request — including the anonymous case, where they
   * are `null`, `null` and the anonymous principal. Typed loosely so a route
   * may keep its own narrower context type.
   */
  user: any;
  session: any;
  principal: any;
};

/**
 * Method syntax on purpose: it makes the context parameter bivariant, so a
 * route that annotates its own narrower context (`AdminCtx`, `RouteCtx`) still
 * type-checks, while a route that annotates nothing still gets `Ctx` inferred.
 */
export type Handler = {
  handler(ctx: Ctx): unknown | Promise<unknown>;
}['handler'];

export interface RouteOptions {
  body?: TSchema;
  params?: TSchema;
  query?: TSchema;
  /** Swagger metadata in the original; carried so route files stay untouched. */
  detail?: unknown;
  /** `'text'` keeps the body a string for a route that parses it itself. */
  type?: string;
  /** A route-local body parser, used by the telephony webhooks. */
  parse?: (ctx: Ctx) => unknown | Promise<unknown>;
}

interface RouteDef {
  method: string;
  path: string;
  handler: Handler;
  options?: RouteOptions;
}

export interface WebSocketHandlers {
  open?: (ws: any) => unknown | Promise<unknown>;
  message?: (ws: any, message: any) => unknown | Promise<unknown>;
  close?: (ws: any, code?: number, reason?: string) => unknown | Promise<unknown>;
  drain?: (ws: any) => unknown;
  error?: (ws: any, error: unknown) => unknown;
}

interface WsDef {
  path: string;
  handlers: WebSocketHandlers;
}

type ErrorHook = (arg: { error: unknown; code: string; set: Ctx['set']; request?: Request }) => unknown;

/**
 * A hook plus every path prefix it was mounted under (`''` = everywhere).
 *
 * A list, not one prefix: a shared plugin can be mounted by several route
 * modules at unrelated paths, and it has to run under all of them.
 */
interface Scoped<T> {
  fn: T;
  prefixes: string[];
}

interface Hooks {
  request: Scoped<Handler>[];
  derive: Scoped<Handler>[];
  before: Scoped<Handler>[];
  after: Scoped<Handler>[];
  error: Scoped<ErrorHook>[];
}

/** Does a request path fall under any of a hook's mount prefixes? */
function inScope(prefixes: string[], pathname: string): boolean {
  return prefixes.some(
    (p) => p === '' || p === '/' || pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** The narrowest prefix a hook is mounted under, for error-hook ordering. */
function specificity(prefixes: string[]): number {
  return Math.max(...prefixes.map((p) => p.length));
}

/**
 * Merge a child's hooks into a parent under `prefix`.
 *
 * The same function registered twice is kept once, at the broader prefix. That
 * is what the previous framework's plugin `name` deduplication bought: the
 * shared API-context plugin is `.use()`d by fifty-five route modules, and
 * without this its `derive` would run fifty-five times per request.
 */
function mergeScoped<T>(into: Scoped<T>[], from: Scoped<T>[], prefix: string): void {
  for (const hook of from) {
    const mounted = hook.prefixes.map((p) => joinScope(prefix, p));
    const existing = into.find((h) => h.fn === hook.fn);
    if (existing) {
      for (const p of mounted) if (!existing.prefixes.includes(p)) existing.prefixes.push(p);
      continue;
    }
    into.push({ fn: hook.fn, prefixes: [...mounted] });
  }
}

function joinScope(outer: string, inner: string): string {
  if (!inner || inner === '/') return outer;
  return joinPath(outer, inner);
}

/** `/a` + `/b` → `/a/b`; a lone `/` collapses onto the prefix. */
function joinPath(prefix: string, path: string): string {
  const p = `${prefix}${path}`.replace(/\/{2,}/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p || '/';
}

export class App {
  readonly prefix: string;
  readonly name?: string;
  private routes: RouteDef[] = [];
  private wsRoutes: WsDef[] = [];
  private hooks: Hooks = { request: [], derive: [], before: [], after: [], error: [] };
  private compiled?: Hono<{ Variables: { octiCtx: Ctx } }>;
  /** Set by `listen()`; the routes and tests read `.port` off it. */
  server: { port: number; stop: (force?: boolean) => void } | null = null;

  constructor(options: { prefix?: string; name?: string } = {}) {
    this.prefix = options.prefix ?? '';
    this.name = options.name;
  }

  private add(method: string, path: string, handler: Handler, options?: RouteOptions): this {
    this.routes.push({ method, path: joinPath(this.prefix, path), handler, options });
    this.compiled = undefined;
    return this;
  }

  get(path: string, handler: Handler, options?: RouteOptions) { return this.add('GET', path, handler, options); }
  post(path: string, handler: Handler, options?: RouteOptions) { return this.add('POST', path, handler, options); }
  put(path: string, handler: Handler, options?: RouteOptions) { return this.add('PUT', path, handler, options); }
  patch(path: string, handler: Handler, options?: RouteOptions) { return this.add('PATCH', path, handler, options); }
  delete(path: string, handler: Handler, options?: RouteOptions) { return this.add('DELETE', path, handler, options); }
  all(path: string, handler: Handler, options?: RouteOptions) { return this.add('ALL', path, handler, options); }

  ws(path: string, handlers: WebSocketHandlers): this {
    this.wsRoutes.push({ path: joinPath(this.prefix, path), handlers });
    return this;
  }

  onRequest(fn: Handler): this { this.hooks.request.push({ fn, prefixes: [this.prefix] }); return this; }
  /** `(opts, fn)` and `(fn)` are both in use; the scope option is a no-op here. */
  derive(a: Handler | Record<string, unknown>, b?: Handler): this {
    this.hooks.derive.push({ fn: (typeof a === 'function' ? a : b) as Handler, prefixes: [this.prefix] });
    return this;
  }

  resolve(a: Handler | Record<string, unknown>, b?: Handler): this { return this.derive(a, b); }
  onError(fn: ErrorHook): this { this.hooks.error.push({ fn, prefixes: [this.prefix] }); return this; }

  /** `(opts, fn)` and `(fn)` are both in use; the scope option is a no-op here. */
  onBeforeHandle(a: Handler | Record<string, unknown>, b?: Handler): this {
    this.hooks.before.push({ fn: (typeof a === 'function' ? a : b) as Handler, prefixes: [this.prefix] });
    return this;
  }

  onAfterHandle(a: Handler | Record<string, unknown>, b?: Handler): this {
    this.hooks.after.push({ fn: (typeof a === 'function' ? a : b) as Handler, prefixes: [this.prefix] });
    return this;
  }

  /** Mount another application's routes, sockets and hooks under this prefix. */
  use(other: App): this {
    for (const r of other.routes) this.routes.push({ ...r, path: joinPath(this.prefix, r.path) });
    for (const w of other.wsRoutes) this.wsRoutes.push({ ...w, path: joinPath(this.prefix, w.path) });
    for (const k of ['request', 'derive', 'before', 'after', 'error'] as const) {
      mergeScoped(this.hooks[k] as Scoped<unknown>[], other.hooks[k] as Scoped<unknown>[], this.prefix);
    }
    this.compiled = undefined;
    return this;
  }

  /** `group(prefix, fn)` mutates the receiver, as the original did. */
  group(prefix: string, fn: (app: App) => App): this {
    const sub = fn(new App({ prefix: joinPath(this.prefix, prefix) }));
    for (const r of sub.routes) this.routes.push(r);
    for (const w of sub.wsRoutes) this.wsRoutes.push(w);
    for (const k of ['request', 'derive', 'before', 'after', 'error'] as const) {
      mergeScoped(this.hooks[k] as Scoped<unknown>[], sub.hooks[k] as Scoped<unknown>[], '');
    }
    this.compiled = undefined;
    return this;
  }

  /** The websocket routes, for the upgrade handler in `listen()`. */
  websocketRoutes(): readonly WsDef[] { return this.wsRoutes; }

  /** Every mounted route, for the catalog generator and for tests. */
  routeTable(): readonly { method: string; path: string }[] {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  private async runError(error: unknown, code: string, set: Ctx['set'], request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    // Most specific first: a surface that shapes its own errors must win over
    // the application-wide handler, which answers every code.
    const applicable = this.hooks.error
      .filter((h) => inScope(h.prefixes, pathname))
      .sort((a, b) => specificity(b.prefixes) - specificity(a.prefixes));
    for (const hook of applicable) {
      const out = await hook.fn({ error, code, set, request });
      if (out !== undefined) return toResponse(out, set, code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' ? 422 : 500);
    }
    const status = code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' ? 422 : 500;
    return toResponse({ error: code === 'NOT_FOUND' ? 'Not found' : 'Internal server error' }, set, status);
  }

  private build(): Hono<{ Variables: { octiCtx: Ctx } }> {
    if (this.compiled) return this.compiled;
    const hono = new Hono<{ Variables: { octiCtx: Ctx } }>({ strict: false });

    // The pipeline middleware is registered first on purpose: Hono runs
    // handlers in registration order, so a route added before it would run
    // without a context.
    hono.use('*', async (c, next) => {
      const request = c.req.raw;
      const set: Ctx['set'] = { status: undefined, headers: {} };
      const url = new URL(request.url);
      const ctx: Ctx = {
        request,
        set,
        body: undefined,
        user: null,
        session: null,
        principal: null,
        params: {},
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(request.headers),
      };
      c.set('octiCtx', ctx);

      const applies = (h: { prefixes: string[] }) => inScope(h.prefixes, url.pathname);

      try {
        for (const hook of this.hooks.request.filter(applies)) await hook.fn(ctx);
        ctx.body = await parseBody(request);
        for (const hook of this.hooks.derive.filter(applies)) Object.assign(ctx, (await hook.fn(ctx)) ?? {});
        for (const hook of this.hooks.before.filter(applies)) {
          const short = await hook.fn(ctx);
          if (short !== undefined) {
            const res = toResponse(short, set, 200);
            await this.runAfter(ctx);
            return applyHeaders(res, set);
          }
        }
        await next();
        let res = c.res;
        if (!res || res.status === 404) {
          // Hono's own miss; route it through the error hooks so a 404 keeps
          // the shape (and the debug-level log) the API has always returned.
          const missed = !c.finalized || res?.status === 404;
          if (missed && !this.routeMatches(c)) {
            res = await this.runError(new Error('Not Found'), 'NOT_FOUND', set, request);
          }
        }
        await this.runAfter(ctx);
        // Assigned rather than returned: once `next()` has run, Hono keeps
        // `c.res` and a returned Response is dropped.
        c.res = applyHeaders(res ?? new Response(null, { status: 404 }), set);
      } catch (err) {
        const code = err instanceof ValidationError ? 'VALIDATION' : 'UNKNOWN';
        const res = await this.runError(err, code, set, request);
        await this.runAfter(ctx);
        c.res = applyHeaders(res, set);
      }
    });

    // Static segments win over parameters regardless of registration order,
    // which is what the previous router did: `/sessions/active` must not be
    // swallowed by `/sessions/:id` just because `:id` was declared first.
    const ordered = [...this.routes]
      .map((route, index) => ({ route, index, dynamic: (route.path.match(/[:*]/g) ?? []).length }))
      .sort((a, b) => a.dynamic - b.dynamic || a.index - b.index)
      .map((entry) => entry.route);

    for (const route of ordered) {
      const register = route.method === 'ALL'
        ? hono.all.bind(hono)
        : (hono as any)[route.method.toLowerCase()].bind(hono);
      register(route.path, async (c: any) => {
        const ctx = c.get('octiCtx') as Ctx;
        ctx.params = c.req.param() ?? {};
        try {
          // `type: 'text'` means the route parses the body itself, so undo the
          // global parse rather than handing it an object it did not ask for.
          if (route.options?.type === 'text' && ctx.body !== undefined && typeof ctx.body !== 'string') {
            ctx.body = await ctx.request.clone().text();
          }
          if (route.options?.parse) ctx.body = await route.options.parse(ctx);
          validateRoute(route.options, ctx);
          const out = await route.handler(ctx);
          return toResponse(out, ctx.set, 200);
        } catch (err) {
          // Caught here rather than around `next()`: Hono answers a throwing
          // handler with its own 500 instead of re-throwing, so the
          // application's error hooks would never see it.
          const code = err instanceof ValidationError ? 'VALIDATION' : 'UNKNOWN';
          return await this.runError(err, code, ctx.set, ctx.request);
        }
      });
    }

    this.compiled = hono;
    return hono;
  }

  private routeMatches(c: any): boolean {
    return c.req.routePath !== undefined && c.req.routePath !== '/*';
  }

  private async runAfter(ctx: Ctx): Promise<void> {
    const pathname = new URL(ctx.request.url).pathname;
    for (const hook of this.hooks.after) {
      if (!inScope(hook.prefixes, pathname)) continue;
      try { await hook.fn(ctx); } catch { /* an after-hook must never fail a request */ }
    }
  }

  /** The entry point every route test uses. */
  handle(request: Request): Promise<Response> {
    return Promise.resolve(this.build().fetch(request));
  }

  /** Hono's own name for the same thing, for `@hono/node-server`. */
  get fetch() {
    return (request: Request): Promise<Response> =>
      Promise.resolve(this.build().fetch(request));
  }
}

function validateRoute(options: RouteOptions | undefined, ctx: Ctx): void {
  if (!options) return;
  if (options.params) ctx.params = checkValue(options.params, ctx.params, 'params');
  if (options.query) ctx.query = checkValue(options.query, ctx.query, 'query');
  if (options.body) ctx.body = checkValue(options.body, ctx.body, 'body');
}

async function parseBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const type = request.headers.get('content-type') ?? '';
  // Clone first: four routes (SCIM, the WhatsApp and two voice webhooks) read
  // the raw body themselves to verify a signature over the exact bytes.
  const source = request.clone();
  try {
    if (type.includes('multipart/form-data')) {
      const form = await source.formData();
      const out: Record<string, unknown> = {};
      for (const [k, v] of form.entries()) {
        if (k in out) out[k] = ([] as unknown[]).concat(out[k] as unknown, v);
        else out[k] = v;
      }
      return out;
    }
    const text = await source.text();
    if (text === '') return undefined;
    if (type.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text));
    }
    if (type.includes('json') || text.startsWith('{') || text.startsWith('[')) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return text;
  } catch {
    return undefined;
  }
}

function applyHeaders(res: Response, set: Ctx['set']): Response {
  const keys = Object.keys(set.headers);
  if (keys.length === 0) return res;
  const out = new Response(res.body, res);
  for (const k of keys) out.headers.set(k, set.headers[k]);
  return out;
}

export function toResponse(value: unknown, set: Ctx['set'], fallbackStatus: number): Response {
  const status = set.status ?? fallbackStatus;
  if (value instanceof Response) {
    if (set.status !== undefined && value.status !== set.status) {
      return new Response(value.body, { status, headers: value.headers });
    }
    return value;
  }
  if (value === undefined || value === null) return new Response(null, { status: set.status ?? 204 });
  if (typeof value === 'string') {
    return new Response(value, { status, headers: { 'content-type': 'text/plain;charset=utf-8' } });
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Blob || value instanceof ReadableStream) {
    return new Response(value as BodyInit, { status });
  }
  if (isAsyncIterable(value)) {
    // An async generator is a server-sent event stream: that is the only thing
    // this application returns one for (`/v1/chat/completions` with
    // `stream: true`), and the frames it yields are already SSE-framed.
    const encoder = new TextEncoder();
    const iterator = value[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value: frame, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(typeof frame === 'string' ? frame : JSON.stringify(frame)));
      },
    });
    return new Response(body, {
      status,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
  });
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof (value as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === 'function';
}

/** The name the route modules import. */
export { App as Elysia };
