/**
 * CORS, as a plugin in the same shape as the rest of the middleware.
 *
 * Written here rather than taken from Hono's own middleware because the
 * application's hook pipeline — not Hono's — is what every route runs through,
 * and a preflight has to short-circuit before the auth guard sees it.
 */
import { App } from './app';

export interface CorsOptions {
  /** `true` mirrors the request's Origin; an array is an allow-list. */
  origin: true | string[];
  credentials?: boolean;
}

const ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';

export function cors(options: CorsOptions): App {
  const allow = (origin: string | undefined): string | null => {
    if (options.origin === true) return origin ?? '*';
    if (!origin) return null;
    return options.origin.includes(origin) ? origin : null;
  };

  return new App({ name: 'cors' })
    .onBeforeHandle((ctx: any) => {
      const origin = ctx.request.headers.get('origin') ?? undefined;
      const allowed = allow(origin);
      if (allowed) {
        ctx.set.headers['Access-Control-Allow-Origin'] = allowed;
        ctx.set.headers.Vary = 'Origin';
        if (options.credentials) ctx.set.headers['Access-Control-Allow-Credentials'] = 'true';
      }
      if (ctx.request.method !== 'OPTIONS') return;
      // Preflight: answer here, before the auth guard, which would 401 it.
      ctx.set.headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
      ctx.set.headers['Access-Control-Allow-Headers'] =
        ctx.request.headers.get('access-control-request-headers') ?? '*';
      ctx.set.headers['Access-Control-Max-Age'] = '86400';
      ctx.set.status = 204;
      return new Response(null, { status: 204 });
    });
}
