/**
 * The constraint a unique violation (`23505`) names (`''` when unnamed); null
 * for any other error. Drizzle wraps the driver's error (`DrizzleQueryError`,
 * whose message is "Failed query: …"), so the code and the constraint are on
 * a `cause` — matching on the message finds neither.
 */
export function uniqueViolation(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: unknown; constraint?: unknown };
    if (pg.code === '23505') return typeof pg.constraint === 'string' ? pg.constraint : '';
  }
  return null;
}
