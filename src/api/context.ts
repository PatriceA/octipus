import { Elysia } from '@/api/http';
import { ANONYMOUS_PRINCIPAL, type Principal } from '@/security/principal';

/** User context derived from JWT/session validation in server.ts */
export interface ApiUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

/** Session context derived from JWT/session validation in server.ts */
export interface ApiSession {
  userId: string;
  username: string;
  isAdmin: boolean;
  token: string;
  expiresAt: Date;
}

/**
 * Elysia plugin that declares the derived context shape.
 * Use this in route files so TypeScript knows about `user`, `session`,
 * and `principal`.
 *
 * The actual derivation happens in server.ts via `.derive()`.
 * This plugin re-exports the same values so the types propagate
 * without overwriting them.
 *
 * Phase 1a: routes that handle per-user data should prefer `principal`
 * over `user` and pass it to `scopedRepos(principal)` (see
 * `src/db/repositories/scoped.ts`). The `user` field stays for
 * backwards-compat and will be removed once every route is converted.
 */
export const apiContext = new Elysia({ name: 'api-context' }).derive(
  { as: 'scoped' },
  (ctx: Record<string, unknown>) => {
    return {
      user: (ctx.user ?? null) as ApiUser | null,
      session: (ctx.session ?? null) as ApiSession | null,
      principal: ((ctx.principal as Principal | undefined) ?? ANONYMOUS_PRINCIPAL) as Principal,
    };
  }
);
