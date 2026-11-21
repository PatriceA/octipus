import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { consolidateProposals } from '@/core/learning/consolidation';
import {
  approveProposal,
  countCandidateProposals,
  listOpenProposals,
  mergeProposals,
  ProposalMergeError,
  ProposalRefusedError,
  rejectProposal,
  rejectProposals,
  surfaceProposal,
  toProposalViews,
} from '@/services/skill-proposal-service';
import { coreLogger } from '@/utils/logger';

/**
 * Scope every query to the caller unless they are the system principal or an
 * admin. Before this the list returned — and approve/reject accepted — every
 * user's pending proposals.
 */
function ownerFilter(user: { id: string; isAdmin?: boolean } | undefined): string | undefined {
  if (!user || user.id === 'system' || user.isAdmin) return undefined;
  return user.id;
}

export const skillProposalRoutes = new Elysia({ prefix: '/skills/proposals' })
  .use(apiContext)
  .get('/', async ({ query, user, set }) => {
    try {
      const scope = ownerFilter(user);
      const rows = await listOpenProposals(scope, { includeCandidates: query.include === 'candidates' });
      return { proposals: await toProposalViews(rows), candidateCount: await countCandidateProposals(scope) };
    } catch (err) {
      coreLogger.error({ err }, 'Skill proposal list failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  }, {
    query: t.Object({ include: t.Optional(t.Literal('candidates')) }),
  })
  // Literal paths before `/:id/...`, so `bulk-reject` and `consolidate` are never read as an id.
  .post('/bulk-reject', async ({ body, user, set }) => {
    try {
      return await rejectProposals(body.ids, ownerFilter(user));
    } catch (err) {
      coreLogger.error({ err }, 'Skill proposal bulk reject failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  }, {
    body: t.Object({ ids: t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }) }),
  })
  .post('/consolidate', async ({ user, set }) => {
    // The caller's own proposals only, admins included: never install-wide.
    if (!user) { set.status = 401; return { error: 'authentication required' }; }
    try {
      return await consolidateProposals(user.id);
    } catch (err) {
      coreLogger.error({ err, userId: user.id }, 'Skill proposal consolidation failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  })
  .post('/:id/approve', async ({ params, body, user, set }) => {
    try {
      const result = await approveProposal(params.id, {
        userId: ownerFilter(user),
        name: body?.name,
        systemPrompt: body?.systemPrompt,
        actorId: user?.id,
      });
      if (!result) { set.status = 404; return { error: 'proposal not found or not open' }; }
      // `skill` is the key this route has always returned for a skill, and an
      // out-of-repo client (the mobile app) reads it. The sibling `expert` key
      // is gone with the layer; `kind` stays 'skill' so a client that switches
      // on it keeps working.
      return {
        promoted: true,
        kind: result.promoted,
        id: result.id,
        name: result.name,
        skill: result.record,
      };
    } catch (err) {
      // Stale, locked or otherwise inapplicable: the proposal stays pending
      // and the caller is told why (docs/SESSION-LEARNING.md).
      if (err instanceof ProposalRefusedError) {
        set.status = err.code === 'override' ? 400 : 409;
        return { error: err.message, code: err.code };
      }
      coreLogger.error({ err }, 'Skill proposal approve failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  }, {
    body: t.Optional(t.Object({
      name: t.Optional(t.String()),
      systemPrompt: t.Optional(t.String()),
    })),
  })
  .post('/:id/reject', async ({ params, user, set }) => {
    try {
      const suppressedUntil = await rejectProposal(params.id, ownerFilter(user));
      if (!suppressedUntil) { set.status = 404; return { error: 'proposal not found or not open' }; }
      return { rejected: true, suppressedUntil };
    } catch (err) {
      set.status = 500;
      return { error: (err as Error).message };
    }
  })
  .post('/:id/merge', async ({ params, body, user, set }) => {
    try {
      const result = await mergeProposals(params.id, body.intoId, ownerFilter(user));
      const [proposal] = await toProposalViews([result.proposal]);
      return { merged: true, verdict: result.verdict, mergeDegraded: result.mergeDegraded, proposal };
    } catch (err) {
      if (err instanceof ProposalMergeError) {
        set.status = err.code === 'not_found' ? 404 : err.code === 'not_open' ? 409 : 400;
        return { error: err.message, code: err.code };
      }
      coreLogger.error({ err }, 'Skill proposal merge failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  }, {
    body: t.Object({ intoId: t.String({ minLength: 1 }) }),
  })
  .post('/:id/surface', async ({ params, user, set }) => {
    try {
      const row = await surfaceProposal(params.id, ownerFilter(user));
      if (!row) { set.status = 404; return { error: 'proposal not found or not a candidate' }; }
      const [proposal] = await toProposalViews([row]);
      return { surfaced: true, proposal };
    } catch (err) {
      coreLogger.error({ err }, 'Skill proposal surface failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  });
