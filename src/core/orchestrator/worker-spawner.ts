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
  const roleConfig = getRoleConfig(agentRole);
  const context: AgentContext = {
    id: `expert-${Date.now()}`,
    sessionId,
    userId,
    model: expert.modelPreference || '',
    topic: roleConfig.defaultTopic,
    role: agentRole,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: { expertId, isExpert: true },
  };

  await messageRepository.create({ sessionId, role: 'user', content: message });
  await sessionRepository.incrementMessageCount(sessionId);

  try {
    // Build expert identity prompt — role config as base, then expert-specific overrides
    let expertPrompt = SECURITY_PREAMBLE;

    // Expert identity: name, description, and role-specific system prompt
    expertPrompt += `\nYou are **${expert.name}**${expert.description ? ` — ${expert.description}` : ''}.\n\n`;
    expertPrompt += expert.systemPrompt || roleConfig.systemPromptTemplate;

    // Critical rules
    const criticalRules = (expert.criticalRules as string[]) || [];
    if (criticalRules.length > 0) {
      expertPrompt += '\n\n# Critical Rules\nYou MUST follow these rules:\n' +
        criticalRules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    }

    // Deliverable template
    if (expert.deliverableTemplate) {
      expertPrompt += '\n\n# Deliverable Template\nStructure your output as follows:\n' + expert.deliverableTemplate;
    }

    // Success metrics
    const successMetrics = (expert.successMetrics as string[]) || [];
    if (successMetrics.length > 0) {
      expertPrompt += '\n\n# Success Metrics\nYour output will be evaluated against these criteria:\n' +
        successMetrics.map((m, i) => `${i + 1}. ${m}`).join('\n');
    }

    // Expert-specific tool guidance — prevents looping and over-engineering
    expertPrompt += '\n\n# Response Guidelines\n'
      + '- For conversational messages (greetings, "what can you do", introductions): respond directly with text. Do NOT call any tools.\n'
      + '- Only use tools when the task genuinely requires external data, file operations, or actions.\n'
      + '- Think step-by-step before deciding whether to use a tool. If you can answer from your domain knowledge, do so directly.\n'
      + '- Never call the same tool twice with identical arguments.\n'
      + '- After at most 5 tool calls, synthesize your findings and respond.\n'
      + '- PREFER built-in tools over writing code/scripts. For recurring tasks use the scheduling tool (create_hook). For notifications use the messaging tool (send_message). Do NOT create standalone scripts, plugins, or services when a built-in tool exists.';

    if (guardFlags.length > 0) {
      expertPrompt += buildSecurityReminder(guardFlags);
    }

    // Domain knowledge from skills
    const skillIds = (expert.skillIds as string[]) || [];
    if (skillIds.length > 0) {
      const { getSkillRegistry } = await import('@/skills/registry');
      const fragment = await getSkillRegistry().buildPromptFragment(skillIds);
      if (fragment) {
        expertPrompt += '\n\n# Domain Knowledge\n' + fragment;
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
    const errMsg = (error as Error).message || '';
    coreLogger.error({ error, expertId, role: agentRole }, 'Expert worker failed');

    // Permission denial or user abort → friendly message, let user decide next step
    if (errMsg.includes('Permission denied') || errMsg.includes('stopped by user') || errMsg.includes('aborted')) {
      const response = `The agent was stopped because a required action was denied.\n\nOriginal request: "${message.slice(0, 200)}"\n\nWould you like me to try a different approach, or is there something else I can help with?`;
      await messageRepository.create({ sessionId, role: 'assistant', content: response });
      return {
        response,
        sessionId,
        classification: { type: 'task', confidence: 1, topic: expert.role },
        metadata: { latencyMs: Date.now() - startTime },
      };
    }

    return {
      response: `Expert worker failed: ${errMsg}`,
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

  coreLogger.info({ role: agentRole, toolCount: roleTools.length, toolNames: roleTools.map(t => t.name) }, 'Worker tools resolved');

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

  // ── Inject topic-assigned active skills ──
  let topicSkillFragment = '';
  try {
    const { getSkillRegistry } = await import('@/skills/registry');
    topicSkillFragment = await getSkillRegistry().buildTopicPromptFragment(roleConfig.defaultTopic);
    if (topicSkillFragment) {
      coreLogger.debug({ topic: roleConfig.defaultTopic }, 'Injected topic-assigned skills');
    }
  } catch (err) {
    coreLogger.debug({ err, topic: roleConfig.defaultTopic }, 'Topic skill injection skipped');
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

  // Append topic-assigned skills (e.g. caveman mode) after the base prompt
  if (topicSkillFragment) {
    systemPrompt += '\n\n# Topic Skills\n' + topicSkillFragment;
  }

  // Inject current date/time context so agents know "today"
  const now = new Date();
  systemPrompt += `\n\nCURRENT DATE/TIME: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
  // Determine if this is a dev mode session
  const session = await sessionRepository.findById(context.sessionId);
  const sessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;
  const isDevMode = sessionCtx?.devMode === true && !!sessionCtx.projectPath;
  const devProjectPath = isDevMode ? sessionCtx!.projectPath! : undefined;

  // Inject project summary and maintenance instruction
  const PROJECT_SUMMARY_INSTRUCTION = `\n\nCRITICAL — PROJECT DOCUMENTATION:
Before starting work, check if .assistant/project-summary.md exists in the project root. If it does, read it to understand the project context.
After completing your task, you MUST update .assistant/project-summary.md with:
- Project structure overview (key directories, entry points)
- Main technologies and frameworks used (e.g., Flutter, Bun, React)
- Key files and their purposes
- Available commands (test, build, lint, run)
- Summary of what you changed
If .assistant/ doesn't exist, create the directory first: mkdir -p .assistant
Keep the summary under 4000 chars. This file is critical — it's injected into all future agents working on this project.
If you cannot write files (e.g., read-only environment), include the summary content in your final response and the system will save it automatically.`;

  // Project summary only applies to dev-mode sessions (explicit project link).
  // Non-dev sessions: no path guessing, no workspace fallback. RAG handles recall.
  if (devProjectPath) {
    context.metadata.projectPath = devProjectPath;
    systemPrompt += PROJECT_SUMMARY_INSTRUCTION;
    const projectSummary = await loadProjectSummary(devProjectPath);
    if (projectSummary) {
      const projectName = sessionCtx?.projectName || devProjectPath.split(/[/\\]/).pop() || 'project';
      systemPrompt += `\n\n--- Project Summary (${projectName}) ---\n${projectSummary}`;
    }
  }

  // Inject git status/diff for code-aware roles (gives agents awareness of pending changes)
  const GIT_AWARE_ROLES = new Set(['coding', 'review', 'devops', 'security', 'qa']);
  if (GIT_AWARE_ROLES.has(agentRole)) {
    try {
      const { execSync } = await import('child_process');
      const gitCwd = devProjectPath || getConfig().workspace?.rootPath || process.cwd();
      const gitStatus = execSync('git status --short 2>/dev/null | head -20', { cwd: gitCwd, timeout: 5_000, encoding: 'utf-8' }).trim();
      const gitDiff = execSync('git diff --stat 2>/dev/null | tail -5', { cwd: gitCwd, timeout: 5_000, encoding: 'utf-8' }).trim();
      if (gitStatus || gitDiff) {
        systemPrompt += '\n\n--- Git Status ---';
        if (gitStatus) systemPrompt += `\n${gitStatus}`;
        if (gitDiff) systemPrompt += `\n\nDiff summary:\n${gitDiff}`;
      }
    } catch { /* not a git repo or git unavailable */ }
  }

  // Inject user profile context + related profiles for people-related queries
  if (context.userId) {
    try {
      const { ProfileRepository } = await import('@/db/repositories/profile-repository');
      const profileRepo = new ProfileRepository();

      // Always inject the user's own profile
      const userProfile = await profileRepo.findUserProfile(context.userId);
      if (userProfile && (userProfile.facts as ProfileFact[])?.length > 0) {
        const facts = (userProfile.facts as ProfileFact[]).map(f => `- ${f.key}: ${f.value}`).join('\n');
        systemPrompt += `\n\nUSER CONTEXT:\nName: ${userProfile.name}\n${facts}`;
      }

      // For people-related queries, search for relevant profiles and inject matches.
      // CLI agents can't call the profiles tool (registerTool is a no-op), so we
      // resolve profile data here and put it in the prompt context.
      const peoplePatterns = /\b(who is|wife|husband|partner|mother|father|mom|dad|boss|friend|brother|sister|family|birthday|address|phone|email of|tell me about|remember|my dog|my cat|my pet|company|organization)\b/i;
      if (peoplePatterns.test(task)) {
        // Extract search terms — strip common question words to get the relevant noun
        const searchTerms = task
          .replace(/\b(who is|what is|tell me about|what's|do you know about|my)\b/gi, '')
          .trim()
          .split(/\s+/)
          .filter(w => w.length > 2 && !/^(the|and|for|with)$/i.test(w));

        const matchedProfiles = new Map<string, Awaited<ReturnType<typeof profileRepo.search>>[0]>();
        // Search for each meaningful term
        for (const term of searchTerms.slice(0, 3)) {
          const results = await profileRepo.search(context.userId, term);
          for (const p of results) matchedProfiles.set(p.id, p);
        }
        // Also search for relationship keywords directly (wife, husband, etc.)
        const relationshipMatch = task.match(/\b(wife|husband|partner|mother|father|mom|dad|boss|brother|sister|son|daughter)\b/i);
        if (relationshipMatch) {
          const results = await profileRepo.search(context.userId, relationshipMatch[1]);
          for (const p of results) matchedProfiles.set(p.id, p);
        }

        const relevant = [...matchedProfiles.values()].filter(p => p.id !== userProfile?.id).slice(0, 5);
        if (relevant.length > 0) {
          const profileTexts = relevant.map(p => {
            const facts = (p.facts as ProfileFact[]) || [];
            const factsStr = facts.map(f => `  - ${f.key}: ${f.value}`).join('\n');
            return `**${p.name}** (${p.category || 'person'})${p.relationship ? ` — ${p.relationship}` : ''}\n${factsStr}`;
          });
          systemPrompt += `\n\nRELEVANT PROFILES:\n${profileTexts.join('\n\n')}`;
        }
      }
    } catch (err) { coreLogger.error({ err }, 'silent failure in worker-spawner'); }
  }

  // Inject workspace context
  if (isDevMode && devProjectPath) {
    // Dev mode: workspace is the specific project
    let workspaceHint = `\n\nWORKSPACE CONSTRAINT: You are working in the project at ${devProjectPath}.`;
    workspaceHint += ` Focus your work within this directory. Do not browse parent directories or unrelated projects unless the task explicitly requires it.`;
    const assistantRoot = resolve(process.cwd());
    if (devProjectPath !== assistantRoot) {
      workspaceHint += `\nASSISTANT PROJECT: ${assistantRoot}`;
    }
    workspaceHint += `\nPLUGIN DIRECTORY: ${assistantRoot}/extensions/ — ALL plugins MUST be created here, nowhere else.`;
    if (/\s/.test(assistantRoot) || /\s/.test(devProjectPath)) {
      workspaceHint += `\nIMPORTANT: Paths contain spaces — ALWAYS wrap them in double quotes in shell commands (e.g. \`chmod +x "${devProjectPath}/file.sh"\`). Unquoted, the shell splits on spaces and the command fails.`;
    }
    systemPrompt += workspaceHint;
  } else {
    // Normal mode: global workspace
    const config = getConfig();
    const workspaceRoot = resolve(config.workspace.rootPath);
    const additionalPaths = config.workspace.additionalPaths?.map((p: string) => resolve(p)).filter(Boolean) || [];
    let workspaceHint = `\n\nWORKSPACE CONSTRAINT: You are working in the project at ${workspaceRoot}.`;
    if (additionalPaths.length > 0) {
      workspaceHint += ` Additional allowed paths: ${additionalPaths.join(', ')}.`;
    }
    workspaceHint += ` Focus your work within these directories. Do not browse parent directories or unrelated projects unless the task explicitly requires it.`;
    const assistantRoot = resolve(process.cwd());
    if (workspaceRoot !== assistantRoot) {
      workspaceHint += `\nASSISTANT PROJECT: ${assistantRoot}`;
    }
    workspaceHint += `\nPLUGIN DIRECTORY: ${assistantRoot}/extensions/ — ALL plugins MUST be created here, nowhere else.`;
    if (/\s/.test(workspaceRoot) || /\s/.test(assistantRoot)) {
      workspaceHint += `\nIMPORTANT: Paths contain spaces — ALWAYS wrap them in double quotes in shell commands (e.g. \`chmod +x "${workspaceRoot}/project/file.sh"\`). Unquoted, the shell splits on spaces and the command fails.`;
    }
    systemPrompt += workspaceHint;
  }

  // Workers must return results to the orchestrator, not message the user directly
  systemPrompt += `\n\nIMPORTANT: You are a worker agent. Return your findings and results as plain text in your final response. Do NOT use messaging tools (send_to_user, send_channel_message) to contact the user — the orchestrator handles all user communication. Just do your task and respond with the result.`;

  // Inform agents about the assistant MCP server tools.
  // CLI agents (Claude Code, Gemini, Codex) use tool names directly (assistant_*).
  // LLM agents use meta-tools: mcp_call_tool(server_id: "assistant", tool_name: "...", arguments: {...})
  const isCLIModel = finalModel?.startsWith('cli/');
  if (isCLIModel) {
    systemPrompt += `\n\nASSISTANT MCP TOOLS: You have access to the "assistant" MCP server which provides tools for:
- **People & profiles**: Search/retrieve stored information about people the user knows (assistant_search_profiles, assistant_get_profile)
- **Knowledge base**: Search the user's knowledge base (assistant_search_knowledge)
- **Web search**: Search the web (assistant_search) and fetch pages (assistant_fetch_page)
- **Messaging**: Send messages to the user's channels — Telegram, Slack, etc. (assistant_send_channel_message)
- **Scheduling**: Create/manage scheduled tasks and automations (assistant_create_recurring_task)
- **Documents**: Upload and index documents (assistant_upload_document)
Use these MCP tools when the task benefits from them — especially for people-related questions, knowledge lookups, or cross-channel messaging.`;
  } else {
    systemPrompt += `\n\nEXTERNAL TOOLS VIA MCP: You can access external tools from the "assistant" MCP server.
To use them, first call mcp_list_tools() to discover available tools and their parameters.
Then call mcp_call_tool(server_id: "assistant", tool_name: "<tool>", arguments: {...}) to invoke one.
Available capabilities: people/profiles, knowledge base, web search, messaging (Telegram/Slack), scheduling, documents.
Use these when the task benefits from them — especially for people-related questions, knowledge lookups, or cross-channel messaging.`;
  }

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
    data: { workerId, role: agentRole, model: finalModel, parentAgentId: context.id, stageName: (context as any).stageName },
    timestamp: new Date(),
  });

  try {
    const workerMessage = input
      ? `${task}\n\n--- Context from previous steps ---\n${input}`
      : task;

    const result = await worker.run(workerMessage);
    const durationMs = Date.now() - startTime;

    coreLogger.info({
      workerId, role: agentRole, model: finalModel,
      durationMs, iterations: worker.getIteration(),
      totalTokens: worker.getTotalTokens(),
      resultLength: result?.length || 0,
      parentAgentId: context.id,
    }, 'Worker completed');

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
    ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in worker-spawner'));

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
    sessionRepository.incrementMessageCount(context.sessionId, failedTokens).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in worker-spawner'));
  }

  const errorMsg = error.message || '';

  // Permission denied → don't retry, don't fallback. Propagate cleanly.
  if (errorMsg.includes('Permission denied')) {
    coreLogger.info({ workerId, role: agentRole }, 'Worker stopped due to permission denial');
    deps.emit({
      type: 'worker_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { workerId, role: agentRole, status: 'denied', totalTokens: failedTokens, durationMs: Date.now() - startTime },
      timestamp: new Date(),
    });
    throw error; // Propagate to caller (handleExpertMessage or orchestrator)
  }

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
    // Re-throw so the orchestrator aborts the pipeline instead of proceeding to the next stage
    throw new Error('Agent was stopped by user');
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
  ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in worker-spawner'));

  throw new Error(`Worker "${agentRole}" failed: ${error.message}`);
}

async function loadProjectSummary(rootOverride?: string): Promise<string | null> {
  try {
    const root = rootOverride || getConfig().workspace?.rootPath || '.';
    const summaryPath = resolve(root, '.assistant/project-summary.md');
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
