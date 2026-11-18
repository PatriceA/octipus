import { CompanionSupervisionRepository } from '@/db/repositories/companion-supervision-repository';
import type { CompanionBasisRecord, CompanionScope } from '@/shared/companion-supervision';
import { CompanionSupervisionError, startCompanionSessionSchema } from '@/shared/companion-supervision';
import { resolveModel } from '@/models/resolve-model';
import { isCompanionControllerModel } from './model-binding';

/** Durable responsibility only. Starting/stopping execution requires the M2 dispatcher. */
export class CompanionService {
  private readonly repo: CompanionSupervisionRepository;
  constructor(scope: CompanionScope, repo?: CompanionSupervisionRepository) {
    this.repo = repo ?? new CompanionSupervisionRepository(scope);
    if (this.repo.scope.userId !== scope.userId || this.repo.scope.workspaceId !== scope.workspaceId) throw new Error('Companion repository scope mismatch');
  }
  get scope(): CompanionScope { return this.repo.scope; }
  createGoal(input: unknown, ownerInputs?: import('@/shared/companion-supervision').CompanionOwnerInput[]) { return this.repo.create(input, ownerInputs); }
  listGoals(limit?: number) { return this.repo.list(limit); }
  readGoal(id: string) { return this.repo.read(id); }
  adoptExecution(id: string, input: unknown) { return this.repo.adopt(id, input); }
  updateGoal(id: string, input: unknown) { return this.repo.update(id, input); }
  /** Project sessions route their model by the owner's topic lanes, like any session they start. */
  async startSession(id: string, input: unknown, automatic = false, basis?: CompanionBasisRecord) {
    return this.repo.startSession(id, startCompanionSessionSchema.parse(input), automatic, undefined, basis);
  }
  async startMaintenance(id: string, input: unknown, basis?: CompanionBasisRecord) {
    const runtime = (await import('./maintenance')).maintenanceRuntime(this.repo.scope);
    const data = startCompanionSessionSchema.parse(input);
    const settings = await this.repo.readSettings();
    if (!settings.enabled || settings.autonomy !== 'repair') throw new CompanionSupervisionError('conflict', 'Enable repair autonomy before starting maintenance');
    // The restricted maintenance toolbox is enforced only on API/local models, so maintenance
    // runs on the owner's Companion model (Models → Companion model), never a topic lane that
    // may resolve to a native CLI. Checked first: it needs only the settings.
    const model = settings.modelName.trim() ? await resolveModel({ userId: this.repo.scope.userId, name: settings.modelName }) : null;
    if (!model || !isCompanionControllerModel(model))
      throw new CompanionSupervisionError('conflict', 'Maintenance runs on the Companion model; set an API or local tool-capable Companion model under Models');
    // A retry after a lost response gets its own receipt back (the repository's request-key
    // check), not the reuse refusal below.
    const retried = (await this.repo.actions(id)).find(action => action.requestKey === data.requestKey);
    if (retried) return this.repo.startSession(id, { ...data, projectPath: undefined }, true, runtime.binding, basis, model.name);
    const detail = await this.repo.read(id);
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const linked = await Promise.all(detail.links.filter(link => link.active).map(link => sessionRepository.findById(link.sessionId)));
    if (linked.some(session => session?.context?.companionMaintenance?.binding === runtime.binding && session.context.companionMaintenance.authorityRevision === settings.revision))
      throw new CompanionSupervisionError('conflict', 'Reuse the existing maintenance session');
    return this.repo.startSession(id, { ...data, projectPath: undefined }, true, runtime.binding, basis, model.name);
  }
  markBriefingStart(id:string,actionId:string){return this.repo.markBriefingStart(id,actionId);}
  requestBriefing(id:string,input:{sessionId:string;requestKey:string;refresh?:boolean}){return this.repo.requestBriefing(id,input);}
  messageSession(id: string, input: unknown, basis?: CompanionBasisRecord) { return this.repo.queueMessage(id, input, basis); }
  authorizeGoal(id: string, profile: unknown, expectedRevision: number) { return this.repo.authorizeGoal(id, profile, expectedRevision); }
  incidents(id: string) { return this.repo.incidents(id); }
  detectIncident(id: string, sessionId: string) { return this.repo.detectIncident(id, sessionId); }
  reopenIncident(id:string,incidentId:string,expectedRevision:number,ownerTurnId?:string){return this.repo.reopenIncident(id,incidentId,expectedRevision,ownerTurnId);}
  beginVerification(id: string, incidentId: string) { return this.repo.beginVerification(id, incidentId); }
  advanceIncident(id: string, incidentId: string, input: { expectedRevision: number; strategy?: string; evidenceId?: string }) { return this.repo.advanceIncident(id, incidentId, input); }
  actions(id: string) { return this.repo.actions(id); }
  reports(id?: string) { return this.repo.reports(id); }
  findSessions(query: string, limit?: number) { return this.repo.findSessions(query, limit); }
  readSession(sessionId: string) { return this.repo.readSession(sessionId); }
  readReport(id:string,sessionId:string,input:{messageId?:string;actionId?:string;offset:number;limit:number}){return this.repo.readReport(id,sessionId,input);}
  inspectSession(id: string, sessionId: string) { return this.repo.inspectSession(id, sessionId); }
  readSettings() { return this.repo.readSettings(); }
  async saveSettings(input: unknown, expectedRevision: number) {
    const { companionSettingsSchema } = await import('@/shared/companion-supervision');
    const data = companionSettingsSchema.parse(input);
    if (data.enabled || data.modelName.trim()) {
      const model = await resolveModel({ userId: this.repo.scope.userId, name: data.modelName });
      if (!model || !isCompanionControllerModel(model))
        throw new CompanionSupervisionError('conflict', 'Choose an API or local text model with tools for the supervisor. Project sessions use your topic routing.');
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
