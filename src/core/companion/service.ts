import { CompanionSupervisionRepository } from '@/db/repositories/companion-supervision-repository';
import type { CompanionScope } from '@/shared/companion-supervision';
import { CompanionSupervisionError, startCompanionSessionSchema } from '@/shared/companion-supervision';
import { resolveModel } from '@/models/resolve-model';
import { canServeText } from '@/models/topics';

/** Durable responsibility only. Starting/stopping execution requires the M2 dispatcher. */
export class CompanionService {
  private readonly repo: CompanionSupervisionRepository;
  constructor(scope: CompanionScope, repo?: CompanionSupervisionRepository) {
    this.repo = repo ?? new CompanionSupervisionRepository(scope);
    if (this.repo.scope.userId !== scope.userId || this.repo.scope.workspaceId !== scope.workspaceId) throw new Error('Companion repository scope mismatch');
  }
  createGoal(input: unknown) { return this.repo.create(input); }
  listGoals(limit?: number) { return this.repo.list(limit); }
  readGoal(id: string) { return this.repo.read(id); }
  adoptExecution(id: string, input: unknown) { return this.repo.adopt(id, input); }
  updateGoal(id: string, input: unknown) { return this.repo.update(id, input); }
  async startSession(id: string, input: unknown, automatic = false) {
    const data = startCompanionSessionSchema.parse(input);
    const model = await resolveModel({ userId: this.repo.scope.userId, name: data.modelName });
    if (!model || !canServeText(model) || !(model.supportsTools || model.provider === 'cli') || /reasoner|thinking/.test(model.modelId)) throw new CompanionSupervisionError('conflict', 'Choose an available text model with tools for this session');
    return this.repo.startSession(id, { ...data, modelName: model.name }, automatic);
  }
  messageSession(id: string, input: unknown) { return this.repo.queueMessage(id, input); }
  actions(id: string) { return this.repo.actions(id); }
  inspectSession(id: string, sessionId: string) { return this.repo.inspectSession(id, sessionId); }
  readSettings() { return this.repo.readSettings(); }
  async saveSettings(input: unknown, expectedRevision: number) {
    const { companionSettingsSchema } = await import('@/shared/companion-supervision');
    const data = companionSettingsSchema.parse(input);
    if (data.enabled) {
      const model = await resolveModel({ userId: this.repo.scope.userId, name: data.modelName });
      if (!model || model.provider === 'cli' || !model.supportsTools || !canServeText(model) || /reasoner|thinking/.test(model.modelId))
        throw new CompanionSupervisionError('conflict', 'Choose an API or local text model with tools for the supervisor. Project sessions can use CLI models.');
      data.modelName = model.name;
    }
    return this.repo.saveSettings(data, expectedRevision);
  }
  async controlSession(id: string, sessionId: string, state: 'active' | 'paused', automatic = false) {
    const result = await this.repo.controlSession(id, sessionId, state, automatic);
    if (state === 'paused') {
      const { getAgentManager } = await import('@/core/agent-manager');
      getAgentManager().stopSession(sessionId, this.repo.scope.userId);
      const { getPipelineManager } = await import('@/core/agent/pipeline-manager');
      const { getDb } = await import('@/db/postgres');
      const { pipelines } = await import('@/db/schema/pipelines');
      const { and, eq, inArray } = await import('drizzle-orm');
      const running = await getDb().select({ id: pipelines.id }).from(pipelines).where(and(eq(pipelines.sessionId, sessionId),
        eq(pipelines.userId, this.repo.scope.userId), eq(pipelines.workspaceId, this.repo.scope.workspaceId), inArray(pipelines.status, ['running', 'awaiting_approval'])));
      for (const pipeline of running) await getPipelineManager().stop(pipeline.id, { userId: this.repo.scope.userId, event: 'companion_pause' });
    }
    return result;
  }
}
