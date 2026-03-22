import { resolve } from 'path';
import type { ProfileFact } from '@/db/schema/profiles';
import { getAgentManager } from '@/core/agent-manager';
import type { AgentContext } from '@/core/types';
import { getConfig } from '@/config';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { getRoleConfig, getToolsForRole, SECURITY_PREAMBLE } from './roles';
import { buildSecurityReminder } from './input-guard';
import { getNotificationService } from '@/core/notification-service';
import type { ModelSelector } from './model-selector';
import type { AgentRole, WorkerResult } from './types';
import type { OrchestratorEvent } from './service';

type EmitFn = (event: OrchestratorEvent) => void;

interface WorkerSpawnerDeps {
  modelSelector: ModelSelector;
  emit: EmitFn;
  setLastWorkerResult: (result: string | null) => void;
}

/**
 * Spawn an expert-based worker directly (skip classification + orchestrator).
 */
export async function handleExpertMessage(
  expertId: string,
  message: string,
  sessionId: string,
  userId: string,
  deps: WorkerSpawnerDeps,
  guardFlags: string[] = [],
): Promise<{ response: string; sessionId: string; classification: import('./types').MessageClassification; metadata?: import('./types').ResponseMetadata }> {
  const { getDb } = await import('@/db/postgres');
  const db = getDb();
  const { experts } = await import('@/db/schema/experts');
  const { eq } = await import('drizzle-orm');

  const [expert] = await db.select().from(experts).where(eq(experts.id, expertId)).limit(1);
  if (!expert) {
    return {
      response: `Expert not found: ${expertId}`,
      sessionId,
      classification: { type: 'task', confidence: 1, complexity: 'simple' },
    };
  }

  const startTime = Date.now();
  const agentRole = expert.role as AgentRole;
  const context: AgentContext = {
    id: `expert-${Date.now()}`,
    sessionId,
    userId,
    model: expert.modelPreference || '',
    topic: expert.name,
    role: agentRole,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: { expertId },
  };

  await messageRepository.create({ sessionId, role: 'user', content: message });
  await sessionRepository.incrementMessageCount(sessionId);

  try {
    let expertPrompt = SECURITY_PREAMBLE + (expert.systemPrompt || '');
    if (guardFlags.length > 0) {
      expertPrompt += buildSecurityReminder(guardFlags);
    }
    const skillIds = (expert.skillIds as string[]) || [];
    if (skillIds.length > 0) {
      const { getSkillRegistry } = await import('@/skills/registry');
      const fragment = await getSkillRegistry().buildPromptFragment(skillIds);
      if (fragment) {
        expertPrompt = (expertPrompt || '') + '\n\n# Domain Knowledge\n' + fragment;
      }
    }

    const result = await spawnWorker(agentRole, message, '', context, deps, {
      systemPrompt: expertPrompt,
      model: expert.modelPreference || undefined,
    });

    const response = String(result);
    await messageRepository.create({ sessionId, role: 'assistant', content: response });
    await sessionRepository.incrementMessageCount(sessionId);

    return {
      response,
      sessionId,
      classification: { type: 'task', confidence: 1, complexity: 'moderate', topic: expert.role },
      metadata: { latencyMs: Date.now() - startTime },
    };
  } catch (error) {
    coreLogger.error({ error, expertId, role: agentRole }, 'Expert worker failed');
    return {
      response: `Expert worker failed: ${(error as Error).message}`,
      sessionId,
      classification: { type: 'task', confidence: 1 },
    };
  }
}

/**
 * Spawn a single worker agent for a given role and task.
 */
export async function spawnWorker(
  role: string,
  task: string,
  input: string,
  context: AgentContext,
  deps: WorkerSpawnerDeps,
  overrides?: { systemPrompt?: string; model?: string },
): Promise<unknown> {
  const agentManager = getAgentManager();
  const agentRole = role as AgentRole;
  const roleConfig = getRoleConfig(agentRole);
  const roleTools = getToolsForRole(agentRole);

  // Auto-select a matching expert for this role
  let expertPrompt: string | undefined;
  let expertModel: string | undefined;
  if (!overrides?.systemPrompt) {
    try {
      const { getDb } = await import('@/db/postgres');
      const { experts } = await import('@/db/schema/experts');
      const { eq, and } = await import('drizzle-orm');
      const db = getDb();
      const [matchingExpert] = await db.select().from(experts)
        .where(and(eq(experts.role, agentRole), eq(experts.isSystem, true)))
        .limit(1);
      if (matchingExpert) {
        expertPrompt = matchingExpert.systemPrompt || undefined;
        expertModel = matchingExpert.modelPreference || undefined;

        const criticalRules = (matchingExpert.criticalRules as string[]) || [];
        if (criticalRules.length > 0) {
          expertPrompt = (expertPrompt || '') + '\n\n# Critical Rules\nYou MUST follow these rules:\n' +
            criticalRules.map((r, i) => `${i + 1}. ${r}`).join('\n');
        }

        const deliverableTemplate = matchingExpert.deliverableTemplate;
        if (deliverableTemplate) {
          expertPrompt = (expertPrompt || '') + '\n\n# Deliverable Template\nStructure your output as follows:\n' + deliverableTemplate;
        }

        const successMetrics = (matchingExpert.successMetrics as string[]) || [];
        if (successMetrics.length > 0) {
          expertPrompt = (expertPrompt || '') + '\n\n# Success Metrics\nYour output will be evaluated against these criteria:\n' +
            successMetrics.map((m, i) => `${i + 1}. ${m}`).join('\n');
        }

        const skillIds = (matchingExpert.skillIds as string[]) || [];
        if (skillIds.length > 0) {
          const { getSkillRegistry } = await import('@/skills/registry');
          const fragment = await getSkillRegistry().buildPromptFragment(skillIds);
          if (fragment) {
            expertPrompt = (expertPrompt || '') + '\n\n# Domain Knowledge\n' + fragment;
          }
        }

        coreLogger.info(
          { role: agentRole, expert: matchingExpert.name, hasSkills: (matchingExpert.skillIds as string[] || []).length > 0 },
          'Auto-selected expert for worker role',
        );
      }
    } catch (err) {
      coreLogger.debug({ err, role: agentRole }, 'Expert auto-selection skipped');
    }
  }

  const routing = await deps.modelSelector.selectForWorker(
    roleConfig.defaultTopic,
    roleTools.length > 0,
  );

  const finalModel = overrides?.model || expertModel || routing.model;
  if (!finalModel) {
    return { error: 'No model configured. Please add one in the Models page.' };
  }

  const startTime = Date.now();

  let systemPrompt = overrides?.systemPrompt || expertPrompt || roleConfig.systemPromptTemplate;

  // Inject current date/time context so agents know "today"
  const now = new Date();
  systemPrompt += `\n\nCURRENT DATE/TIME: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  if (agentRole === 'coding') {
    const projectSummary = await loadProjectSummary();
    if (projectSummary) {
      systemPrompt += `\n\n--- Existing Project Summary ---\n${projectSummary}`;
    }
  }

  // Inject user profile context
  if (context.userId) {
    try {
      const { ProfileRepository } = await import('@/db/repositories/profile-repository');
      const profileRepo = new ProfileRepository();
      const userProfile = await profileRepo.findUserProfile(context.userId);
      if (userProfile && (userProfile.facts as ProfileFact[])?.length > 0) {
        const facts = (userProfile.facts as ProfileFact[]).map(f => `- ${f.key}: ${f.value}`).join('\n');
        systemPrompt += `\n\nUSER CONTEXT:\nName: ${userProfile.name}\n${facts}`;
      }
    } catch {}
  }

  // Inject workspace context
  const config = getConfig();
  const workspaceRoot = resolve(config.workspace.rootPath);
  const additionalPaths = config.workspace.additionalPaths?.map((p: string) => resolve(p)).filter(Boolean) || [];
  let workspaceHint = `\n\nWORKSPACE CONSTRAINT: You are working in the project at ${workspaceRoot}.`;
  if (additionalPaths.length > 0) {
    workspaceHint += ` Additional allowed paths: ${additionalPaths.join(', ')}.`;
  }
  workspaceHint += ` Focus your work within these directories. Do not browse parent directories or unrelated projects unless the task explicitly requires it.`;
  systemPrompt += workspaceHint;

  const worker = await agentManager.spawn({
    sessionId: context.sessionId,
    userId: context.userId,
    topic: roleConfig.defaultTopic,
    model: finalModel,
    role: agentRole,
    systemPrompt,
    tools: roleTools,
  });

  const workerId = worker.getContext().id;

  deps.emit({
    type: 'worker_spawned',
    sessionId: context.sessionId,
    userId: context.userId,
    data: { workerId, role: agentRole, model: finalModel, parentAgentId: context.id },
    timestamp: new Date(),
  });

  try {
    const workerMessage = input
      ? `${task}\n\n--- Context from previous steps ---\n${input}`
      : task;

    const result = await worker.run(workerMessage);
    const durationMs = Date.now() - startTime;

    const workerResult: WorkerResult = {
      workerId,
      role: agentRole,
      result,
      model: finalModel,
      iterations: worker.getIteration(),
      durationMs,
      totalTokens: worker.getTotalTokens(),
    };

    deps.emit({
      type: 'worker_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: workerResult,
      timestamp: new Date(),
    });

    getNotificationService().notify(
      context.userId,
      'agent_complete',
      `Agent "${agentRole}" completed`,
      result.slice(0, 200),
      { workerId, role: agentRole, durationMs },
    ).catch(() => {});

    deps.setLastWorkerResult(result);

    return result;
  } catch (error) {
    return handleWorkerFailure(error as Error, worker, workerId, routing.model, agentRole, roleConfig, roleTools, task, input, context, startTime, deps);
  }
}

/**
 * Spawn a team of parallel workers.
 */
export async function spawnTeam(
  members: Array<{ role: string; task: string; input?: string }>,
  context: AgentContext,
  deps: WorkerSpawnerDeps,
): Promise<unknown> {
  const teamId = `team-${Date.now()}`;
  const startTime = Date.now();

  deps.emit({
    type: 'team_started',
    sessionId: context.sessionId,
    userId: context.userId,
    data: {
      teamId,
      members: members.map(m => ({ role: m.role, task: m.task.slice(0, 100) })),
    },
    timestamp: new Date(),
  });

  const results = await Promise.all(
    members.map(async (member) => {
      try {
        const result = await spawnWorker(
          member.role,
          member.task,
          member.input || '',
          context,
          deps,
        );
        return { role: member.role, task: member.task, result: String(result), error: null };
      } catch (error) {
        return { role: member.role, task: member.task, result: null, error: (error as Error).message };
      }
    }),
  );

  const durationMs = Date.now() - startTime;

  deps.emit({
    type: 'team_completed',
    sessionId: context.sessionId,
    userId: context.userId,
    data: { teamId, results: results.map(r => ({ role: r.role, error: r.error })), durationMs },
    timestamp: new Date(),
  });

  const allFailed = results.every(r => r.error !== null);
  if (allFailed) {
    const errorSummary = results.map(r => `${r.role}: ${r.error}`).join('; ');
    throw new Error(`All team members failed: ${errorSummary}`);
  }

  return results.map(r =>
    `### ${r.role} Agent\n**Task:** ${r.task}\n**Result:**\n${r.error ? `ERROR: ${r.error}` : r.result}`
  ).join('\n\n---\n\n');
}

/**
 * Handle worker failure with CLI fallback logic.
 */
async function handleWorkerFailure(
  error: Error,
  worker: import('@/core/agent-base').BaseAgentWorker,
  workerId: string,
  routedModel: string,
  agentRole: AgentRole,
  roleConfig: import('./types').RoleConfig,
  roleTools: import('@/core/agent-base').ToolHandler[],
  task: string,
  input: string,
  context: AgentContext,
  startTime: number,
  deps: WorkerSpawnerDeps,
): Promise<unknown> {
  coreLogger.error({ error, workerId, role: agentRole }, 'Worker agent failed');

  const failedTokens = worker.getTotalTokens();
  if (failedTokens > 0) {
    sessionRepository.incrementMessageCount(context.sessionId, failedTokens).catch(() => {});
  }

  const errorMsg = error.message || '';
  const wasUserStopped = errorMsg.includes('aborted') || errorMsg.includes('stopped')
    || worker.getStatus() === 'stopped';
  if (wasUserStopped) {
    coreLogger.info({ workerId, role: agentRole }, 'Worker stopped by user, not retrying');
    deps.emit({
      type: 'worker_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { workerId, role: agentRole, status: 'stopped', totalTokens: failedTokens, durationMs: Date.now() - startTime },
      timestamp: new Date(),
    });
    return 'Agent was stopped by user.';
  }

  // Retry transient failures (JSON parse, rate limit) with the same model
  const isTransient = errorMsg.includes('JSON') || errorMsg.includes('parse')
    || errorMsg.includes('Unterminated') || errorMsg.includes('rate_limit')
    || errorMsg.includes('overloaded');

  if (isTransient) {
    coreLogger.info({ workerId, role: agentRole, error: errorMsg }, 'Worker failed with transient error, retrying once');
    try {
      const agentManager = getAgentManager();
      const retryWorker = await agentManager.spawn({
        sessionId: context.sessionId,
        userId: context.userId,
        topic: roleConfig.defaultTopic,
        model: routedModel,
        role: agentRole,
        systemPrompt: roleConfig.systemPromptTemplate,
        tools: roleTools,
      });
      const workerMessage = input
        ? `${task}\n\n--- Context from previous steps ---\n${input}`
        : task;
      const retryResult = await retryWorker.run(workerMessage);
      const retryDurationMs = Date.now() - startTime;
      deps.emit({
        type: 'worker_completed',
        sessionId: context.sessionId,
        userId: context.userId,
        data: {
          workerId: retryWorker.getContext().id,
          role: agentRole,
          result: retryResult,
          model: routedModel,
          iterations: retryWorker.getIteration(),
          durationMs: retryDurationMs,
          totalTokens: retryWorker.getTotalTokens(),
          retryOf: workerId,
        } as WorkerResult,
        timestamp: new Date(),
      });
      deps.setLastWorkerResult(retryResult);
      return retryResult;
    } catch (retryError) {
      coreLogger.error({ error: retryError, workerId, role: agentRole }, 'Retry also failed');
    }
  }

  // CLI sub-agent fallback
  const registry = getModelRegistry();
  const failedModel = await registry.getModelByModelId(routedModel);
  if (failedModel?.provider === 'cli') {
    const defaultModel = await registry.getDefaultModel();
    if (defaultModel && defaultModel.modelId !== routedModel && defaultModel.supportsTools) {
      coreLogger.info(
        { failedModel: routedModel, fallbackModel: defaultModel.modelId, role: agentRole },
        'CLI sub-agent failed, retrying with default model',
      );
      try {
        const agentManager = getAgentManager();
        const fallbackWorker = await agentManager.spawn({
          sessionId: context.sessionId,
          userId: context.userId,
          topic: roleConfig.defaultTopic,
          model: defaultModel.modelId,
          role: agentRole,
          systemPrompt: roleConfig.systemPromptTemplate,
          tools: roleTools,
        });
        const workerMessage = input
          ? `${task}\n\n--- Context from previous steps ---\n${input}`
          : task;
        const fallbackResult = await fallbackWorker.run(workerMessage);
        const fbDurationMs = Date.now() - startTime;
        const fallbackWorkerResult: WorkerResult = {
          workerId: fallbackWorker.getContext().id,
          role: agentRole,
          result: fallbackResult,
          model: defaultModel.modelId,
          iterations: fallbackWorker.getIteration(),
          durationMs: fbDurationMs,
        };
        deps.emit({
          type: 'worker_completed',
          sessionId: context.sessionId,
          userId: context.userId,
          data: fallbackWorkerResult,
          timestamp: new Date(),
        });
        return fallbackResult;
      } catch (fallbackError) {
        coreLogger.error({ error: fallbackError, role: agentRole }, 'Fallback worker also failed');
      }
    }
  }

  deps.emit({
    type: 'worker_completed',
    sessionId: context.sessionId,
    userId: context.userId,
    data: {
      workerId,
      role: agentRole,
      status: 'failed',
      error: error.message,
      totalTokens: failedTokens,
      durationMs: Date.now() - startTime,
    },
    timestamp: new Date(),
  });

  getNotificationService().notify(
    context.userId,
    'agent_error',
    `Agent "${agentRole}" failed`,
    error.message,
    { workerId, role: agentRole },
  ).catch(() => {});

  throw new Error(`Worker "${agentRole}" failed: ${error.message}`);
}

async function loadProjectSummary(): Promise<string | null> {
  try {
    const config = getConfig();
    const summaryPath = resolve(config.workspace?.rootPath || '.', '.assistant/project-summary.md');
    const file = Bun.file(summaryPath);
    if (await file.exists()) {
      const content = await file.text();
      return content.slice(0, 4000);
    }
  } catch {
    // File doesn't exist or not readable
  }
  return null;
}
