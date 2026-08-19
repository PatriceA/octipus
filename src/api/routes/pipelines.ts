import { desc, eq, or } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getPipelineManager } from '@/core/orchestrator';
import { validatePipelineStages } from '@/core/orchestrator/pipeline-validation';
import { validateRecipeParameterDefs, validateRecipeParameterRefs } from '@/core/orchestrator/recipe-params';
import {
  exportRecipe,
  importRecipe,
  listAvailableTemplates,
  parseRecipeExport,
} from '@/core/orchestrator/templates';
import { getDb } from '@/db/postgres';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { scopedRepos } from '@/db/repositories/scoped';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import { isAuthenticated } from '@/security/principal';
import { coreLogger } from '@/utils/logger';

/** Shared Elysia body schema for a recipe stage (incl. per-stage model override). */
const recipeStepBodySchema = t.Object({
  name: t.String(),
  description: t.Optional(t.String()),
  // Optional at the transport level because a `human_input` step binds no
  // worker and therefore no topic. `validatePipelineStages` is what decides
  // whether THIS step needed one — one place, one answer.
  topic: t.Optional(t.String()),
  toolIds: t.Optional(t.Array(t.String())),
  requiresApproval: t.Optional(t.Boolean()),
  promptTemplate: t.Optional(t.String()),
  stageType: t.Optional(
    t.Union([t.Literal('standard'), t.Literal('qa_validation'), t.Literal('human_input')]),
  ),
  maxRetries: t.Optional(t.Number()),
  retryTargetStage: t.Optional(t.Number()),
  model: t.Optional(t.String()),
  loopOverPlan: t.Optional(t.Boolean()),
  producesPlan: t.Optional(t.Boolean()),
  humanFields: t.Optional(
    t.Array(
      t.Object({
        key: t.String(),
        label: t.String(),
        options: t.Optional(t.Array(t.String())),
      }),
    ),
  ),
});

/** Shared Elysia body schema for a recipe parameter (deep-validated by Zod). */
const recipeParamBodySchema = t.Object({
  key: t.String(),
  description: t.Optional(t.String()),
  inputType: t.String(),
  requirement: t.String(),
  default: t.Optional(t.String()),
  options: t.Optional(t.Array(t.String())),
});

/**
 * Pipelines — Phase 1a multi-user conversion.
 *
 * Pipeline rows are user-owned: scoped findById guards GET, /stop, and
 * /approve. Templates are dual-mode: presets are visible to everyone but
 * read-only; private templates belong to one user. The previous
 * PUT/DELETE on templates had NO auth check at all — any authenticated
 * caller could mutate any template. Phase 1a routes the writes through
 * `scopedRepos(principal).pipelines.findOwnedTemplateById` first; presets
 * (read-only) and other users' templates are rejected as "not found".
 */
export const pipelineRoutes = new Elysia({ prefix: '/pipelines' })
  .use(apiContext)

  // List user's pipelines
  .get(
    '/',
    async ({ user, principal }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const pipelineManager = getPipelineManager();

      // Admins see everything (operational triage); regular users see
      // only their own. The 'system' pseudo-id is used by in-process
      // system jobs.
      if (user.isAdmin || user.id === 'system') {
        return { pipelines: await pipelineManager.listAll() };
      }

      const list = await pipelineManager.listByUser(user.id);
      return { pipelines: list };
    },
    { detail: { tags: ['pipelines'] } },
  )

  // Get pipeline detail with stages
  .get(
    '/:id',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) {
        return { error: 'Pipeline not found' };
      }

      const pipelineManager = getPipelineManager();
      const { nodes, edges, plan } = await pipelineManager.getGraph(params.id);
      return { pipeline, nodes, edges, plan };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['pipelines'] },
    },
  )

  // Approve a pipeline stage
  .post(
    '/:id/approve/:stageId',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) {
        return { error: 'Pipeline not found' };
      }

      // Approval is handled via the orchestrator's approval system;
      // this endpoint exists as a REST fallback. Filter pending
      // approvals to the principal so we can't peek at someone else's.
      const { getOrchestratorService } = await import('@/core/orchestrator');
      const orchestrator = getOrchestratorService();
      const approvals = user.isAdmin
        ? orchestrator.getPendingApprovals()
        : orchestrator.getPendingApprovals(user.id);
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

  // ── Plan items ──────────────────────────────────────────────────
  // The plan a `foreach` node iterates. Editable WHILE the pipeline runs: the
  // loop re-reads the list every pass, so an edit here lands on the next item
  // rather than requiring a restart. Items already `running` or `done` are not
  // retroactively changed — the run that happened is what happened.

  .get(
    '/:id/plan',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) return { error: 'Pipeline not found' };
      return { plan: await pipelineRepository.getPlanItems(params.id) };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['pipelines'] } },
  )

  .post(
    '/:id/plan',
    async ({ user, principal, params, body }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) return { error: 'Pipeline not found' };

      const start = await pipelineRepository.nextPlanOrdinal(params.id);
      const added = await pipelineRepository.addPlanItems(
        body.items.map((item, i) => ({
          pipelineId: params.id,
          ordinal: start + i,
          title: item.title,
          detail: item.detail,
          createdByUserId: user.id === 'system' ? null : user.id,
        })),
      );
      return { added };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        items: t.Array(t.Object({ title: t.String(), detail: t.Optional(t.String()) })),
      }),
      detail: { tags: ['pipelines'] },
    },
  )

  .patch(
    '/:id/plan/:itemId',
    async ({ user, principal, params, body }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) return { error: 'Pipeline not found' };

      // Scope the item to the pipeline the caller was authorized for — an id
      // from another pipeline must not resolve through this route.
      const items = await pipelineRepository.getPlanItems(params.id);
      if (!items.some((i) => i.id === params.itemId)) return { error: 'Plan item not found' };

      const updated = await pipelineRepository.updatePlanItem(params.itemId, body);
      return { item: updated };
    },
    {
      params: t.Object({ id: t.String(), itemId: t.String() }),
      body: t.Object({
        title: t.Optional(t.String()),
        detail: t.Optional(t.String()),
        ordinal: t.Optional(t.Number()),
        status: t.Optional(
          t.Union([t.Literal('pending'), t.Literal('skipped')]),
        ),
      }),
      detail: { tags: ['pipelines'] },
    },
  )

  .delete(
    '/:id/plan/:itemId',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) return { error: 'Pipeline not found' };

      const items = await pipelineRepository.getPlanItems(params.id);
      const item = items.find((i) => i.id === params.itemId);
      if (!item) return { error: 'Plan item not found' };
      // A pending item can be dropped; one that already ran is history.
      if (item.status !== 'pending') {
        return { error: `Cannot delete a '${item.status}' item — mark it skipped instead.` };
      }
      await pipelineRepository.deletePlanItem(params.itemId);
      return { deleted: true };
    },
    { params: t.Object({ id: t.String(), itemId: t.String() }), detail: { tags: ['pipelines'] } },
  )

  // ── Checkpoints: pause, inspect, edit, resume, rewind ───────────
  // A checkpoint is written at every node boundary, so these four routes are
  // the same mechanism seen from four angles: pause asks the walker to stop at
  // the next one, resume walks on from one, PATCH edits what the next node
  // will read, and resume with an older `fromSeq` is a rewind.

  .get(
    '/:id/checkpoints',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) {
        set.status = 404;
        return { error: 'Pipeline not found' };
      }
      const rows = await pipelineRepository.getCheckpoints(params.id);
      // The state blob is returned whole: inspecting it is the point, and it is
      // the same prose the user already sees on the node rows.
      return { checkpoints: rows };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['pipelines'] } },
  )

  .patch(
    '/:id/checkpoints/:seq',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) {
        set.status = 404;
        return { error: 'Pipeline not found' };
      }
      if (pipeline.status === 'running') {
        set.status = 409;
        return { error: 'Pause the pipeline before editing its state.' };
      }

      // A non-numeric segment would reach Postgres as NaN and 500 there.
      const seq = Number(params.seq);
      if (!Number.isInteger(seq)) {
        set.status = 400;
        return { error: 'Checkpoint seq must be an integer.' };
      }
      const existing = await pipelineRepository.getCheckpoint(params.id, seq);
      if (!existing) {
        set.status = 404;
        return { error: 'Checkpoint not found' };
      }

      // Only the field a human can meaningfully rewrite: what the next node
      // reads. The counters and the cursor are the walker's bookkeeping, and
      // hand-editing them turns a resume into an unexplainable run.
      const updated = await pipelineRepository.updateCheckpointState(params.id, seq, {
        ...existing.state,
        previousOutput: body.previousOutput,
      });
      return { checkpoint: updated };
    },
    {
      params: t.Object({ id: t.String(), seq: t.String() }),
      body: t.Object({ previousOutput: t.String() }),
      detail: { tags: ['pipelines'] },
    },
  )

  .post(
    '/:id/pause',
    async ({ user, principal, params, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) {
        set.status = 404;
        return { error: 'Pipeline not found' };
      }
      const paused = await getPipelineManager().pause(params.id);
      return paused
        ? { pausing: true, message: 'The pipeline will pause at the next node boundary.' }
        : { pausing: false, message: `Pipeline is ${pipeline.status}, not running.` };
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['pipelines'] } },
  )

  .post(
    '/:id/resume',
    async ({ user, principal, params, body, set }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) {
        set.status = 404;
        return { error: 'Pipeline not found' };
      }

      const manager = getPipelineManager();
      // Validate before answering — a bad seq or a live walker must be an error
      // the caller sees, not a background failure nobody reads.
      if (body?.fromSeq != null) {
        const target = await pipelineRepository.getCheckpoint(params.id, body.fromSeq);
        if (!target) {
          set.status = 404;
          return { error: 'Checkpoint not found' };
        }
      }
      // `awaiting_approval` still has a walker holding the run — see
      // PipelineManager.resume.
      if (pipeline.status === 'running' || pipeline.status === 'awaiting_approval') {
        set.status = 409;
        return { error: `Pipeline is ${pipeline.status}` };
      }

      // Fire-and-forget: a walk is minutes to hours of worker turns, so the
      // request returns as soon as the run is under way. Progress arrives on
      // the pipeline event stream, exactly as it does for a fresh run.
      void manager.resume(params.id, { fromSeq: body?.fromSeq }).catch((err: unknown) => {
        coreLogger.error({ err, pipelineId: params.id }, 'Resume failed');
      });
      return { resuming: true, fromSeq: body?.fromSeq ?? null };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Optional(t.Object({ fromSeq: t.Optional(t.Number()) })),
      detail: { tags: ['pipelines'] },
    },
  )

  // Stop a pipeline
  .post(
    '/:id/stop',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) {
        return { error: 'Not authenticated' };
      }

      const pipeline = await scopedRepos(principal).pipelines.findById(params.id);
      if (!pipeline) {
        return { error: 'Pipeline not found' };
      }

      const pipelineManager = getPipelineManager();
      const stopped = await pipelineManager.stop(params.id);
      return { stopped };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['pipelines'] },
    },
  )

  // List available pipeline templates (user's + presets) with stage info
  .get(
    '/types',
    async ({ user }) => {
      if (!user) return { error: 'Not authenticated' };
      const userId = user.id === 'system' ? undefined : user.id;
      const templates = await listAvailableTemplates(userId);
      return { types: templates };
    },
    { detail: { tags: ['pipelines'] } }
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
        topic: s.topic ?? '',
        toolIds: s.toolIds || [],
        requiresApproval: s.requiresApproval ?? false,
        promptTemplate: s.promptTemplate,
        stageType: s.stageType,
        maxRetries: s.maxRetries,
        retryTargetStage: s.retryTargetStage,
        model: s.model,
        // Every declaration the body schema accepts must be carried here.
        // This mapper enumerates fields, so a flag missing from it is accepted
        // by the API, dropped on the way to the row, and then never seen by the
        // gate that reads it — the same way `loopOverPlan`/`producesPlan` were
        // silently discarded from every user-authored recipe until now.
        loopOverPlan: s.loopOverPlan,
        producesPlan: s.producesPlan,
        humanFields: s.humanFields,
      }));
      const stepErrors = validatePipelineStages(steps);
      if (stepErrors.length > 0) return { error: stepErrors.join(' ') };

      let parameters;
      try {
        parameters = validateRecipeParameterDefs(body.parameters ?? []);
        validateRecipeParameterRefs(steps, parameters);
      } catch (err) {
        return { error: `Invalid recipe parameters: ${(err as Error).message}` };
      }
      const [template] = await db.insert(pipelineTemplates).values({
        userId: user.id,
        name: body.name,
        description: body.description,
        steps,
        parameters,
      }).returning();
      return template;
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.String()),
        steps: t.Optional(t.Array(recipeStepBodySchema)),
        parameters: t.Optional(t.Array(recipeParamBodySchema)),
      }),
      detail: { tags: ['pipelines'] },
    }
  )

  // Update pipeline template
  .put(
    '/templates/:id',
    async ({ user, principal, params, body }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };

      // Pre-Phase-1a this endpoint had NO auth check — any authenticated
      // user could mutate any template, including system presets. Now the
      // scoped lookup rejects presets (they don't carry a userId match)
      // and other users' templates as "not found".
      const owned = await scopedRepos(principal).pipelines.findOwnedTemplateById(params.id);
      if (!owned) return { error: 'Template not found' };

      const db = getDb();
      const steps = (body.steps || []).map(s => ({
        name: s.name,
        description: s.description,
        topic: s.topic ?? '',
        toolIds: s.toolIds || [],
        requiresApproval: s.requiresApproval ?? false,
        promptTemplate: s.promptTemplate,
        stageType: s.stageType,
        maxRetries: s.maxRetries,
        retryTargetStage: s.retryTargetStage,
        model: s.model,
        // Every declaration the body schema accepts must be carried here.
        // This mapper enumerates fields, so a flag missing from it is accepted
        // by the API, dropped on the way to the row, and then never seen by the
        // gate that reads it — the same way `loopOverPlan`/`producesPlan` were
        // silently discarded from every user-authored recipe until now.
        loopOverPlan: s.loopOverPlan,
        producesPlan: s.producesPlan,
        humanFields: s.humanFields,
      }));
      const stepErrors = validatePipelineStages(steps);
      if (stepErrors.length > 0) return { error: stepErrors.join(' ') };

      let parameters;
      try {
        parameters = validateRecipeParameterDefs(body.parameters ?? []);
        validateRecipeParameterRefs(steps, parameters);
      } catch (err) {
        return { error: `Invalid recipe parameters: ${(err as Error).message}` };
      }
      const [updated] = await db
        .update(pipelineTemplates)
        .set({ name: body.name, description: body.description, steps, parameters, updatedAt: new Date() })
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
        steps: t.Optional(t.Array(recipeStepBodySchema)),
        parameters: t.Optional(t.Array(recipeParamBodySchema)),
      }),
      detail: { tags: ['pipelines'] },
    }
  )

  // Delete pipeline template
  .delete(
    '/templates/:id',
    async ({ user, principal, params }) => {
      if (!user || !isAuthenticated(principal)) return { error: 'Not authenticated' };

      // Same gap as PUT — pre-Phase-1a had no auth check.
      const owned = await scopedRepos(principal).pipelines.findOwnedTemplateById(params.id);
      if (!owned) return { error: 'Template not found' };

      const db = getDb();
      const result = await db.delete(pipelineTemplates).where(eq(pipelineTemplates.id, params.id)).returning();
      return { deleted: result.length > 0 };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: { tags: ['pipelines'] },
    }
  )

  // Export a recipe (template) to a portable JSON string for sharing.
  .get(
    '/templates/:id/export',
    async ({ user, params, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        const json = await exportRecipe(params.id, user.id === 'system' ? undefined : user.id);
        return { recipe: json };
      } catch (err) {
        set.status = 404;
        return { error: (err as Error).message };
      }
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['pipelines'] } },
  )

  // Import a shared recipe JSON as a new template owned by the caller.
  .post(
    '/templates/import',
    async ({ user, body, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'Not authenticated' };
      }
      try {
        const recipe = parseRecipeExport(body.recipe);
        const created = await importRecipe(user.id, recipe);
        return created;
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    },
    { body: t.Object({ recipe: t.String() }), detail: { tags: ['pipelines'] } },
  );
