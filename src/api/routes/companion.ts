import { ZodError } from 'zod';
import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { CompanionService } from '@/core/companion/service';
import { CompanionSupervisionError } from '@/shared/companion-supervision';
import { isAuthenticated, requireScope, type Principal } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { WorkspaceFS } from '@/security/workspace-fs';
import { apiLogger } from '@/utils/logger';

function service(principal: Principal, write = false) {
  if (!isAuthenticated(principal)) throw new CompanionSupervisionError('scope_unavailable', 'Not authenticated');
  if (!requireScope(principal, write ? API_SCOPES.CHAT : API_SCOPES.READ)) throw new CompanionSupervisionError('scope_unavailable', write ? 'Chat scope required' : 'Read scope required');
  if (!principal.workspaceId || principal.workspaceKind === 'shared') throw new CompanionSupervisionError('scope_unavailable', 'Choose your personal workspace for Companion supervision');
  return new CompanionService({ userId: principal.userId, workspaceId: principal.workspaceId });
}
async function handle<T>(principal: Principal, set: { status?: string | number }, write: boolean, run: (service: CompanionService) => Promise<T>) {
  if (!isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
  try { return await run(service(principal, write)); }
  catch (error) {
    if (error instanceof ZodError) { set.status = 400; return { error: 'Invalid Companion request', details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) }; }
    if (error instanceof CompanionSupervisionError) {
      set.status = { scope_unavailable: 403, not_found: 404, conflict: 409, invalid_evidence: 400 }[error.code];
      return { error: error.message, code: error.code };
    }
    apiLogger.error({ error }, 'Companion request failed'); set.status = 500; return { error: 'Companion request could not be completed' };
  }
}
const id = t.Object({ id: t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }) });
export const companionRoutes = new Elysia({ prefix: '/companion' }).use(apiContext)
  .get('/settings', ({ principal, set }) => handle(principal, set, false, s => s.readSettings()))
  .put('/settings', ({ principal, set, body }) => handle(principal, set, true, s => s.saveSettings(body.settings, body.expectedRevision)), {
    body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }), settings: t.Unknown() }),
  })
  .get('/goals', ({ principal, set }) => handle(principal, set, false, async s => ({ goals: await s.listGoals() })))
  .post('/goals', ({ principal, set, body }) => handle(principal, set, true, s => s.createGoal(body)), { body: t.Unknown() })
  .get('/goals/:id', ({ principal, set, params }) => handle(principal, set, false, s => s.readGoal(params.id)), { params: id })
  .patch('/goals/:id', ({ principal, set, params, body }) => handle(principal, set, true, s => s.updateGoal(params.id, body)), { params: id, body: t.Unknown() })
  .post('/goals/:id/adopt', ({ principal, set, params, body }) => handle(principal, set, true, s => s.adoptExecution(params.id, body)), { params: id, body: t.Unknown() })
  .put('/goals/:id/authorization', ({ principal, set, params, body }) => handle(principal, set, true, async s => {
    const { pipelinePermissionProfileSchema } = await import('@/shared/pipeline-permissions');
    const profile = body.profile === null ? null : pipelinePermissionProfileSchema.parse(body.profile);
    if (profile) {
      const fs = WorkspaceFS.forRequest(principal);
      profile.repoPath = fs.resolve(profile.repoPath);
      profile.repoPaths = profile.repoPaths.map(path => fs.resolve(path));
    }
    return s.authorizeGoal(params.id, profile, body.expectedRevision);
  }), { params: id, body: t.Object({ expectedRevision: t.Integer({ minimum: 0 }), profile: t.Unknown() }) })
  .post('/goals/:id/incident-decision',({principal,set,params,body})=>handle(principal,set,true,s=>s.reopenIncident(params.id,body.incidentId,body.expectedRevision)),{params:id,body:t.Object({incidentId:t.String({pattern:'^[0-9a-fA-F-]{36}$'}),expectedRevision:t.Integer({minimum:0})})})
  .get('/goals/:id/incidents', ({ principal, set, params }) => handle(principal, set, false, async s => ({ incidents: await s.incidents(params.id) })), { params: id })
  .get('/goals/:id/actions', ({ principal, set, params }) => handle(principal, set, false, async s => ({ actions: await s.actions(params.id) })), { params: id })
  .get('/goals/:id/sessions/:sessionId', ({ principal, set, params }) => handle(principal, set, false, s => s.inspectSession(params.id, params.sessionId)),
    { params: t.Object({ id: t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }), sessionId: t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }) }) })
  .post('/goals/:id/sessions', ({ principal, set, params, body }) => handle(principal, set, true, async s => {
    const { startCompanionSessionSchema } = await import('@/shared/companion-supervision');
    const input = startCompanionSessionSchema.parse(body);
    if (input.projectPath) {
      try { input.projectPath = WorkspaceFS.forRequest(principal).resolve(input.projectPath); }
      catch { throw new CompanionSupervisionError('scope_unavailable', 'Project directory is outside approved workspace directories'); }
    }
    return s.startSession(params.id, input);
  }), { params: id, body: t.Unknown() })
  .post('/goals/:id/messages', ({ principal, set, params, body }) => handle(principal, set, true, s => s.messageSession(params.id, body)), { params: id, body: t.Unknown() })
  .post('/goals/:id/control', ({ principal, set, params, body }) => handle(principal, set, true, s => s.controlSession(params.id, body.sessionId, body.state)), {
    params: id, body: t.Object({ sessionId: t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }), state: t.Union([t.Literal('active'), t.Literal('paused')]) }),
  });
