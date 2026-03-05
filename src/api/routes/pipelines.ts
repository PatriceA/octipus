import { Elysia, t } from 'elysia';
import { eq, or, isNull, desc } from 'drizzle-orm';
import { apiContext } from '@/api/context';
import { getPipelineManager } from '@/core/orchestrator';
import { getDb } from '@/db/postgres';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import { apiLogger } from '@/utils/logger';

export const pipelineRoutes = new Elysia({ prefix: '/pipelines' })
  .use(apiContext)

  // List user's pipelines
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      // System user (MASTER_KEY) is not in DB — return all pipelines for admins
      if (user.id === 'system') {
        const pipelineManager = getPipelineManager();
        return { pipelines: await pipelineManager.listAll() };
      }

      const pipelineManager = getPipelineManager();
      const list = await pipelineManager.listByUser(user.id);

      return { pipelines: list };
    },
    { detail: { tags: ['pipelines'] } },
  )

  // Get pipeline detail with stages
  .get(
    '/:id',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const pipelineManager = getPipelineManager();
      const pipeline = await pipelineManager.getPipeline(params.id);

      if (!pipeline) {
        return { error: 'Pipeline not found' };
      }

      if (!user.isAdmin && pipeline.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const stages = await pipelineManager.getStages(params.id);

      return { pipeline, stages };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['pipelines'] },
    },
  )

  // Approve a pipeline stage
  .post(
    '/:id/approve/:stageId',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      // Approval is handled via the orchestrator's approval system
      // This endpoint exists for REST fallback (WebSocket is primary)
      const { getOrchestratorService } = await import('@/core/orchestrator');
      const orchestrator = getOrchestratorService();
      const approvals = orchestrator.getPendingApprovals();

      // Find matching approval for this pipeline
      const found = approvals.length > 0;

      if (!found) {
        return { error: 'No pending approval found for this stage' };
      }

      return { message: 'Use POST /api/chat/approve with the requestId instead' };
    },
    {
      params: t.Object({ id: t.String(), stageId: t.String() }),
      detail: { tags: ['pipelines'] },
    },
  )

  // Stop a pipeline
  .post(
    '/:id/stop',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const pipelineManager = getPipelineManager();
      const pipeline = await pipelineManager.getPipeline(params.id);

      if (!pipeline) {
        return { error: 'Pipeline not found' };
      }

      if (!user.isAdmin && pipeline.userId !== user.id) {
        return { error: 'Not authorized' };
      }

      const stopped = await pipelineManager.stop(params.id);

      return { stopped };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['pipelines'] },
    },
  )

  // List pipeline templates (user's own + presets)
  .get(
    '/templates',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      const db = getDb();

      // System user (MASTER_KEY) — show all templates
      const whereClause = user.id === 'system'
        ? undefined
        : or(
            eq(pipelineTemplates.userId, user.id),
            eq(pipelineTemplates.isPreset, true),
          );

      const query = db.select().from(pipelineTemplates);
      const templates = whereClause
        ? await query.where(whereClause).orderBy(desc(pipelineTemplates.isPreset), desc(pipelineTemplates.createdAt))
        : await query.orderBy(desc(pipelineTemplates.isPreset), desc(pipelineTemplates.createdAt));
      return { templates };
    },
    { detail: { tags: ['pipelines'] } }
  )

  // Create pipeline template
  .post(
    '/templates',
    async ({ user, body }) => {
      if (!user) return { error: 'Not authenticated' };
      const db = getDb();
      const steps = (body.steps || []).map(s => ({
        name: s.name,
        description: s.description,
        topic: s.topic,
        toolIds: s.toolIds || [],
        requiresApproval: s.requiresApproval ?? false,
        promptTemplate: s.promptTemplate,
      }));
      const [template] = await db.insert(pipelineTemplates).values({
        userId: user.id,
        name: body.name,
        description: body.description,
        steps,
      }).returning();
      return template;
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        steps: t.Optional(t.Array(t.Object({
          name: t.String(),
          description: t.Optional(t.String()),
          topic: t.String(),
          toolIds: t.Optional(t.Array(t.String())),
          requiresApproval: t.Optional(t.Boolean()),
          promptTemplate: t.Optional(t.String()),
        }))),
      }),
      detail: { tags: ['pipelines'] },
    }
  )

  // Update pipeline template
  .put(
    '/templates/:id',
    async ({ user, params, body }) => {
      if (!user) return { error: 'Not authenticated' };
      const db = getDb();
      const steps = (body.steps || []).map(s => ({
        name: s.name,
        description: s.description,
        topic: s.topic,
        toolIds: s.toolIds || [],
        requiresApproval: s.requiresApproval ?? false,
        promptTemplate: s.promptTemplate,
      }));
      const [updated] = await db
        .update(pipelineTemplates)
        .set({ name: body.name, description: body.description, steps, updatedAt: new Date() })
        .where(eq(pipelineTemplates.id, params.id))
        .returning();
      if (!updated) return { error: 'Template not found' };
      return updated;
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        steps: t.Optional(t.Array(t.Object({
          name: t.String(),
          description: t.Optional(t.String()),
          topic: t.String(),
          toolIds: t.Optional(t.Array(t.String())),
          requiresApproval: t.Optional(t.Boolean()),
          promptTemplate: t.Optional(t.String()),
        }))),
      }),
      detail: { tags: ['pipelines'] },
    }
  )

  // Delete pipeline template
  .delete(
    '/templates/:id',
    async ({ user, params }) => {
      if (!user) return { error: 'Not authenticated' };
      const db = getDb();
      const result = await db.delete(pipelineTemplates).where(eq(pipelineTemplates.id, params.id)).returning();
      return { deleted: result.length > 0 };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['pipelines'] },
    }
  );
