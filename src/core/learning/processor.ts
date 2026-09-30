import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BackgroundJob } from '@/db/schema/background-jobs';
import { sessionRepository } from '@/db/repositories/session-repository';
import { backgroundJobRepository } from '@/db/repositories/background-job-repository';
import { getModelRegistry } from '@/models/model-registry';
import { getLiteLLMClient } from '@/models/litellm-client';
import { SECURITY_PREAMBLE } from '@/core/agent/roles';
import { filterPII } from '@/core/agent/pii-filter';
import { judgeAndApply } from '@/core/memory/judge';
import { getNoteRepository } from '@/db/repositories/note-repository';
import { getNoteService } from '@/core/knowledge/notes';
import { fileSkillProposal } from '@/services/file-skill-proposal';
import { getPermissionManager } from '@/security/permissions';
import { getConfig } from '@/config';
import type { LearningCheckView } from '@/shared/learning';
import { gatherEvidence } from './evidence';
import { LEARNING_PROMPT, parseLearningReview } from './review';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '@/db/schema/models';
import { estimateTokens } from '@/utils/token-count';

export const learningPayloadSchema = z.object({
  sessionId: z.string().min(1), trigger: z.enum(['plan_completed', 'steps_completed', 'substantial_turn', 'manual']),
  triggerKey: z.string(), through: z.iso.datetime(), plan: z.unknown().optional(),
});

/** No live skill creation, tool execution, or model-driven routing in this worker. */
export async function processLearningJob(job: Pick<BackgroundJob, 'id' | 'userId' | 'workspaceId' | 'payload'>): Promise<void> {
  const outputs: NonNullable<NonNullable<LearningCheckView['result']>['outputs']> = [];
  try {
    const payload = learningPayloadSchema.parse(job.payload);
    const session = await sessionRepository.findById(payload.sessionId);
    if (!session || session.userId !== job.userId || session.workspaceId !== job.workspaceId) throw new Error('Learning session ownership or workspace changed');
    let workspaceId = job.workspaceId;
    if (!workspaceId) {
      const { getOrgWorkspaceManager } = await import('@/security/orgs');
      workspaceId = (await getOrgWorkspaceManager().ensureDefaultWorkspace(job.userId)).id;
    }
    const evidence = await gatherEvidence(job.userId, session.id, new Date(payload.through), payload.plan);
    if (!evidence.some(row => row.kind === 'execution' || row.kind === 'verification')) {
      await backgroundJobRepository.finish(job.id, { status: 'done', stage: 'insufficient_evidence', result: { reason: 'No recorded execution evidence at this milestone.', outputs } });
      return;
    }
    const model = await getModelRegistry().getModelForTopic('background');
    if (!model) throw new Error('No model bound to background; configure one on Topics');
    await backgroundJobRepository.progress(job.id, { stage: 'reviewing', detail: `${evidence.length} bounded evidence excerpts` });
    const systemText = `${SECURITY_PREAMBLE}\n\n${LEARNING_PROMPT}`;
    const evidenceText = JSON.stringify({ trigger: payload.trigger, evidence });
    const contextRoom = model.contextWindow == null ? Infinity
      : model.contextWindow - estimateTokens(systemText) - estimateTokens(evidenceText) - 1024;
    const ceiling = Math.min(model.maxTokens ?? model.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, contextRoom);
    if (ceiling < 1024) throw new Error('Background model context is too small for this learning review. Configure a model with a larger context window.');
    const initialBudget = Math.min(model.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, ceiling);
    const completeReview = (maxTokens: number) => getLiteLLMClient().complete({
      model: model.modelId, modelConfigName: model.name, userId: job.userId,
      sessionId: session.id, requestType: 'learning-review', temperature: 0, maxTokens,
      responseFormat: { type: 'json_object' }, messages: [
        { role: 'system', content: systemText, timestamp: new Date() },
        { role: 'user', content: evidenceText, timestamp: new Date() },
      ],
    });
    let budget = initialBudget;
    let response = await completeReview(budget);
    // Reasoning shares the output budget. Retry once, before any writes, and
    // never exceed the provider ceiling or double the per-request budget.
    if (response.finishReason === 'length' && budget < ceiling) {
      budget = Math.min(budget * 2, ceiling);
      await backgroundJobRepository.progress(job.id, { stage: 'reviewing', detail: `Output limit reached; retrying once with ${budget} tokens (initial ${initialBudget})` });
      response = await completeReview(budget);
    }
    if (response.finishReason === 'length') {
      throw new Error(`Learning review truncated at output limit: ${budget} tokens; model ${model.name ?? model.modelId}; output ${response.usage?.outputTokens ?? 'unknown'}, reasoning ${response.usage?.reasoningTokens ?? 'unknown'}. Increase this model's default output budget or reduce its reasoning setting.`);
    }
    const review = parseLearningReview(response.content ?? '', evidence);
    const canWrite = async (toolId: string, action: string, args: Record<string, unknown>) => {
      const permission = await getPermissionManager().check(job.userId, toolId, action, args,
        { sessionId: session.id, workspaceId: workspaceId ?? undefined }, { defaultLevel: 'ALLOW' });
      if (permission.level !== 'ALLOW') throw new Error(`${toolId}.${action} requires ${permission.level}; automatic learning cannot approve it`);
    };
    const citations = (ids: string[]) => `\n\nEvidence: session ${session.id}; ${ids.join(', ')}. Learning check ${job.id}.`;
    for (const item of review.knowledge) {
      try {
        const body = filterPII(item.content).filtered;
        await canWrite('knowledge', 'index', { content: body });
        const fingerprint = createHash('sha256').update(body.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 24);
        const existing = await getNoteRepository().getBySlug(job.userId, workspaceId, `learning-${fingerprint}`);
        if (existing) {
          outputs.push({ kind: 'knowledge', status: 'duplicate', id: existing.id }); continue;
        }
        const saved = await getNoteService().save({ userId: job.userId, workspaceId,
          slug: `learning-${fingerprint}`, title: filterPII(item.title).filtered, body: body + citations(item.sources),
          tags: ['session-learning'], frontmatter: { sessionId: session.id, learningJobId: job.id, sources: item.sources } });
        outputs.push({ kind: 'knowledge', status: saved.indexed ? saved.created ? 'saved' : 'duplicate' : 'saved_unindexed', id: saved.note.id,
          ...(!saved.indexed ? { detail: 'Note saved; embedding/indexing unavailable' } : {}) });
      } catch (err) { outputs.push({ kind: 'knowledge', status: 'failed', detail: errorText(err) }); }
    }
    for (const item of review.memories) {
      try {
        if (getConfig().memory.extractionCadence === 'off') {
          outputs.push({ kind: 'memory', status: 'disabled', detail: 'Memory extraction is off' }); continue;
        }
        const result = await judgeAndApply([item], { userId: job.userId, workspaceId,
          sourceMessageId: item.sources[0].slice('message:'.length), failOnError: true });
        if (result.length !== 1) throw new Error('Memory judge produced no write outcome');
        outputs.push({ kind: 'memory', status: result[0].action === 'NOOP' ? 'duplicate' : 'saved', id: result[0].memoryId });
      } catch (err) { outputs.push({ kind: 'memory', status: 'failed', detail: errorText(err) }); }
    }
    for (const item of review.skills) {
      try {
        const skill = { name: filterPII(item.name).filtered, description: filterPII(item.description).filtered, content: filterPII(item.content).filtered };
        await canWrite('skill-distill', 'distill', { source: 'text', content: skill.content });
        const result = await fileSkillProposal(skill, job.userId, `learning:${job.id}:session:${session.id}`);
        outputs.push({ kind: 'skill', status: result.deduped ? 'duplicate' : 'proposed',
          id: typeof result.proposalId === 'string' ? result.proposalId : undefined,
          detail: typeof result.message === 'string' ? result.message : undefined });
      } catch (err) { outputs.push({ kind: 'skill', status: 'failed', detail: errorText(err) }); }
    }
    const failed = outputs.some(output => output.status === 'failed' || output.status === 'saved_unindexed');
    await backgroundJobRepository.finish(job.id, { status: failed ? 'error' : 'done',
      stage: failed ? 'partial_failure' : outputs.length ? 'checked' : 'nothing_reusable',
      result: { reason: filterPII(review.reason).filtered, outputs, evidenceIds: evidence.map(row => row.id) },
      error: failed ? 'Some learning outputs could not be saved or indexed; see individual outcomes.' : null });
  } catch (err) {
    await backgroundJobRepository.finish(job.id, { status: 'error', stage: 'failed', error: errorText(err), result: { outputs } });
  }
}
function errorText(err: unknown): string { return filterPII(err instanceof Error ? err.message : String(err)).filtered.slice(0, 1000); }
