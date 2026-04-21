import { and, eq } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { getDb } from '@/db/postgres';
import { experts } from '@/db/schema/experts';
import { skillProposals } from '@/db/schema/skill-proposals';
import { coreLogger } from '@/utils/logger';

export const skillProposalRoutes = new Elysia({ prefix: '/skills/proposals' })
  .get('/', async ({ set }) => {
    try {
      const db = getDb();
      const rows = await db.select().from(skillProposals).where(eq(skillProposals.status, 'pending'));
      return { proposals: rows };
    } catch (err) {
      set.status = 500;
      return { error: (err as Error).message };
    }
  })
  .post('/:id/approve', async ({ params, body, set }) => {
    try {
      const db = getDb();
      const [proposal] = await db.select().from(skillProposals)
        .where(and(eq(skillProposals.id, params.id), eq(skillProposals.status, 'pending')))
        .limit(1);
      if (!proposal) { set.status = 404; return { error: 'proposal not found or not pending' }; }

      // Create a custom expert from the proposal. User must confirm name/description here.
      const expertName = (body as any)?.name ?? proposal.name;
      const expertRole = (body as any)?.role ?? 'general';
      const systemPrompt = (body as any)?.systemPrompt ?? proposal.draftPromptTemplate;

      const [expert] = await db.insert(experts).values({
        userId: proposal.userId,
        name: expertName,
        description: proposal.description,
        role: expertRole,
        systemPrompt,
        isSystem: false,
      }).returning();

      await db.update(skillProposals)
        .set({ status: 'promoted' })
        .where(eq(skillProposals.id, params.id));

      coreLogger.info({ proposalId: params.id, expertId: expert?.id }, 'Skill proposal promoted to expert');
      return { promoted: true, expert };
    } catch (err) {
      coreLogger.error({ err }, 'Skill proposal approve failed');
      set.status = 500;
      return { error: (err as Error).message };
    }
  }, {
    body: t.Optional(t.Object({
      name: t.Optional(t.String()),
      role: t.Optional(t.String()),
      systemPrompt: t.Optional(t.String()),
    })),
  })
  .post('/:id/reject', async ({ params, set }) => {
    try {
      const db = getDb();
      // 90-day suppression
      const suppressUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      await db.update(skillProposals)
        .set({ status: 'rejected', rejectedUntil: suppressUntil })
        .where(eq(skillProposals.id, params.id));
      return { rejected: true, suppressedUntil: suppressUntil };
    } catch (err) {
      set.status = 500;
      return { error: (err as Error).message };
    }
  });
