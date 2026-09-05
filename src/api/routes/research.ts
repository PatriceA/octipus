import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { researchJobFromRow, startResearch } from '@/core/research/jobs';
import type { ResearchDepth } from '@/core/research/types';
import { scopedRepos } from '@/db/repositories/scoped';
import { isAuthenticated } from '@/security/principal';

const DEPTHS: ResearchDepth[] = ['quick', 'standard', 'deep'];

/**
 * Deep Research (feature #5) — start a bounded multi-source investigation and
 * poll for a cited report. Authenticated users only; the flow uses the
 * `research` topic model and the SSRF-guarded fetcher.
 */
export const researchRoutes = new Elysia({ prefix: '/research' })
  .use(apiContext)

  // Start a research job.
  .post(
    '/',
    async ({ user, principal, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const question = body.question.trim();
      if (!question) {
        set.status = 400;
        return { error: 'A question is required' };
      }
      const depth: ResearchDepth = DEPTHS.includes(body.depth as ResearchDepth) ? (body.depth as ResearchDepth) : 'standard';
      const job = await startResearch(question, depth, user.id);
      return { jobId: job.id, status: job.status };
    },
    {
      body: t.Object({
        question: t.String({ minLength: 1, maxLength: 2000 }),
        depth: t.Optional(t.String()),
      }),
      detail: { tags: ['research'] },
    }
  )

  // Poll a research job for progress + the finished report.
  .get(
    '/:jobId',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      // Scope by owner: cross-tenant ids are indistinguishable from missing.
      const row = await scopedRepos(principal).jobs.findById(params.jobId);
      if (!row || row.kind !== 'research') {
        set.status = 404;
        return { error: 'Research job not found' };
      }
      return researchJobFromRow(row);
    },
    {
      params: t.Object({ jobId: t.String() }),
      detail: { tags: ['research'] },
    }
  );
