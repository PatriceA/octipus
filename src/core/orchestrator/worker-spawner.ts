import { resolve } from 'path';
import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { getNotificationService } from '@/core/notification-service';
import type { AgentContext } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { ProfileFact } from '@/db/schema/profiles';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { buildSecurityReminder } from './input-guard';
import type { ModelSelector } from './model-selector';
import { getRoleConfig, getToolsForRole, SECURITY_PREAMBLE, stripSecurityPreamble } from './roles';
import type { OrchestratorEvent } from './service';
import { appendSources } from './types';
import type { AgentRole, WorkerResult } from './types';

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
  workspaceId: string | null = null,
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
    workspaceId,
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

    // Expert identity: name, description, and role-specific system prompt.
    // Strip a leading SECURITY_PREAMBLE from the concatenated body — both
    // `expert.systemPrompt` (legacy expert rows seeded with the preamble
    // baked in) and `roleConfig.systemPromptTemplate` (always prepended by
    // getRoleConfig) can carry it, which would duplicate the block above.
    expertPrompt += `\nYou are **${expert.name}**${expert.description ? ` — ${expert.description}` : ''}.\n\n`;
    expertPrompt += stripSecurityPreamble(expert.systemPrompt || roleConfig.systemPromptTemplate);

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
      const skillReg = getSkillRegistry();
      const found = await skillReg.getByIds(skillIds);
      if (found.length < skillIds.length) {
        const foundSet = new Set(found.map((s) => s.id));
        const missing = skillIds.filter((id) => !foundSet.has(id));
        coreLogger.error(
          { expertId, expertName: expert.name, expectedSkillIds: skillIds, missing },
          'Expert lists skillIds missing from registry — expert worker runs with partial domain knowledge',
        );
      }
      const fragment = await skillReg.buildPromptFragment(skillIds);
      if (fragment) {
        expertPrompt += `\n\n# Domain Knowledge\n${fragment}`;
      }
    }

    const result = await spawnWorker(agentRole, message, '', context, deps, {
      systemPrompt: expertPrompt,
      model: expert.modelPreference || undefined,
    });

    // Source attribution: which expert ran, which role, which skills were
    // injected. Mirrors the directResponse / orchestrator footer so the
    // user sees consistent provenance no matter which path served them.
    const sources: string[] = [`expert(${expert.name})`, `role(${agentRole})`];
    if (skillIds.length > 0) sources.push(`skills(${skillIds.length})`);
    if (guardFlags.length > 0) sources.push(`guard(${guardFlags.join(',')})`);

    const session = await sessionRepository.findById(sessionId);
    const showSources = (session?.metadata as Record<string, unknown> | undefined)?.showSources !== false;
    const response = showSources ? appendSources(String(result), sources) : String(result);

    await messageRepository.create({ sessionId, role: 'assistant', content: response });
    await sessionRepository.incrementMessageCount(sessionId);

    return {
      response,
      sessionId,
      classification: { type: 'task', confidence: 1, complexity: 'moderate', topic: expert.role },
      metadata: { latencyMs: Date.now() - startTime, sources },
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

  if (context.userId && context.userId !== 'system' && context.userId !== 'local') {
    try {
      const { getConnectorRegistry } = await import('@/connectors');
      const connectorHandlers = await getConnectorRegistry().getUserToolHandlers(context.userId);
      roleTools.push(...connectorHandlers);
    } catch (err) {
      coreLogger.warn({ err, userId: context.userId }, 'Failed to load connector tool handlers');
    }
  }

  coreLogger.info({ role: agentRole, toolCount: roleTools.length, toolNames: roleTools.map(t => t.name) }, 'Worker tools resolved');

  // Auto-select a matching expert for this role
  let expertPrompt: string | undefined;
  let expertModel: string | undefined;
  // Hoisted so the topic-skill dedupe below can read whichever skillIds
  // the matched expert advertised. Closed over by the topic-skill block.
  let expertSkillIdsOuter: string[] = [];
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
        expertSkillIdsOuter = skillIds;
        if (skillIds.length > 0) {
          const { getSkillRegistry } = await import('@/skills/registry');
          const skillReg = getSkillRegistry();
          const found = await skillReg.getByIds(skillIds);
          if (found.length < skillIds.length) {
            const foundSet = new Set(found.map((s) => s.id));
            const missing = skillIds.filter((id) => !foundSet.has(id));
            coreLogger.error(
              { role: agentRole, expert: matchingExpert.name, expectedSkillIds: skillIds, missing },
              'Expert lists skillIds missing from registry — worker runs with partial domain knowledge',
            );
          }
          // Index-only mode: dump skill name + 1-line description, not
          // the whole body. The agent loads specific skill content via
          // the `octipus_get_skill` MCP tool when it needs to. A typical
          // role with 30+ skills was previously dumping ~50–80k tokens
          // of skill bodies into every worker prompt; now it's a few
          // hundred and the agent pays only for what it pulls.
          const summary = await skillReg.buildPromptSummary(skillIds);
          if (summary) {
            expertPrompt = `${expertPrompt || ''}\n\n# Domain Knowledge (index)\n${summary}`;
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

  // ── Inject topic-assigned active skills (hybrid discovery) ──
  // Same index-only treatment as expert skills above. Dedupe against
  // the expert's skillIds so an overlap doesn't list the same skill
  // twice — previously the prompt carried two copies of every shared
  // skill, doubling that part of the token cost for no benefit.
  let topicSkillFragment = '';
  try {
    const { discoverSkillIds } = await import('@/skills/discovery');
    const { getSkillRegistry } = await import('@/skills/registry');
    const discoveredIds = await discoverSkillIds({
      topic: roleConfig.defaultTopic,
      message: task,
    });
    const expertSkillIds = new Set<string>(expertSkillIdsOuter);
    const noveltopicIds = discoveredIds.filter((id) => !expertSkillIds.has(id));
    if (noveltopicIds.length > 0) {
      topicSkillFragment = await getSkillRegistry().buildPromptSummary(noveltopicIds);
    }
    coreLogger.debug(
      {
        topic: roleConfig.defaultTopic,
        discoveredSkillCount: discoveredIds.length,
        afterDedupe: noveltopicIds.length,
      },
      'Injected topic-assigned skills',
    );
  } catch (err) {
    // Fail loud: topic-skill injection shouldn't throw under normal
    // operation. Previously debug-level — promoted to error so misconfigs
    // (e.g. DB offline, schema drift) surface in logs.
    coreLogger.error(
      { err, topic: roleConfig.defaultTopic },
      'Topic skill injection failed — worker runs WITHOUT topic skills',
    );
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
Before starting work, check if .octipus/project-summary.md exists in the project root. If it does, read it to understand the project context.
After completing your task, you MUST update .octipus/project-summary.md with:
- Project structure overview (key directories, entry points)
- Main technologies and frameworks used (e.g., Flutter, Bun, React)
- Key files and their purposes
- Available commands (test, build, lint, run)
- Summary of what you changed
If .octipus/ doesn't exist, create the directory first: mkdir -p .octipus
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
    const octiRoot = resolve(process.cwd());
    if (devProjectPath !== octiRoot) {
      workspaceHint += `\nOCTIPUS PROJECT: ${octiRoot}`;
    }
    workspaceHint += `\nPLUGIN DIRECTORY: ${octiRoot}/extensions/ — ALL plugins MUST be created here, nowhere else.`;
    if (/\s/.test(octiRoot) || /\s/.test(devProjectPath)) {
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
    const octiRoot = resolve(process.cwd());
    if (workspaceRoot !== octiRoot) {
      workspaceHint += `\nOCTIPUS PROJECT: ${octiRoot}`;
    }
    workspaceHint += `\nPLUGIN DIRECTORY: ${octiRoot}/extensions/ — ALL plugins MUST be created here, nowhere else.`;
    if (/\s/.test(workspaceRoot) || /\s/.test(octiRoot)) {
      workspaceHint += `\nIMPORTANT: Paths contain spaces — ALWAYS wrap them in double quotes in shell commands (e.g. \`chmod +x "${workspaceRoot}/project/file.sh"\`). Unquoted, the shell splits on spaces and the command fails.`;
    }
    systemPrompt += workspaceHint;
  }

  // Memory-redesign Phase D — surface role-scoped long-term memory.
  // Filter is OR(NULL, role) so this also picks up globally-scoped
  // facts. Auto-no-op when the memories table is empty or memory
  // extraction has not been wired by the operator.
  if (context.userId) {
    try {
      const { retrieveForContext, renderMemoriesBlock } = await import('@/core/memory');
      const memRows = await retrieveForContext({
        userId: context.userId,
        agentScope: agentRole,
        limit: 8,
      });
      const memBlock = renderMemoriesBlock(memRows);
      if (memBlock) systemPrompt += memBlock;
    } catch (err) {
      coreLogger.debug({ err, role: agentRole }, 'specialist memory injection skipped (non-fatal)');
    }
  }

  // Workers must return results to the orchestrator, not message the user directly
  systemPrompt += `\n\nIMPORTANT: You are a worker agent. Return your findings and results as plain text in your final response. Do NOT use messaging tools (send_to_user, send_channel_message) to contact the user — the orchestrator handles all user communication. Just do your task and respond with the result.`;

  // Inform agents about Octipus MCP server tools.
  // CLI agents (Claude Code, Gemini, Codex) use tool names directly (octipus_*).
  // LLM agents use meta-tools: mcp_call_tool(server_id: "octipus", tool_name: "...", arguments: {...})
  const isCLIModel = finalModel?.startsWith('cli/');
  if (isCLIModel) {
    systemPrompt += `\n\nOCTIPUS MCP TOOLS: You have access to the "octipus" MCP server which provides tools for:
- **People & profiles**: Search/retrieve stored information about people the user knows (octipus_search_profiles, octipus_get_profile)
- **Knowledge base**: Search the user's knowledge base (octipus_search_knowledge)
- **Web search**: Search the web (octipus_search) and fetch pages (octipus_fetch_page)
- **Messaging**: Send messages to the user's channels — Telegram, Slack, etc. (octipus_send_channel_message)
- **Scheduling**: Create/manage scheduled tasks and automations (octipus_create_recurring_task)
- **Documents**: Upload and index documents (octipus_upload_document)
Use these MCP tools when the task benefits from them — especially for people-related questions, knowledge lookups, or cross-channel messaging.`;
  } else {
    systemPrompt += `\n\nEXTERNAL TOOLS VIA MCP: You can access external tools from the "octipus" MCP server.
To use them, first call mcp_list_tools() to discover available tools and their parameters.
Then call mcp_call_tool(server_id: "octipus", tool_name: "<tool>", arguments: {...}) to invoke one.
Available capabilities: people/profiles, knowledge base, web search, messaging (Telegram/Slack), scheduling, documents.
Use these when the task benefits from them — especially for people-related questions, knowledge lookups, or cross-channel messaging.`;
  }

  const worker = await agentManager.spawn({
    sessionId: context.sessionId,
    userId: context.userId,
    workspaceId: context.workspaceId ?? null,
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
        workspaceId: context.workspaceId ?? null,
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
          workspaceId: context.workspaceId ?? null,
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
    const summaryPath = resolve(root, '.octipus/project-summary.md');
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
