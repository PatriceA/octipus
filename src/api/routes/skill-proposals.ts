import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import {
  approveProposal,
  listPendingProposals,
  rejectProposal,
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
  .get('/', async ({ user, set }) => {
    try {
      return { proposals: await listPendingProposals(ownerFilter(user)) };
    } catch (err) {
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
      });
      if (!result) { set.status = 404; return { error: 'proposal not found or not pending' }; }
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
      if (!suppressedUntil) { set.status = 404; return { error: 'proposal not found or not pending' }; }
      return { rejected: true, suppressedUntil };
    } catch (err) {
      set.status = 500;
      return { error: (err as Error).message };
    }
  });
