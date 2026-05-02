/**
 * Row-Level Security wrapper — Phase 3b multi-user.
 *
 * Postgres RLS is the defense-in-depth layer that complements
 * `scopedRepos(principal)`. The application-layer scope is the
 * primary check; RLS catches anything the scope might miss in the
 * future (forgotten WHERE, raw SQL, new untrusted code path).
 *
 * The pattern:
 *
 *   await withRlsPrincipal(principal, async (tx) => {
 *     // every query inside this callback runs under
 *     //   SET LOCAL app.current_user_id = '<principal.userId>'
 *     //   SET LOCAL app.bypass_rls       = 'false'
 *     // so the policies installed by migration 0034 actually fire.
 *     // `tx` is the Drizzle transaction — pass it down to repos.
 *     return tx.select(...).from(sessions);
 *   });
 *
 * The callback runs inside a Drizzle transaction. `SET LOCAL` is
 * scoped to the transaction so the GUC vanishes on commit/rollback;
 * a connection that goes back to the pool can't leak the session
 * id to the next request.
 *
 * Bypass:
 *   - System jobs (cron, reapers) call `withRlsBypass(fn)` to read
 *     across users.
 *   - The migration default leaves the bypass GUC unset; the policy
 *     reads `COALESCE(current_setting('app.bypass_rls', true), 'true')`
 *     so an unset GUC means bypass-on. That keeps every legacy code
 *     path working when RLS is enabled but the wrapper hasn't been
 *     applied yet.
 *
 * Feature gating:
 *   - When `multiuser.rlsEnabled` is false the wrappers no-op and
 *     run the callback against the global db handle. Lets us roll
 *     this out without forcing a transaction on every request first.
 *   - PGlite ignores RLS regardless of the GUC, so embedded installs
 *     see no behavior change.
 */
import { sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { type Database, getDb } from '@/db/postgres';
import { type Principal, isAuthenticated } from './principal';

/** Transaction handle for use inside an RLS-scoped callback. */
export type RlsTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Run `fn` inside a transaction with the principal's user id set as
 * the RLS GUC. When `multiuser.rlsEnabled` is off, `fn` runs against
 * the global db handle without a transaction (no overhead).
 *
 * Throws if `principal` is anonymous — that's a bug at the call site,
 * not a runtime condition.
 */
export async function withRlsPrincipal<T>(
  principal: Principal,
  fn: (tx: RlsTx | Database) => Promise<T>,
): Promise<T> {
  if (!isAuthenticated(principal)) {
    throw new Error('withRlsPrincipal requires an authenticated principal');
  }

  const enabled = isRlsEnabled();
  if (!enabled) {
    return fn(getDb() as Database);
  }

  return getDb().transaction(async (tx) => {
    // SET LOCAL is scoped to the transaction; the GUC vanishes on
    // commit/rollback so a pooled connection can't leak it.
    await tx.execute(sql`SET LOCAL app.bypass_rls = 'false'`);
    // Pass the userId as a parameter so a malicious id (we don't
    // produce one, but defense in depth) can't break out of the GUC
    // assignment via SQL injection.
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${principal.userId}, true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` with RLS bypass enabled. Used by background jobs (cron,
 * orphan reaper, compaction) that legitimately read across users.
 * No-op when RLS is disabled.
 */
export async function withRlsBypass<T>(
  fn: (tx: RlsTx | Database) => Promise<T>,
): Promise<T> {
  if (!isRlsEnabled()) return fn(getDb() as Database);
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_rls = 'true'`);
    return fn(tx);
  });
}

/** Whether RLS enforcement is active (config flag). */
export function isRlsEnabled(): boolean {
  try { return !!getConfig().multiuser?.rlsEnabled; }
  catch { return false; }
}
