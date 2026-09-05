import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { clampSince, collectAwayDigest, defaultSince, renderAwayDigest } from '@/core/digest/away';
import { isAuthenticated } from '@/security/principal';

/**
 * "While you were away" (Phase 1). `since` is the client's last look (the
 * dashboard remembers it); without one, the last 24 hours. Clamped to
 * [now - 30d, now] — see `clampSince`.
 */
export const digestRoutes = new Elysia({ prefix: '/digest' })
  .use(apiContext)

  .get(
    '/away',
    async ({ user, principal, query, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const now = new Date();
      let since: Date;
      if (query?.since) {
        since = new Date(query.since);
        if (Number.isNaN(since.getTime())) {
          set.status = 400;
          return { error: `Invalid since "${query.since}" — expected an ISO 8601 timestamp` };
        }
        since = clampSince(since, now);
      } else {
        since = defaultSince(now);
      }
      const digest = await collectAwayDigest(principal, since, { now: () => now });
      return { ...digest, text: renderAwayDigest(digest) };
    },
    {
      query: t.Object({ since: t.Optional(t.String({ maxLength: 40 })) }),
      detail: { tags: ['digest'] },
    }
  );
