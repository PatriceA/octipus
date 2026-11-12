/**
 * `Idempotency-Key` support for routes that create work (POST /api/chat,
 * /api/agents, /api/pipelines, /api/hooks, /api/sessions and
 * /api/tools/:id/tools/:name/execute). See src/core/idempotency.ts.
 *
 * Wrap a route handler with {@link idempotent}. Without the header the
 * handler runs as before. With it, per (user, scope, key):
 *
 *  - the first request runs; a success (status < 400, no `error` field) is
 *    stored for 24 h, a failure releases the key;
 *  - a retry after it finished gets the stored status and body, with the
 *    `Idempotent-Replayed: true` header;
 *  - a retry while it runs waits for it up to ~20 s, then answers 409
 *    `{ code: 'idempotency_in_progress', ...meta }` (meta from
 *    {@link idempotencyTrack}, e.g. the chat turn's `sessionId`);
 *  - the same key with a different request body answers 422
 *    `{ code: 'idempotency_key_reused' }`.
 */
import type { Ctx } from '@/api/http';
import {
  DEFAULT_JOIN_WAIT_MS,
  type IdempotencyTrack,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  runIdempotent,
} from '@/core/idempotency';
import { sha256 } from '@/utils/crypto';

const HEADERS = ['idempotency-key', 'x-idempotency-key'] as const;
/** Seconds a caller is asked to wait before polling an in-flight key again. */
export const IDEMPOTENCY_RETRY_AFTER_SECONDS = 5;

/** The caller's idempotency key, if it sent one. */
export function getIdempotencyKey(headers: Headers | undefined): string | null {
  if (!headers) return null;
  for (const name of HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

const tracks = new WeakMap<Request, IdempotencyTrack>();

/** The running keyed request's tracker, for a handler that has an id to report early. */
export function idempotencyTrack(request: Request | undefined): IdempotencyTrack | undefined {
  return request ? tracks.get(request) : undefined;
}

/** Key order must not change the fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function succeeded(status: number, body: unknown): boolean {
  if (status >= 400) return false;
  if (body instanceof Response || body instanceof ReadableStream) return false;
  return !(body && typeof body === 'object' && 'error' in body);
}

interface StoredResponse { status: number; body: unknown }

export interface IdempotentRouteOptions {
  /** What identifies the request; default `{ params, body }`. */
  fingerprint?: (ctx: Ctx) => unknown;
  joinWaitMs?: number;
}

/** Make a route honour `Idempotency-Key`. */
export function idempotent(
  scope: string,
  handler: (ctx: Ctx) => unknown | Promise<unknown>,
  options: IdempotentRouteOptions = {},
): (ctx: Ctx) => Promise<unknown> {
  return async (ctx: Ctx) => {
    const key = getIdempotencyKey(ctx.request?.headers);
    const userId = ctx.user?.id as string | undefined;
    // Unauthenticated: the handler answers 401 itself; no key is spent.
    if (!key || !userId) return handler(ctx);
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      ctx.set.status = 400;
      return { error: `Idempotency-Key is longer than ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, code: 'idempotency_key_invalid' };
    }
    const input = options.fingerprint ? options.fingerprint(ctx) : { params: ctx.params, body: ctx.body };
    const outcome = await runIdempotent<StoredResponse>({
      userId,
      scope,
      key,
      fingerprint: sha256(canonical(input ?? null)),
      joinWaitMs: options.joinWaitMs ?? DEFAULT_JOIN_WAIT_MS,
      run: async (track) => {
        if (ctx.request) tracks.set(ctx.request, track);
        const body = await handler(ctx);
        return { status: typeof ctx.set.status === 'number' ? ctx.set.status : 200, body };
      },
      keep: (r) => succeeded(r.status, r.body),
    });
    switch (outcome.kind) {
      case 'fresh':
        return outcome.value.body;
      case 'replayed':
        ctx.set.status = outcome.value.status;
        ctx.set.headers['idempotent-replayed'] = 'true';
        return outcome.value.body;
      case 'in_progress':
        ctx.set.status = 409;
        ctx.set.headers['retry-after'] = String(IDEMPOTENCY_RETRY_AFTER_SECONDS);
        return {
          ...outcome.meta,
          error: 'A request with this Idempotency-Key is still running; retry with the same key for its result',
          code: 'idempotency_in_progress',
          status: 'in_progress',
        };
      case 'mismatch':
        ctx.set.status = 422;
        return { error: 'This Idempotency-Key was already used for a different request', code: 'idempotency_key_reused' };
    }
  };
}
