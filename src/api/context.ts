import { Elysia } from 'elysia';

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
 * Use this in route files so TypeScript knows about `user` and `session`.
 *
 * The actual derivation happens in server.ts via `.derive()`.
 * This plugin re-exports the same values so the types propagate
 * without overwriting them.
 */
export const apiContext = new Elysia({ name: 'api-context' }).derive(
  { as: 'scoped' },
  (ctx: Record<string, unknown>) => {
    return {
      user: (ctx.user ?? null) as ApiUser | null,
      session: (ctx.session ?? null) as ApiSession | null,
    };
  }
);
